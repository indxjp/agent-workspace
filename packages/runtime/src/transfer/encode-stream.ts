import { createHash } from 'node:crypto';
import {
  ZERO_TRAILER,
  type StreamTarEntry,
  ArchiveValidationError,
  ArchiveTooLargeError,
} from './model.js';
import { headerFor, paddedLength } from './ustar.js';

type PreparedMember = Readonly<{ entry: StreamTarEntry; header: Buffer }>;

/** Build every header and sum the declared sizes, so a bad name or a total over the cap fails first. */
function prepareMembers(entries: readonly StreamTarEntry[], maxBytes: number): PreparedMember[] {
  let total = 0;
  const members = entries.map((entry): PreparedMember => {
    if (entry.type === 'file') {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new ArchiveValidationError(`invalid size for archive member ${entry.path}`);
      }
      total += entry.size;
    }
    return { entry, header: headerFor(entry, entry.type === 'file' ? entry.size : 0) };
  });
  if (total > maxBytes) {
    throw new ArchiveTooLargeError(`the archived files exceed ${String(maxBytes)} bytes.`);
  }
  return members;
}

/**
 * Stream a ustar archive, pulling one file at a time: memory is one chunk plus one header (the
 * storage design, §04 "Giving files to a run"). `maxBytes` caps the sum of declared file sizes; an
 * array source throws `ArchiveTooLargeError` before any byte, an async source errors the stream
 * before its first chunk. A file whose bytes differ from its declared size errors the stream.
 */
// @story US-STO-06
export function encodeUstarStream(
  entries: AsyncIterable<StreamTarEntry> | Iterable<StreamTarEntry>,
  options: {
    readonly maxBytes: number;
    /** Called with a file member's SHA-256 once its bytes ended at exactly its declared size. */
    readonly onEntryDigest?: (path: string, sha256: string) => void;
  },
): ReadableStream<Uint8Array> {
  const isAsync = Symbol.asyncIterator in entries;
  let members: PreparedMember[] = isAsync ? [] : prepareMembers([...entries], options.maxBytes);
  let index = 0;
  let open: { reader: ReadableStreamDefaultReader<Uint8Array>; member: PreparedMember } | null =
    null;
  let seen = 0;
  let hash = createHash('sha256');
  // Set by `cancel`, which can arrive while a file's `open()` is still pending.
  let cancelled: { readonly reason: unknown } | null = null;

  async function closeOpen(reason?: unknown): Promise<void> {
    const current = open;
    open = null;
    await current?.reader.cancel(reason).catch(() => undefined);
  }

  async function emitFileChunk(
    current: NonNullable<typeof open>,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<boolean> {
    const { member, reader } = current;
    const size = member.entry.type === 'file' ? member.entry.size : 0;
    const { done, value } = await reader.read();
    if (done) {
      open = null;
      if (seen !== size) {
        throw new ArchiveValidationError(`${member.entry.path} changed size while streaming`);
      }
      options.onEntryDigest?.(member.entry.path, hash.digest('hex'));
      const padding = paddedLength(size) - size;
      if (padding > 0) controller.enqueue(Buffer.alloc(padding));
      else return false;
      return true;
    }
    seen += value.byteLength;
    if (seen > size) {
      throw new ArchiveValidationError(`${member.entry.path} changed size while streaming`);
    }
    hash.update(value);
    controller.enqueue(value);
    return true;
  }

  return new ReadableStream<Uint8Array>(
    {
      async start() {
        if (!isAsync) return;
        const collected: StreamTarEntry[] = [];
        for await (const entry of entries) collected.push(entry);
        members = prepareMembers(collected, options.maxBytes);
      },
      async pull(controller) {
        try {
          for (;;) {
            if (open === null) {
              const member = members[index];
              index += 1;
              if (member === undefined) {
                controller.enqueue(Buffer.alloc(ZERO_TRAILER));
                controller.close();
                return;
              }
              controller.enqueue(member.header);
              // An empty file is opened too, so its EOF proves it is still empty.
              if (member.entry.type === 'file') {
                seen = 0;
                hash = createHash('sha256');
                open = { reader: (await member.entry.open()).getReader(), member };
                // The source arrived after `cancel` ran: nothing else will cancel it.
                if (cancelled !== null) await closeOpen(cancelled.reason);
                return;
              }
              continue;
            }
            if (await emitFileChunk(open, controller)) return;
          }
        } catch (error) {
          await closeOpen(error);
          throw error;
        }
      },
      async cancel(reason) {
        cancelled = { reason };
        await closeOpen(reason);
      },
    },
    // Pull only on demand: the default high-water mark opens the first file at construction,
    // before the consumer reads, so a change made in between would escape the size check.
    { highWaterMark: 0 },
  );
}
