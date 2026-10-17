import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeFileAtomically } from './write-file.js';

const failure = vi.hoisted(() => ({ rename: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: (from: string, to: string) =>
      failure.rename
        ? Promise.reject(Object.assign(new Error('rename failed'), { code: 'EIO' }))
        : actual.rename(from, to),
  };
});

const created: string[] = [];

afterEach(async () => {
  failure.rename = false;
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true })));
});

async function directory(): Promise<string> {
  const made = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-write-'));
  created.push(made);
  return made;
}

describe('writeFileAtomically', () => {
  it('replaces a file, keeps its mode, and leaves no temporary file', async () => {
    const parent = await directory();
    const target = path.join(parent, '.env');
    await writeFile(target, 'OLD=1\n');
    await chmod(target, 0o600);

    await writeFileAtomically(target, 'NEW=2\n', 0o600);

    expect(await readFile(target, 'utf8')).toBe('NEW=2\n');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(parent)).toEqual(['.env']);
  });

  it('creates a file that does not exist yet', async () => {
    const parent = await directory();
    const target = path.join(parent, 'compose.yaml');

    await writeFileAtomically(target, 'services: {}\n', null);

    expect(await readFile(target, 'utf8')).toBe('services: {}\n');
    expect(await readdir(parent)).toEqual(['compose.yaml']);
  });

  it('leaves the old file intact and removes the temporary file when the rename fails', async () => {
    const parent = await directory();
    const target = path.join(parent, '.env');
    await writeFile(target, 'SECRET=keep-me\n');
    failure.rename = true;

    await expect(writeFileAtomically(target, 'SECRET=new\n', 0o600)).rejects.toThrow(
      'rename failed',
    );

    expect(await readFile(target, 'utf8')).toBe('SECRET=keep-me\n');
    expect(await readdir(parent)).toEqual(['.env']);
  });
});
