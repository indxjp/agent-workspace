/** Small stream and paging helpers shared by the backends. Node built-ins only. */
import { Readable } from 'node:stream';

import { toObjectPrefix } from './key-safety.js';
import {
  RangeNotSatisfiableError,
  assertRangeShape,
  clampListLimit,
  compareEntryKeys,
  type ByteRange,
  type ListPageOptions,
  type ObjectContent,
  type ObjectListEntry,
  type ObjectPage,
  type ObjectStore,
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

/** The whole object at `key` with its meta, or `null` if there is none. Small bodies only. */
export async function readWhole(
  store: Pick<ObjectStore, 'read'>,
  key: string,
): Promise<ObjectContent | null> {
  const found = await store.read(key);
  if (found === null) return null;
  const body = await streamToBytes(found.body);
  const { contentType, lastModified } = found.meta;
  return { body, contentType, sizeBytes: body.byteLength, lastModified };
}

/**
 * Every entry of a listing, every page read, sorted by key: one level with folders, or every file
 * strictly beneath `prefix` (`recursive`).
 */
export async function listAll(
  store: Pick<ObjectStore, 'listPage'>,
  prefix: string,
  options: { readonly recursive?: boolean } = {},
): Promise<ObjectListEntry[]> {
  const entries: ObjectListEntry[] = [];
  let cursor: string | null = null;
  do {
    const page: ObjectPage = await store.listPage(prefix, {
      ...options,
      ...(cursor === null ? {} : { cursor }),
    });
    entries.push(...page.entries);
    cursor = page.cursor;
  } while (cursor !== null);
  return entries.sort(compareEntryKeys);
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

/** Where a `<kind>:<key>` cursor resumes; a cursor without a kind resumes after every entry before its key. */
function cursorPosition(cursor: string): { readonly key: string; readonly kind: string } {
  const sep = cursor.indexOf(':');
  return { kind: cursor.slice(0, Math.max(sep, 0)), key: cursor.slice(sep + 1) };
}

/**
 * Entries a backend lists in one call. An array may be in any order; an async iterable yields in
 * key-then-kind order and may skip every entry whose key is below `after`, so a page walks only
 * from its cursor on and stops once it is full.
 */
type ListedEntries = Promise<readonly ObjectListEntry[]> | AsyncIterable<ObjectListEntry>;

/**
 * `listPage` for a backend with no native paging (memory, local filesystem, folder) that lists a
 * whole level (`level`) or tree (`tree`) in one call. The cursor is `<kind>:<key>` of the last entry
 * returned, so a page ending on a file does not skip the folder of the same name.
 */
export async function listPageFrom(
  listing: {
    level(prefix: string, after: string | undefined): ListedEntries;
    tree(prefix: string, after: string | undefined): ListedEntries;
  },
  prefix: string,
  options: ListPageOptions | undefined,
): Promise<ObjectPage> {
  options?.signal?.throwIfAborted();
  const limit = clampListLimit(options?.limit);
  const after = options?.cursor === undefined ? undefined : cursorPosition(options.cursor);
  const recursive = options?.recursive === true;
  // Strictly beneath the prefix: a file named exactly `prefix` is not "under" it.
  const self = recursive ? toObjectPrefix(prefix) : undefined;
  const listed = recursive ? listing.tree(prefix, after?.key) : listing.level(prefix, after?.key);
  const ordered =
    Symbol.asyncIterator in listed
      ? listed
      : [...(await listed)].sort((left, right) =>
          compareKeyKind(left.key, left.kind, right.key, right.kind),
        );
  const entries: ObjectListEntry[] = [];
  for await (const entry of ordered) {
    if (entry.key === self) continue;
    if (after !== undefined && compareKeyKind(entry.key, entry.kind, after.key, after.kind) <= 0) {
      continue;
    }
    if (entries.length === limit) {
      const last = entries[limit - 1];
      return { entries, cursor: last === undefined ? null : `${last.kind}:${last.key}` };
    }
    entries.push(entry);
  }
  return { entries, cursor: null };
}

/**
 * Whether every key beneath the folder `key` sorts before `after`, so a walk resuming at `after`
 * need not enter it. A folder's keys all start `key/`.
 */
export function walkedBefore(key: string, after: string | undefined): boolean {
  return after !== undefined && after > `${key}/` && !after.startsWith(`${key}/`);
}

/** Directory entries in the order their keys sort: a folder's name compares as `name/`. */
export function inWalkOrder<T extends { readonly name: string }>(
  entries: readonly T[],
  isFolder: (entry: T) => boolean,
): T[] {
  const sortKey = (entry: T): string => (isFolder(entry) ? `${entry.name}/` : entry.name);
  return [...entries].sort((left, right) => {
    const a = sortKey(left);
    const b = sortKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
