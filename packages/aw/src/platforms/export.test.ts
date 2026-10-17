import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { CommandRefusedError } from '../io.js';
import { tempDirectory } from '../testing.js';
import { guardPaths, renderPlatformReport, type PlatformExport } from './export.js';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function directory(): Promise<string> {
  const made = await tempDirectory();
  directories.push(made);
  return made;
}

describe('guardPaths', () => {
  it('answers the destination of each safe path under the directory', async () => {
    const root = await directory();
    expect(await guardPaths(root, 'p', ['a.txt', 'b/c.txt'])).toEqual([
      path.join(root, 'a.txt'),
      path.join(root, 'b', 'c.txt'),
    ]);
  });

  it.each(['../x', '/etc/x', 'C:\\x', 'a/../../x', '', 'a//b', '\\x'])(
    'refuses %j before writing anything',
    async (file) => {
      const root = await directory();
      await expect(guardPaths(root, 'p', ['ok.txt', file])).rejects.toThrow(CommandRefusedError);
    },
  );

  it('refuses a path under a link that leads out of the directory', async () => {
    const root = await directory();
    const outside = await directory();
    await mkdir(root, { recursive: true });
    await symlink(outside, path.join(root, 'out'));
    await expect(guardPaths(root, 'p', ['out/x.txt'])).rejects.toThrow(
      'produced an unsafe path out/x.txt',
    );
  });

  it.each([
    ['a link', 'inside.txt'],
    ['a dangling link', 'missing.txt'],
  ])('refuses a destination that is itself %s', async (_kind, linked) => {
    const root = await directory();
    await writeFile(path.join(root, 'inside.txt'), 'x');
    await symlink(path.join(root, linked), path.join(root, 'link.txt'));
    await expect(guardPaths(root, 'p', ['ok.txt', 'link.txt'])).rejects.toThrow(
      'produced an unsafe path link.txt',
    );
  });
});

describe('renderPlatformReport', () => {
  it('escapes a pipe in a note so the table keeps its columns', () => {
    const result: PlatformExport = {
      platform: 'claude-managed-agents',
      agent: 'a',
      directory: '/x',
      files: [],
      report: [{ path: 'a.model', verdict: 'mapped', note: 'left|right' }],
      dropped: 0,
      stale: [],
    };
    const text = renderPlatformReport(result);
    expect(text).toContain('left\\|right');
    expect(text.startsWith('# Platform report: Claude Managed Agents\n')).toBe(true);
  });
});
