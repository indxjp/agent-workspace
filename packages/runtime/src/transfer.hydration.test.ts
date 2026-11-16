import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArchiveTooLargeError,
  ArchiveValidationError,
  encodeUstarStream,
  extractUstarStream,
  readStream,
} from './transfer.js';
import { fileEntry, chunked, smallArchive } from './transfer.stream.test-support.js';

describe('transactional workspace hydration', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-stream-refuse-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

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
});
