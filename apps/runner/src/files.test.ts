import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { decodeUstar, normalizeArchivePath } from '@agent-workspace/runtime/transfer';

import { collectWorkspace, hydrateWorkspace } from './files.js';

function run(command: string, args: readonly string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { shell: false, windowsHide: true });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

describe('runner file hydration and collection', () => {
  it('hydrates a system-created tar under the workspace root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-runner-hydrate-'));
    const source = path.join(root, 'source');
    const workspace = path.join(root, 'workspace');
    const archive = path.join(root, 'in.tar');
    try {
      await mkdir(path.join(source, 'nested'), { recursive: true });
      await writeFile(path.join(source, 'nested', 'hello.txt'), 'hello from tar\n');
      const result = await run('tar', ['-cf', archive, '-C', source, 'nested/hello.txt']);
      expect(result.code, result.output).toBe(0);
      expect(await hydrateWorkspace(workspace, await readFile(archive))).toEqual([
        'nested/hello.txt',
      ]);
      expect(await readFile(path.join(workspace, 'nested', 'hello.txt'), 'utf8')).toBe(
        'hello from tar\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('collects exact bytes into a system-readable POSIX ustar archive', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-runner-collect-'));
    const workspace = path.join(root, 'workspace');
    const archive = path.join(root, 'out.tar');
    try {
      await mkdir(path.join(workspace, 'nested'), { recursive: true });
      await writeFile(path.join(workspace, 'with.txt'), 'with newline\n');
      await writeFile(path.join(workspace, 'nested', 'without.txt'), 'without newline');
      const bytes = await collectWorkspace(workspace, ['with.txt', 'nested']);
      await writeFile(archive, bytes);
      const listing = await run('tar', ['-tvf', archive]);
      expect(listing.code, listing.output).toBe(0);
      expect(listing.output).toContain('with.txt');
      expect(listing.output).toContain('nested/without.txt');
      const decoded = decodeUstar(bytes);
      expect(
        Buffer.from(decoded.find((entry) => entry.path === 'with.txt')?.data ?? []).toString(),
      ).toBe('with newline\n');
      expect(
        Buffer.from(
          decoded.find((entry) => entry.path === 'nested/without.txt')?.data ?? [],
        ).toString(),
      ).toBe('without newline');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Issue #1274: the web launcher collects `<workspace>/<session>/outputs`, relative to the runtime root.
  it("collects one session's outputs/ from the runtime root, not its siblings or the root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-runner-session-outputs-'));
    try {
      await mkdir(path.join(root, 'ws', 's1', 'outputs'), { recursive: true });
      await mkdir(path.join(root, 'ws', 's2', 'outputs'), { recursive: true });
      await writeFile(path.join(root, 'ws', 's1', 'outputs', 'report.md'), '# one');
      await writeFile(path.join(root, 'ws', 's1', 'notes.md'), 'not an output');
      await writeFile(path.join(root, 'ws', 's2', 'outputs', 'other.md'), '# two');
      await writeFile(path.join(root, 'root.txt'), 'root');

      const files = decodeUstar(await collectWorkspace(root, ['ws/s1/outputs']))
        .filter((entry) => entry.type === 'file')
        .map((entry) => entry.path);

      expect(files).toEqual(['ws/s1/outputs/report.md']);
      await expect(collectWorkspace(root, ['ws/s3/outputs'])).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an existing leaf symlink without modifying its outside target', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-runner-leaf-symlink-'));
    const source = path.join(root, 'source');
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside.txt');
    const leaf = path.join(workspace, 'payload.txt');
    try {
      await mkdir(source);
      await mkdir(workspace);
      await writeFile(path.join(source, 'payload.txt'), 'attacker data');
      await writeFile(outside, 'outside must survive');
      await symlink(outside, leaf, 'file');
      const archive = await collectWorkspace(source, ['payload.txt']);

      await expect(hydrateWorkspace(workspace, archive)).rejects.toThrow(/symlink/u);
      expect(await readFile(outside, 'utf8')).toBe('outside must survive');
      expect((await lstat(leaf)).isSymbolicLink()).toBe(true);
      expect((await readdir(workspace)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to collect through a linked parent directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-runner-collect-parent-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    try {
      await mkdir(workspace);
      await mkdir(outside);
      await writeFile(path.join(outside, 'secret.txt'), 'outside the workspace');
      await symlink(outside, path.join(workspace, 'outputs'), 'junction');

      await expect(collectWorkspace(workspace, ['outputs/secret.txt'])).rejects.toThrow(/symlink/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('overwrites an existing regular file without leaving a backup on Windows', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-runner-overwrite-'));
    const source = path.join(root, 'source');
    const workspace = path.join(root, 'workspace');
    try {
      await mkdir(source);
      await mkdir(workspace);
      await writeFile(path.join(source, 'payload.txt'), 'new data');
      await writeFile(path.join(workspace, 'payload.txt'), 'old data');

      await hydrateWorkspace(workspace, await collectWorkspace(source, ['payload.txt']));

      expect(await readFile(path.join(workspace, 'payload.txt'), 'utf8')).toBe('new data');
      expect((await readdir(workspace)).filter((name) => /\.(?:bak|tmp)$/u.test(name))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['../escape', '/absolute', 'C:\\absolute', '%2e%2e/escape', '%252e%252e/escape'])(
    'refuses workspace escape %s',
    (unsafe) => expect(() => normalizeArchivePath(unsafe)).toThrow(/unsafe archive path/u),
  );
});
