import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ENGINE_PACKAGES } from '@indx-workspace/sdk/project';
import { afterEach, describe, expect, it } from 'vitest';

import { CommandRefusedError } from '../io.js';
import { tempDirectory } from '../testing.js';
import { requireEnginePackages } from './engine-packages.js';

/**
 * Issue #691: the local runtime carries no engine of its own, so `aw dev` refuses a project whose
 * agents use an engine it did not install, with the one line that installs it.
 */
const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A project with `installed` present under its `node_modules`. */
async function projectWith(installed: readonly string[]): Promise<string> {
  const directory = await tempDirectory();
  temporary.push(directory);
  for (const name of installed) {
    const packageDirectory = path.join(directory, 'node_modules', ...name.split('/'));
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(path.join(packageDirectory, 'package.json'), '{}');
  }
  return directory;
}

describe('requireEnginePackages', () => {
  it('passes when every package of every used engine is installed, from a nested directory', async () => {
    const cwd = await projectWith(Object.keys(ENGINE_PACKAGES.pi));
    const nested = path.join(cwd, 'agents');
    await mkdir(nested);
    await expect(requireEnginePackages(nested, ['pi', 'pi'])).resolves.toBeUndefined();
  });

  it('refuses an engine with a missing package, fixing it with only what is missing', async () => {
    const [first, ...rest] = Object.entries(ENGINE_PACKAGES.mastra);
    const cwd = await projectWith(first === undefined ? [] : [first[0]]);
    const error: unknown = await requireEnginePackages(cwd, ['mastra']).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CommandRefusedError);
    expect((error as CommandRefusedError).message).toBe('engine mastra is not installed');
    expect((error as CommandRefusedError).fix).toBe(
      `npm install ${rest.map(([name, version]) => `${name}@${version}`).join(' ')}`,
    );
  });

  it('asks nothing of a project with no agents', async () => {
    const cwd = await projectWith([]);
    await expect(requireEnginePackages(cwd, [])).resolves.toBeUndefined();
  });
});
