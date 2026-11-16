import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MiB } from '../../../tests/load/flat-memory.js';
import {
  archiveWorkspacePaths,
  encodeUstarStream,
  readStream,
  RUN_FILES_MAX_ARCHIVE_BYTES,
  RUN_FILES_MAX_BYTES,
  type StreamTarEntry,
} from './transfer.js';
import { fileEntry, chunked } from './transfer.stream.test-support.js';

describe('streamed file sources', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-stream-refuse-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
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
});
