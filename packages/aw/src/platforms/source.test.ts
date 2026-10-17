import { rm, symlink } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { CommandRefusedError } from '../io.js';
import { tempDirectory, tempFile } from '../testing.js';
import { nodePortableProjectSource } from './source.js';

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

describe('nodePortableProjectSource', () => {
  it('reads a file, and answers null for a missing one', async () => {
    const root = await directory();
    await tempFile(root, 'skills/a/SKILL.md', 'hi');
    const source = nodePortableProjectSource(root);
    expect(await source.readFile('skills/a/SKILL.md')).toEqual(new TextEncoder().encode('hi'));
    expect(await source.readFile('skills/missing.md')).toBeNull();
    expect(await source.readFile('skills/a')).toBeNull();
  });

  it('refuses a path that leaves the project, by name or through a link', async () => {
    const root = await directory();
    const outside = await directory();
    await tempFile(outside, 'secret.txt', 'x');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    const source = nodePortableProjectSource(root);
    await expect(source.readFile('../secret.txt')).rejects.toThrow(CommandRefusedError);
    await expect(source.readFile('link.txt')).rejects.toThrow('link.txt is outside the project');
  });

  it('lists regular files recursively in code-unit order, skipping links', async () => {
    const root = await directory();
    await tempFile(root, 'k/b.md', '1');
    await tempFile(root, 'k/A.md', '2');
    await tempFile(root, 'k/sub/c.md', '3');
    await symlink(root, path.join(root, 'k', 'loop'));
    const source = nodePortableProjectSource(root);
    expect(await source.listFiles('k')).toEqual(['k/A.md', 'k/b.md', 'k/sub/c.md']);
    expect(await source.listFiles('nothing')).toEqual([]);
  });
});
