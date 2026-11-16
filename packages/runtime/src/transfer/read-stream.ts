import { BLOCK, ArchiveValidationError, ArchiveTooLargeError } from './model.js';
import { paddedLength, parseHeader } from './ustar.js';

export async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Reads a ustar stream block by block, holding at most the unconsumed rest of one chunk. */
export function ustarReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let pending: Uint8Array = new Uint8Array(0);

  async function fill(): Promise<boolean> {
    while (pending.byteLength === 0) {
      const { done, value } = await reader.read();
      if (done) return false;
      pending = value;
    }
    return true;
  }

  return {
    /** The next 512-byte header block, or null when the stream ends before a whole one. */
    async header(): Promise<Uint8Array | null> {
      if (!(await fill())) return null;
      if (pending.byteLength >= BLOCK) {
        const block = pending.subarray(0, BLOCK);
        pending = pending.subarray(BLOCK);
        return block;
      }
      const block = Buffer.alloc(BLOCK);
      for (let have = 0; have < BLOCK;) {
        if (!(await fill())) return null;
        const take = Math.min(BLOCK - have, pending.byteLength);
        block.set(pending.subarray(0, take), have);
        pending = pending.subarray(take);
        have += take;
      }
      return block;
    },
    /** The member body in chunks; its padding is consumed once the body is. */
    async *body(size: number, memberPath: string): AsyncGenerator<Uint8Array> {
      for (let left = size; left > 0;) {
        if (!(await fill())) {
          throw new ArchiveValidationError(`truncated ustar member ${memberPath}`);
        }
        const chunk = pending.subarray(0, left);
        pending = pending.subarray(chunk.byteLength);
        left -= chunk.byteLength;
        yield chunk;
      }
      for (let padding = paddedLength(size) - size; padding > 0;) {
        if (!(await fill())) {
          throw new ArchiveValidationError(`truncated ustar member ${memberPath}`);
        }
        const skipped = Math.min(padding, pending.byteLength);
        pending = pending.subarray(skipped);
        padding -= skipped;
      }
    },
    cancel: (): Promise<void> => reader.cancel().catch(() => undefined),
  };
}

/** One member of {@link readUstarStream}; `body` is the member's bytes in chunks, empty for a directory. */
export type UstarMember = Readonly<{
  path: string;
  type: 'file' | 'directory';
  mode: number;
  size: number;
  body: AsyncIterable<Uint8Array>;
}>;

/**
 * Read a ustar stream member by member without touching a disk: the checks of
 * {@link extractUstarStream} (link members, unsafe paths, bad checksums, `maxBytes`, `maxMembers`)
 * run before a member is yielded. A member's `body` may be left unread, or abandoned part-way: the
 * rest of it is skipped before the next header, so a consumer that fails on one file can go on.
 */
// @story US-STO-12
export async function* readUstarStream(
  archive: ReadableStream<Uint8Array>,
  options: { readonly maxBytes: number; readonly maxMembers?: number },
): AsyncGenerator<UstarMember> {
  const maxMembers = options.maxMembers ?? Number.POSITIVE_INFINITY;
  const source = ustarReader(archive);
  let skip: AsyncGenerator<Uint8Array> | null = null;
  let members = 0;
  let total = 0;
  try {
    for (;;) {
      if (skip !== null) for await (const rest of skip) void rest;
      const block = await nextHeader(source);
      if (block === null) return;
      members += 1;
      if (members > maxMembers) {
        throw new ArchiveTooLargeError(`the archive has more than ${String(maxMembers)} members.`);
      }
      const member = parseHeader(block);
      total += member.size;
      if (total > options.maxBytes) {
        throw new ArchiveTooLargeError(
          `the archived files exceed ${String(options.maxBytes)} bytes.`,
        );
      }
      const chunks = source.body(member.size, member.path);
      skip = chunks;
      // `return` is a no-op: abandoning the body must not finish the generator the reader shares.
      const body: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: () => chunks.next(),
          return: () => Promise.resolve({ done: true, value: undefined }),
        }),
      };
      yield { ...member, body };
    }
  } finally {
    await source.cancel();
  }
}

export async function nextHeader(
  source: ReturnType<typeof ustarReader>,
): Promise<Uint8Array | null> {
  const block = await source.header();
  if (block === null)
    throw new ArchiveValidationError('ustar archive has no zero-block terminator');
  return block.every((byte) => byte === 0) ? null : block;
}
