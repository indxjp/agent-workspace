import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArchiveTooLargeError,
  ArchiveValidationError,
  encodeUstarStream,
  extractUstarStream,
  readStream,
  type StreamTarEntry,
} from './transfer.js';
import { fileEntry, chunked, forge, smallArchive } from './transfer.stream.test-support.js';

describe('streamed archive validation', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-stream-refuse-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('[US-STO-06][unit][run] a stream split at any size extracts the same files', async () => {
    const archive = await readStream(
      encodeUstarStream(
        [fileEntry('d/a.txt', Buffer.from('hello')), fileEntry('b', Buffer.alloc(700, 7))],
        {
          maxBytes: 1024,
        },
      ),
    );
    for (const size of [1, 7, 511, 512, 513, 100_000]) {
      const target = path.join(root, `split-${String(size)}`);
      await extractUstarStream(chunked(archive, size), target, { maxBytes: 1024 });
      expect(await readFile(path.join(target, 'd', 'a.txt'), 'utf8')).toBe('hello');
      expect((await readFile(path.join(target, 'b'))).byteLength).toBe(700);
    }
  });

  it.each([
    ['hard link', 0x31],
    ['symlink', 0x32],
  ])('[US-STO-06][unit][run] refuses a %s member', async (_name, type) => {
    const forged = forge(smallArchive, (header) => {
      header[156] = type;
    });
    await expect(
      extractUstarStream(chunked(forged, 4096), root, { maxBytes: 1024 }),
    ).rejects.toThrow(/unsupported ustar member type/u);
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['../escape.txt', '/etc/escape.txt'])(
    '[US-STO-06][unit][run] refuses the path %s outside the root',
    async (name) => {
      const forged = forge(smallArchive, (header) => {
        header.fill(0, 0, 100);
        header.write(name, 0, 'utf8');
      });
      await expect(
        extractUstarStream(chunked(forged, 4096), path.join(root, 'out'), { maxBytes: 1024 }),
      ).rejects.toBeInstanceOf(ArchiveValidationError);
      // The header is refused as it parses, so not even the workspace is created.
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('[US-STO-06][unit][run] refuses a bad header checksum', async () => {
    const forged = forge(
      smallArchive,
      (header) => {
        header[0] = header[0] === 0x61 ? 0x62 : 0x61;
      },
      false,
    );
    await expect(
      extractUstarStream(chunked(forged, 4096), root, { maxBytes: 1024 }),
    ).rejects.toThrow(/checksum/u);
  });

  it('[US-STO-06][unit][run] refuses an archive over the cap before sending a byte', async () => {
    const entries = [fileEntry('a', Buffer.alloc(3)), fileEntry('b', Buffer.alloc(3))];
    expect(() => encodeUstarStream(entries, { maxBytes: 5 })).toThrow(ArchiveTooLargeError);
    async function* source(): AsyncGenerator<StreamTarEntry> {
      await Promise.resolve();
      yield* entries;
    }
    const reader = encodeUstarStream(source(), { maxBytes: 5 }).getReader();
    await expect(reader.read()).rejects.toBeInstanceOf(ArchiveTooLargeError);
    expect((await readStream(encodeUstarStream(entries, { maxBytes: 6 }))).byteLength).toBe(
      512 * 2 + 512 * 2 + 1024,
    );
  });

  it('[US-STO-12][unit][run] reports the SHA-256 of each file read to its declared size', async () => {
    const digests = new Map<string, string>();
    const onEntryDigest = (name: string, sha256: string) => digests.set(name, sha256);
    await readStream(
      encodeUstarStream([fileEntry('a', Buffer.from('one')), fileEntry('b', Buffer.alloc(0))], {
        maxBytes: 8,
        onEntryDigest,
      }),
    );
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(Object.fromEntries(digests)).toEqual({ a: sha('one'), b: sha('') });

    digests.clear();
    const liar: StreamTarEntry = {
      path: 'c',
      type: 'file',
      mode: 0o644,
      size: 5,
      open: () => Promise.resolve(new Blob(['abc']).stream()),
    };
    await expect(
      readStream(encodeUstarStream([liar], { maxBytes: 8, onEntryDigest })),
    ).rejects.toBeInstanceOf(ArchiveValidationError);
    expect(digests.size).toBe(0);
  });

  it('[US-STO-06][unit][run] refuses an archive over the cap when extracting', async () => {
    const archive = await readStream(
      encodeUstarStream([fileEntry('a', Buffer.alloc(4)), fileEntry('b', Buffer.alloc(4))], {
        maxBytes: 8,
      }),
    );
    await expect(
      extractUstarStream(chunked(archive, 1000), root, { maxBytes: 6 }),
    ).rejects.toBeInstanceOf(ArchiveTooLargeError);
    expect(await readdir(root)).toEqual([]);
  });

  it('[US-STO-06][unit][run] refuses a headers-only archive over the member cap', async () => {
    const empty = ['a', 'b', 'c', 'd'].map((name) => fileEntry(name, Buffer.alloc(0)));
    const archive = await readStream(encodeUstarStream(empty, { maxBytes: 0 }));
    await expect(
      extractUstarStream(chunked(archive, 1000), root, { maxBytes: 0, maxMembers: 3 }),
    ).rejects.toBeInstanceOf(ArchiveTooLargeError);
    expect(await readdir(root)).toEqual([]);
  });

  it('[US-STO-06][unit][run] counts a forged directory body toward the cap', async () => {
    const forged = forge(smallArchive, (header) => {
      header[156] = 0x35;
      header.write('77777777777\0', 124, 'latin1');
    });
    await expect(
      extractUstarStream(chunked(forged, 4096), root, { maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(ArchiveTooLargeError);
    expect(await readdir(root)).toEqual([]);
  });

  it('[US-STO-06][unit][run] releases the body after the terminator', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(smallArchive);
      },
      cancel() {
        cancelled = true;
      },
    });
    await extractUstarStream(body, path.join(root, 'out'), { maxBytes: 1024 });
    expect(cancelled).toBe(true);
  });

  it('[US-STO-06][unit][run] refuses a stream that ends inside a member', async () => {
    const cut = smallArchive.subarray(0, 512 + 2);
    await expect(extractUstarStream(chunked(cut, 100), root, { maxBytes: 1024 })).rejects.toThrow(
      /truncated ustar member a\.txt/u,
    );
    const unterminated = smallArchive.subarray(0, 1024);
    await expect(
      extractUstarStream(chunked(unterminated, 100), root, { maxBytes: 1024 }),
    ).rejects.toThrow(/zero-block terminator/u);
  });
});
