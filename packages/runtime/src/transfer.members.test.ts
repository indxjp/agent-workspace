import { describe, expect, it } from 'vitest';
import {
  ArchiveTooLargeError,
  ArchiveValidationError,
  encodeUstar,
  readUstarStream,
} from './transfer.js';
import { chunked, forge, smallArchive } from './transfer.stream.test-support.js';

describe('reading a ustar stream member by member', () => {
  async function members(
    archive: ReadableStream<Uint8Array>,
    maxBytes = 1024,
    maxMembers?: number,
  ) {
    const seen: { path: string; text: string }[] = [];
    for await (const member of readUstarStream(archive, {
      maxBytes,
      ...(maxMembers === undefined ? {} : { maxMembers }),
    })) {
      const parts: Buffer[] = [];
      for await (const chunk of member.body) parts.push(Buffer.from(chunk));
      seen.push({ path: member.path, text: Buffer.concat(parts).toString() });
    }
    return seen;
  }

  const two = encodeUstar([
    { path: 'd', type: 'directory', mode: 0o755 },
    { path: 'd/a.txt', type: 'file', mode: 0o644, data: Buffer.from('hello') },
    { path: 'b', type: 'file', mode: 0o644, data: Buffer.alloc(700, 7) },
  ]);

  it('[US-STO-12][unit][run] a stream split at any size yields the same members', async () => {
    for (const size of [1, 7, 511, 512, 513, 100_000]) {
      const seen = await members(chunked(two, size));
      expect(seen.map(({ path: name, text }) => [name, text.length])).toEqual([
        ['d', 0],
        ['d/a.txt', 5],
        ['b', 700],
      ]);
    }
  });

  it('[US-STO-12][unit][run] a member left unread or abandoned part-way does not break the next', async () => {
    const seen: string[] = [];
    for await (const member of readUstarStream(chunked(two, 100), { maxBytes: 1024 })) {
      if (member.path === 'd/a.txt') {
        for await (const chunk of member.body) {
          void chunk;
          break;
        }
      }
      seen.push(member.path);
    }
    expect(seen).toEqual(['d', 'd/a.txt', 'b']);
  });

  it.each([
    ['hard link', 0x31],
    ['symlink', 0x32],
  ])('[US-STO-12][unit][run] refuses a %s member', async (_name, type) => {
    const forged = forge(smallArchive, (header) => {
      header[156] = type;
    });
    await expect(members(chunked(forged, 4096))).rejects.toBeInstanceOf(ArchiveValidationError);
  });

  it('[US-STO-12][unit][run] refuses an archive over the byte or member cap before the member is yielded', async () => {
    await expect(members(chunked(two, 4096), 100)).rejects.toBeInstanceOf(ArchiveTooLargeError);
    await expect(members(chunked(two, 4096), 1024, 2)).rejects.toBeInstanceOf(ArchiveTooLargeError);
  });

  it('[US-STO-12][unit][run] refuses an archive cut short', async () => {
    await expect(members(chunked(two.subarray(0, 1100), 4096))).rejects.toBeInstanceOf(
      ArchiveValidationError,
    );
  });
});
