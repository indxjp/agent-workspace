// @story US-STO-06
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generatedBody, MiB, peakRssGrowth } from '../../../tests/load/flat-memory.js';
import {
  archiveWorkspacePaths,
  ArchiveTooLargeError,
  ArchiveValidationError,
  encodeUstar,
  encodeUstarStream,
  extractUstarStream,
  readStream,
  readUstarStream,
  RUN_FILES_MAX_ARCHIVE_BYTES,
  RUN_FILES_MAX_BYTES,
  type StreamTarEntry,
} from './transfer.js';

const RSS_BOUND = 64 * MiB;
const FILES = 4;
const FILE_BYTES = RUN_FILES_MAX_BYTES / FILES;

async function sha256OfFile(file: string): Promise<{ bytes: number; digest: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { bytes, digest: hash.digest('hex') };
}

function fileEntry(name: string, content: Uint8Array, size = content.byteLength): StreamTarEntry {
  return {
    path: name,
    type: 'file',
    mode: 0o644,
    size,
    open: () =>
      Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(content);
            controller.close();
          },
        }),
      ),
  };
}

function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) controller.close();
      else controller.enqueue(bytes.slice(offset, (offset += size)));
    },
  });
}

/** Edit the first header of an archive and re-sign it, unless `sign` is false. */
function forge(archive: Uint8Array, edit: (header: Buffer) => void, sign = true): Uint8Array {
  const copy = Buffer.from(archive);
  const header = copy.subarray(0, 512);
  edit(header);
  if (sign) {
    header.fill(0x20, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  }
  return copy;
}

const smallArchive = encodeUstar([
  { path: 'a.txt', type: 'file', mode: 0o644, data: Buffer.from('hello') },
]);

describe('streaming ustar codec', () => {
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

  it('[US-STO-06][unit][run] a second hydrate writes into a cwd a read grant left read-only', async () => {
    const archive = (text: string) =>
      encodeUstarStream([fileEntry('kb/sub/a.txt', Buffer.from(text))], { maxBytes: 1024 });
    await extractUstarStream(archive('first'), root, { maxBytes: 1024 });
    // The runner's mode pass for a read folder grant `kb`: files 0o444, directories 0o555.
    await chmod(path.join(root, 'kb', 'sub', 'a.txt'), 0o444);
    await chmod(path.join(root, 'kb', 'sub'), 0o555);
    await chmod(path.join(root, 'kb'), 0o555);
    await extractUstarStream(archive('second'), root, { maxBytes: 1024 });
    expect(await readFile(path.join(root, 'kb', 'sub', 'a.txt'), 'utf8')).toBe('second');
  });

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

  it('[US-STO-06][unit][run] a refused hydrate keeps every file it would have overwritten', async () => {
    await writeFile(path.join(root, 'a'), 'old');
    const archive = await readStream(
      encodeUstarStream(
        [
          fileEntry('a', Buffer.from('new')),
          fileEntry('d/b', Buffer.from('two')),
          fileEntry('c', Buffer.alloc(8)),
        ],
        { maxBytes: 16 },
      ),
    );
    await expect(
      extractUstarStream(chunked(archive, 1000), root, { maxBytes: 10 }),
    ).rejects.toBeInstanceOf(ArchiveTooLargeError);
    expect(await readdir(root)).toEqual(['a']);
    expect(await readFile(path.join(root, 'a'), 'utf8')).toBe('old');
  });

  it('[US-STO-06][unit][run] a refused hydrate removes the workspace it created', async () => {
    const workspace = path.join(root, 'ws');
    const archive = await readStream(
      encodeUstarStream([fileEntry('a', Buffer.alloc(4)), fileEntry('b', Buffer.alloc(4))], {
        maxBytes: 8,
      }),
    );
    await expect(
      extractUstarStream(chunked(archive, 1000), workspace, { maxBytes: 6 }),
    ).rejects.toBeInstanceOf(ArchiveTooLargeError);
    expect(await readdir(root)).toEqual([]);
  });

  it('[US-STO-06][unit][run] a member refused against the workspace undoes the members before it', async () => {
    await writeFile(path.join(root, 'a'), 'old');
    // A directory where the archive puts a file is refused only when the member meets the workspace.
    await mkdir(path.join(root, 'z'));
    const archive = await readStream(
      encodeUstarStream(
        [
          fileEntry('a', Buffer.from('new')),
          fileEntry('n/fresh', Buffer.from('fresh')),
          fileEntry('z', Buffer.from('file')),
        ],
        { maxBytes: 64 },
      ),
    );
    await expect(
      extractUstarStream(chunked(archive, 1000), root, { maxBytes: 64 }),
    ).rejects.toThrow(/not a regular file/u);
    expect((await readdir(root)).sort()).toEqual(['a', 'z']);
    expect(await readFile(path.join(root, 'a'), 'utf8')).toBe('old');
    expect(await readdir(path.join(root, 'z'))).toEqual([]);
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

  it('[US-STO-06][unit][run] refuses a workspace file swapped for a symlink', async () => {
    const workspace = path.join(root, 'ws');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'a.txt'), 'first');
    await writeFile(path.join(workspace, 'b.txt'), 'hello');
    await writeFile(path.join(root, 'host.txt'), 'HOST!');
    const archive = await archiveWorkspacePaths(workspace, ['a.txt', 'b.txt']);
    // The encoder may open the first member right away; b.txt is opened only once a.txt is read.
    await rm(path.join(workspace, 'b.txt'));
    await symlink(path.join(root, 'host.txt'), path.join(workspace, 'b.txt'));
    await expect(readStream(archive)).rejects.toThrow(
      /workspace entry changed while streaming: b\.txt/u,
    );
  });

  it('[US-STO-06][unit][run] refuses a workspace file that grows while streaming', async () => {
    await writeFile(path.join(root, 'a.txt'), 'hello');
    const archive = await archiveWorkspacePaths(root, ['a.txt']);
    await appendFile(path.join(root, 'a.txt'), ' world');
    await expect(readStream(archive)).rejects.toThrow(/a\.txt changed size while streaming/u);
  });

  it.each([
    ['fewer', 3],
    ['more', 9],
  ])(
    '[US-STO-06][unit][run] refuses a file that changed size (%s bytes)',
    async (_name, actual) => {
      const entry = fileEntry('a', Buffer.alloc(actual), 6);
      await expect(readStream(encodeUstarStream([entry], { maxBytes: 6 }))).rejects.toThrow(
        /a changed size while streaming/u,
      );
    },
  );

  it('[US-STO-06][unit][run] a full payload archive fits the /files wire bound', async () => {
    const entry: StreamTarEntry = {
      path: 'big.bin',
      type: 'file',
      mode: 0o644,
      size: RUN_FILES_MAX_BYTES,
      open: () => Promise.resolve(chunked(new Uint8Array(RUN_FILES_MAX_BYTES), MiB)),
    };
    let wireBytes = 0;
    const archive = encodeUstarStream([entry], { maxBytes: RUN_FILES_MAX_BYTES });
    for await (const chunk of archive as AsyncIterable<Uint8Array>) wireBytes += chunk.byteLength;
    expect(wireBytes).toBe(134_219_264);
    expect(wireBytes).toBeGreaterThan(RUN_FILES_MAX_BYTES);
    expect(wireBytes).toBeLessThanOrEqual(RUN_FILES_MAX_ARCHIVE_BYTES);
  });

  it('[US-STO-06][unit][run] refuses a file declared empty that has bytes', async () => {
    const entry = fileEntry('a', Buffer.alloc(3), 0);
    await expect(readStream(encodeUstarStream([entry], { maxBytes: 6 }))).rejects.toThrow(
      /a changed size while streaming/u,
    );
  });

  it('[US-STO-06][unit][run] refuses an empty workspace file that grows while streaming', async () => {
    await writeFile(path.join(root, 'a.txt'), '');
    const archive = await archiveWorkspacePaths(root, ['a.txt']);
    await appendFile(path.join(root, 'a.txt'), 'grown');
    await expect(readStream(archive)).rejects.toThrow(/a\.txt changed size while streaming/u);
  });

  it('[US-STO-06][unit][run] opens no file before the consumer reads', async () => {
    let opens = 0;
    const entry: StreamTarEntry = {
      path: 'a',
      type: 'file',
      mode: 0o644,
      size: 0,
      open: () => {
        opens += 1;
        return Promise.resolve(chunked(new Uint8Array(0), 1));
      },
    };
    const archive = encodeUstarStream([entry], { maxBytes: 6 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(opens).toBe(0);
    await readStream(archive);
    expect(opens).toBe(1);
  });

  it('[US-STO-06][unit][run] cancels a source whose open() resolves after the archive was cancelled', async () => {
    let release: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reasons: unknown[] = [];
    const late = new ReadableStream<Uint8Array>({
      cancel(reason) {
        reasons.push(reason);
      },
    });
    const archive = encodeUstarStream(
      [
        {
          path: 'a',
          type: 'file',
          mode: 0o644,
          size: 1,
          open: async () => {
            await opened;
            return late;
          },
        },
      ],
      { maxBytes: 1 },
    );
    const reader = archive.getReader();
    await reader.read(); // the header; the next pull awaits open()
    const pending = reader.read();
    const cancelled = reader.cancel('stop');
    release();
    await cancelled;
    await pending.catch(() => undefined);
    await vi.waitFor(() => {
      expect(reasons).toEqual(['stop']);
    });
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

  it('[US-STO-06][unit][run] refuses a non-archive body before touching the disk', async () => {
    const blocker = path.join(root, 'blocker');
    await writeFile(blocker, 'a file where the workspace directory should be');
    await expect(
      extractUstarStream(chunked(Buffer.alloc(0), 1), path.join(blocker, 'ws'), { maxBytes: 1 }),
    ).rejects.toBeInstanceOf(ArchiveValidationError);
  });

  it('[US-STO-06][unit][run] creates no workspace for a header block that does not parse', async () => {
    const workspace = path.join(root, 'ws');
    await expect(
      extractUstarStream(chunked(Buffer.alloc(1024, 0xff), 100), workspace, { maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(ArchiveValidationError);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('[US-STO-06][unit][run] an empty archive creates the workspace', async () => {
    const workspace = path.join(root, 'ws');
    await expect(
      extractUstarStream(chunked(Buffer.alloc(1024), 100), workspace, { maxBytes: 1 }),
    ).resolves.toEqual([]);
    await expect(readdir(workspace)).resolves.toEqual([]);
  });

  it('[US-STO-06][unit][run] refuses to write through an existing symlink', async () => {
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'keep');
    await symlink(outside, path.join(root, 'a.txt'));
    await expect(
      extractUstarStream(chunked(smallArchive, 4096), root, { maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(ArchiveValidationError);
    expect(await readFile(outside, 'utf8')).toBe('keep');
  });

  it(
    '[US-STO-06][unit][run] a 128 MiB archive round-trips with flat memory',
    { timeout: 120_000 },
    async () => {
      // One small round trip first, so the file and stream machinery is loaded before the baseline.
      const warm = generatedBody(MiB);
      await extractUstarStream(
        encodeUstarStream(
          [
            {
              path: 'warm.bin',
              type: 'file',
              mode: 0o644,
              size: MiB,
              open: () => Promise.resolve(warm.body),
            },
          ],
          { maxBytes: MiB },
        ),
        path.join(root, 'warm'),
        { maxBytes: MiB },
      );

      const digests: Promise<string>[] = [];
      const entries: StreamTarEntry[] = Array.from({ length: FILES }, (_, index) => ({
        path: `file-${String(index)}.bin`,
        type: 'file',
        mode: 0o644,
        size: FILE_BYTES,
        open: () => {
          const { body, sha256 } = generatedBody(FILE_BYTES);
          digests.push(sha256);
          return Promise.resolve(body);
        },
      }));

      let sent = 0;
      const target = path.join(root, 'out');
      const growth = await peakRssGrowth(async (sample) => {
        const archive = encodeUstarStream(entries, { maxBytes: RUN_FILES_MAX_BYTES }).pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              const before = sent;
              sent += chunk.byteLength;
              // Collect at least every 4 MiB so uncollected chunk garbage is not counted.
              if (Math.floor(sent / (4 * MiB)) > Math.floor(before / (4 * MiB))) sample();
              controller.enqueue(chunk);
            },
          }),
        );
        const written = await extractUstarStream(archive, target, {
          maxBytes: RUN_FILES_MAX_BYTES,
        });
        expect(written).toHaveLength(FILES);
      });

      expect(growth).toBeLessThan(RSS_BOUND);
      const expected = await Promise.all(digests);
      for (let index = 0; index < FILES; index += 1) {
        const actual = await sha256OfFile(path.join(target, `file-${String(index)}.bin`));
        expect(actual.bytes).toBe(FILE_BYTES);
        expect(actual.digest).toBe(expected[index]);
      }
    },
  );
});

// @story US-STO-12
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
