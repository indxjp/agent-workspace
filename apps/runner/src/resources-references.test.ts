import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type RunFileReference } from '@agent-workspace/run-protocol';
import { expect, it } from 'vitest';
import {
  request,
  fileRef,
  layFile,
  materialize,
  withResourceRoot,
} from './resources.fixture.test-support.js';

// @story US-STO-06
const hydrated = 'as hydrated';

const reference = (access: 'read' | 'read-write', name: string): RunFileReference =>
  fileRef(name, access, hydrated.length);

/** Lay `name` down the way `POST /files` would, then materialize a request granting it. */
async function hydrate(root: string, grant: RunFileReference) {
  const parsed = request(root, [grant]);
  await mkdir(path.dirname(path.join(parsed.cwd, grant.path)), { recursive: true });
  await writeFile(path.join(parsed.cwd, grant.path), hydrated);
  materialize(parsed);
  return path.join(parsed.cwd, grant.path);
}

it('granted file references > [US-STO-06][contract][run] read grants arrive read-only', async () => {
  await withResourceRoot('agent-reference-ro-', async (root) => {
    const target = await hydrate(root, reference('read', 'reports/q3.txt'));
    expect((await lstat(target)).mode & 0o777).toBe(0o444);
    expect(await readFile(target, 'utf8')).toBe(hydrated);
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await expect(writeFile(target, 'changed')).rejects.toMatchObject({ code: 'EACCES' });
    }
  });
});

it('granted file references > [US-STO-06][contract][run] read-write grants arrive writable', async () => {
  await withResourceRoot('agent-reference-rw-', async (root) => {
    const target = await hydrate(root, reference('read-write', 'draft.txt'));
    // Windows keeps only the read-only attribute of a mode, so a writable file reads back 0o666.
    expect((await lstat(target)).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o644);
    await writeFile(target, 'changed');
    expect(await readFile(target, 'utf8')).toBe('changed');
  });
});

it('granted file references > [US-STO-06][contract][run] a reference to the private config directory is refused', async () => {
  await withResourceRoot('agent-reference-config-', async (root) => {
    await expect(hydrate(root, reference('read', '.claude/settings.json'))).rejects.toThrow(
      /private \.claude directory/u,
    );
  });
});

it('granted file references > [US-STO-06][contract][run] narrowing a folder grant to one child keeps that child', async () => {
  await withResourceRoot('agent-reference-narrowed-', async (root) => {
    const both = request(root, [
      { kind: 'directory', path: 'docs', access: 'read' },
      reference('read', 'docs/a.txt'),
      reference('read', 'docs/b.txt'),
    ]);
    await layFile(both, 'docs/a.txt', hydrated);
    await layFile(both, 'docs/b.txt', hydrated);
    materialize(both);
    const parsed = request(root, [reference('read', 'docs/a.txt')]);
    materialize(parsed);
    const kept = path.join(parsed.cwd, 'docs', 'a.txt');
    expect(await readFile(kept, 'utf8')).toBe(hydrated);
    expect((await lstat(kept)).mode & 0o777).toBe(0o444);
    await expect(lstat(path.join(parsed.cwd, 'docs', 'b.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

it('granted file references > [US-STO-06][contract][run] a revoked reference is removed on the next turn', async () => {
  await withResourceRoot('agent-reference-revoked-', async (root) => {
    const target = await hydrate(root, reference('read', 'reports/q3.txt'));
    materialize(request(root, []));
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
