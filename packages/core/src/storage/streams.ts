/** Small stream and paging helpers shared by the backends. Node built-ins only. */
import { Readable } from 'node:stream';

import { toObjectPrefix } from './key-safety.js';
import {
  RangeNotSatisfiableError,
  assertRangeShape,
  clampListLimit,
  type ByteRange,
  type ListPageOptions,
  type ObjectListEntry,
  type ObjectPage,
  type ObjectStoreV2,
} from './object-store.js';

export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Collect a stream into one buffer. For tests and small bodies only. */
export async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    chunks.push(Buffer.from(value));
  }
}

/**
 * Collect a stream into one buffer of at most `maxBytes`. A stream that goes past the cap is
 * cancelled and answers `null`, so a body larger than its row claimed is never held whole.
 */
export async function readBytes(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    // A rejected read leaves the stream errored, so releasing the lock is all that is left to do.
    reader.releaseLock();
  }
}

/** `body` passed through as it is read, and how many bytes have gone through so far. */
export function countedBody(body: ReadableStream<Uint8Array> | Uint8Array): {
  readonly body: ReadableStream<Uint8Array> | Uint8Array;
  readonly sizeBytes: () => number;
} {
  if (body instanceof Uint8Array) return { body, sizeBytes: () => body.byteLength };
  let size = 0;
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  return { body: counted, sizeBytes: () => size };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * A node `Readable` over a write body, so SDKs that want node streams never see a web stream.
 * Destroying it (a failed write, a precondition conflict, an early error) cancels the source.
 */
export function toNodeReadable(body: ReadableStream<Uint8Array> | Uint8Array): Readable {
  if (body instanceof Uint8Array) return Readable.from([body], { objectMode: false });
  const reader = body.getReader();
  return new Readable({
    read() {
      reader.read().then(
        (next) => {
          this.push(next.done ? null : next.value);
        },
        (error: unknown) => {
          this.destroy(asError(error));
        },
      );
    },
    destroy(error, callback) {
      reader.cancel(error ?? new Error('The write was aborted.')).then(
        () => {
          callback(error);
        },
        (cancelError: unknown) => {
          callback(error ?? asError(cancelError));
        },
      );
    },
  });
}

/**
 * A web stream over a node `Readable`, read one chunk per pull. (`Readable.toWeb` reads ahead and
 * holds about 64 MiB of a large object; this does not.) The source must be a byte-mode `Readable`
 * with no `setEncoding`; any other chunk errors the stream.
 */
export function toWebStream(source: Readable): ReadableStream<Uint8Array> {
  const chunks: AsyncIterator<unknown> = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await chunks.next();
        if (next.done === true) controller.close();
        else if (next.value instanceof Uint8Array) controller.enqueue(next.value);
        else {
          const error = new TypeError('toWebStream expects a byte-mode Readable.');
          controller.error(error);
          source.destroy(error);
        }
      },
      cancel(reason) {
        source.destroy(reason instanceof Error ? reason : undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * The inclusive range actually served for an object of `size` bytes (`end` clamped to the last
 * byte); `null` for the whole object. A malformed range, or one starting at or past the end of the
 * object (any range on an empty one), throws {@link RangeNotSatisfiableError} on every backend.
 */
export function resolveRange(
  range: ByteRange | undefined,
  size: number,
): { readonly start: number; readonly end: number } | null {
  if (range === undefined) return null;
  assertRangeShape(range);
  if (range.start >= size) {
    throw new RangeNotSatisfiableError(
      `The range starts at ${range.start}; the object has ${size} bytes.`,
    );
  }
  return { start: range.start, end: Math.min(range.end ?? size - 1, size - 1) };
}

/** Key order, then `file` before `folder`: a file and a folder can share a key in a one-level list. */
function compareKeyKind(
  leftKey: string,
  leftKind: string,
  rightKey: string,
  rightKind: string,
): number {
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  return leftKind < rightKind ? -1 : leftKind > rightKind ? 1 : 0;
}

/**
 * Page an already complete, key-sorted listing. For backends with no native paging (memory, local
 * filesystem). The cursor is `<kind>:<key>` of the last entry returned, so a page ending on a file
 * does not skip the folder of the same name.
 */
function pageEntries(
  sorted: readonly ObjectListEntry[],
  options: ListPageOptions | undefined,
): ObjectPage {
  const limit = clampListLimit(options?.limit);
  const ordered = [...sorted].sort((left, right) =>
    compareKeyKind(left.key, left.kind, right.key, right.kind),
  );
  const after = options?.cursor;
  let rest: readonly ObjectListEntry[] = ordered;
  if (after !== undefined) {
    // A cursor without a kind resumes after every entry before its key.
    const sep = after.indexOf(':');
    const afterKind = after.slice(0, Math.max(sep, 0));
    const afterKey = after.slice(sep + 1);
    rest = ordered.filter(
      (entry) => compareKeyKind(entry.key, entry.kind, afterKey, afterKind) > 0,
    );
  }
  const entries = rest.slice(0, limit);
  const last = entries[entries.length - 1];
  return {
    entries,
    cursor: rest.length > limit && last !== undefined ? `${last.kind}:${last.key}` : null,
  };
}

/** `listPage` for a backend whose array-returning `list`/`listPrefix` already work. */
export async function listPageFrom(
  store: Pick<ObjectStoreV2, 'list' | 'listPrefix'>,
  prefix: string,
  options: ListPageOptions | undefined,
): Promise<ObjectPage> {
  options?.signal?.throwIfAborted();
  if (options?.recursive !== true) return pageEntries(await store.list(prefix), options);
  // Strictly beneath the prefix: a file named exactly `prefix` is not "under" it.
  const self = toObjectPrefix(prefix);
  const beneath = (await store.listPrefix(prefix)).filter((entry) => entry.key !== self);
  return pageEntries(beneath, options);
}
