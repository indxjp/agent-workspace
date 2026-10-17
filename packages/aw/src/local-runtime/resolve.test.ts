import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CommandRefusedError } from '../io.js';
import { tempDirectory } from '../testing.js';
import { AW_VERSION } from '../version.js';
import { EMBEDDED_INSTALL_FIX, resolveLocalRuntime } from './resolve.js';

/**
 * Issue #451 (S1-13): `aw dev` finds the runtime the project installed, as an ES module `import`
 * from the project would. Under pnpm the test process runs with `NODE_PATH` pointing at the
 * workspace store, which holds the repository's own `@indx-workspace/embedded`; CommonJS
 * resolution consulted it, so a project without the runtime forked the workspace's real one.
 */

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function projectWith(manifest: Record<string, unknown> | null): Promise<string> {
  const directory = await tempDirectory();
  temporary.push(directory);
  await writeFile(path.join(directory, 'package.json'), '{ "name": "demo", "private": true }\n');
  if (manifest !== null) {
    const embedded = path.join(directory, 'node_modules', '@indx-workspace', 'embedded');
    await mkdir(embedded, { recursive: true });
    await writeFile(path.join(embedded, 'package.json'), JSON.stringify(manifest));
    await writeFile(path.join(embedded, 'bin.mjs'), '');
  }
  return directory;
}

async function refusal(cwd: string): Promise<CommandRefusedError> {
  const error: unknown = await resolveLocalRuntime(cwd).catch((caught: unknown) => caught);
  if (!(error instanceof CommandRefusedError)) throw new Error('expected a CommandRefusedError');
  return error;
}

describe('resolveLocalRuntime (issue #451)', () => {
  it('finds the launch export of the runtime the project installed', async () => {
    const cwd = await projectWith({
      name: '@indx-workspace/embedded',
      version: AW_VERSION,
      exports: { './launch': './bin.mjs', './package.json': './package.json' },
    });
    const nested = path.join(cwd, 'src', 'agents');
    await mkdir(nested, { recursive: true });
    const resolved = await resolveLocalRuntime(nested);
    expect(resolved.version).toBe(AW_VERSION);
    expect(resolved.launchPath).toBe(
      path.join(
        await realpath(path.join(cwd, 'node_modules', '@indx-workspace', 'embedded')),
        'bin.mjs',
      ),
    );
  });

  it('refuses a project without the runtime, whatever NODE_PATH holds', async () => {
    const error = await refusal(await projectWith(null));
    expect(error.message).toBe('@indx-workspace/embedded is not installed in this project');
    expect(error.fix).toBe(EMBEDDED_INSTALL_FIX);
  });

  it.each([
    ['without the ./launch export', { exports: { './package.json': './package.json' } }],
    // No `exports` map: Node falls back to the module paths, and finds nothing inside the package.
    ['without an exports map', {}],
    // The export is read with file system calls only (the §42 boundary gate refuses a module
    // resolver over a package `aw` does not depend on), so these are checked here, not by Node.
    ['whose ./launch target is missing', { exports: { './launch': './dist/missing.mjs' } }],
    ['whose ./launch target is not relative', { exports: { './launch': 'bin.mjs' } }],
    ['with a conditional ./launch target', { exports: { './launch': { import: './bin.mjs' } } }],
  ])('refuses a runtime package %s', async (_name, fields) => {
    const error = await refusal(
      await projectWith({ name: '@indx-workspace/embedded', version: AW_VERSION, ...fields }),
    );
    expect(error.message).toBe('@indx-workspace/embedded is not installed in this project');
    expect(error.fix).toBe(EMBEDDED_INSTALL_FIX);
  });

  it.each([
    ['a package.json that is not JSON', '{bad json'],
    [
      'an exports target outside the package',
      JSON.stringify({
        name: '@indx-workspace/embedded',
        version: AW_VERSION,
        exports: { './launch': '../../../evil.mjs' },
      }),
    ],
  ])('refuses %s with the install line, not an unexpected error', async (_name, text) => {
    const cwd = await projectWith({});
    await writeFile(
      path.join(cwd, 'node_modules', '@indx-workspace', 'embedded', 'package.json'),
      text,
    );
    const error = await refusal(cwd);
    expect(error.message).toBe('@indx-workspace/embedded is not installed in this project');
    expect(error.fix).toBe(EMBEDDED_INSTALL_FIX);
  });
});
