// @story US-STO-06
// @story US-STO-11
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { RunFileReference } from '@agent-workspace/run-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verifyReferencedFiles } from './verify-files.js';

let cwd = '';

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'aw-verify-files-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

const reference = (filePath: string, bytes: string): RunFileReference => ({
  kind: 'file',
  path: filePath,
  access: 'read',
  size: Buffer.byteLength(bytes),
  sha256: sha256(bytes),
});

async function place(filePath: string, bytes: string): Promise<void> {
  await mkdir(path.dirname(path.join(cwd, filePath)), { recursive: true });
  await writeFile(path.join(cwd, filePath), bytes);
}

describe('verifyReferencedFiles', () => {
  it('[US-STO-06][contract][run] a matching file passes', async () => {
    await place('reports/q3.txt', 'granted');
    await place('notes.txt', 'second');
    const result = await verifyReferencedFiles(cwd, '.claude', [
      reference('reports/q3.txt', 'granted'),
      reference('notes.txt', 'second'),
    ]);
    expect(result).toEqual({ ok: true });
  });

  it('[US-STO-06][contract][run] a checksum mismatch stops the run before the agent starts', async () => {
    await place('reports/q3.txt', 'tampered!');
    const result = await verifyReferencedFiles(cwd, '.claude', [
      reference('reports/q3.txt', 'granted!!'),
    ]);
    expect(result).toEqual({
      ok: false,
      code: 'run_file_checksum_mismatch',
      path: 'reports/q3.txt',
    });
  });

  it('[US-STO-06][contract][run] a size mismatch is a checksum mismatch', async () => {
    await place('reports/q3.txt', 'longer than granted');
    const result = await verifyReferencedFiles(cwd, '.claude', [
      reference('reports/q3.txt', 'granted'),
    ]);
    expect(result).toMatchObject({ ok: false, code: 'run_file_checksum_mismatch' });
  });

  it('[US-STO-06][contract][run] a missing granted file stops the run', async () => {
    const result = await verifyReferencedFiles(cwd, '.claude', [
      reference('reports/q3.txt', 'granted'),
    ]);
    expect(result).toEqual({ ok: false, code: 'run_file_missing', path: 'reports/q3.txt' });
  });

  it('[US-STO-06][contract][run] a symlinked granted path is refused', async () => {
    await place('elsewhere/secret.txt', 'granted');
    await symlink(path.join(cwd, 'elsewhere', 'secret.txt'), path.join(cwd, 'leaf.txt'));
    await symlink(path.join(cwd, 'elsewhere'), path.join(cwd, 'parent'));
    for (const granted of ['leaf.txt', 'parent/secret.txt']) {
      const result = await verifyReferencedFiles(cwd, '.claude', [reference(granted, 'granted')]);
      expect(result, granted).toEqual({ ok: false, code: 'run_file_missing', path: granted });
    }
  });

  it('[US-STO-06][contract][run] a directory at a file reference is refused', async () => {
    await mkdir(path.join(cwd, 'reports'));
    const result = await verifyReferencedFiles(cwd, '.claude', [reference('reports', '')]);
    expect(result).toMatchObject({ ok: false, code: 'run_file_missing' });
  });

  it('[US-STO-06][contract][run] a path that escapes the workspace is refused without naming the host', async () => {
    const result = await verifyReferencedFiles(cwd, '.claude', [
      reference('../outside.txt', 'granted'),
    ]);
    expect(result).toEqual({ ok: false, code: 'run_file_missing', path: '../outside.txt' });
    expect(JSON.stringify(result)).not.toContain(cwd);
  });

  it('[US-STO-11][contract][run] an attachment reference is verified like a grant', async () => {
    await place('attachments/photo.bin', 'attached');
    expect(
      await verifyReferencedFiles(cwd, '.claude', [reference('attachments/photo.bin', 'attached')]),
    ).toEqual({ ok: true });
    expect(
      await verifyReferencedFiles(cwd, '.claude', [reference('attachments/photo.bin', 'swapped!')]),
    ).toEqual({ ok: false, code: 'run_file_checksum_mismatch', path: 'attachments/photo.bin' });
  });

  it('[US-STO-06][contract][run] a reference into the engine protected config directory is refused before it is hashed', async () => {
    await place('.claude/settings.json', 'granted');
    for (const granted of [
      '.claude/settings.json',
      '.ClAuDe./settings.json',
      '%2Eclaude/settings.json',
    ]) {
      // Bytes that match: answering anything but `run_file_missing` would say they were read.
      const result = await verifyReferencedFiles(cwd, '.claude', [reference(granted, 'granted')]);
      expect(result, granted).toEqual({ ok: false, code: 'run_file_missing', path: granted });
    }
  });

  // `mkfifo` is POSIX; the runner image and CI are Linux. The swap between resolution and open is
  // not reproducible on demand, so this pins the half that matters: the open does not block on a
  // FIFO and the handle, not the path, is what is judged.
  it('[US-STO-06][contract][run] a FIFO at a reference is refused without blocking', async () => {
    execFileSync('mkfifo', [path.join(cwd, 'pipe.txt')]);
    const result = await verifyReferencedFiles(cwd, '.claude', [reference('pipe.txt', 'granted')]);
    expect(result).toEqual({ ok: false, code: 'run_file_missing', path: 'pipe.txt' });
  });
});
