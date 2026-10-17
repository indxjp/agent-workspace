import { describe, expect, it } from 'vitest';

import { loadDeploySteps, loadPublishSteps } from './cli-bridge.js';
import { CommandRefusedError } from './io.js';
import { AW_VERSION } from './version.js';

// `vi.mock` cannot make a module unresolvable (a throwing factory is wrapped), so the loaders'
// seam stands in for the optional peer that is not installed.
describe('the CLI bridge', () => {
  const missing = Object.assign(new Error("Cannot find package '@indx-workspace/cli'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
  const fix = `npm install --save-dev @indx-workspace/cli@${AW_VERSION}`;

  it.each([
    ['deploy', () => loadDeploySteps(() => Promise.reject(missing)), 'deploy'],
    ['publish', () => loadPublishSteps(() => Promise.reject(missing)), 'platforms publish'],
  ])('fails fast naming the package when %s cannot load the CLI', async (_name, load, command) => {
    const loading = load();

    await expect(loading).rejects.toThrow(
      new CommandRefusedError(
        `@indx-workspace/cli is not installed; aw ${command} runs its steps`,
        fix,
      ),
    );
    // ESM never resolves a global install from the project's `aw`, so the fix is a dev dependency.
    await expect(loading).rejects.toMatchObject({ fix });
  });

  it.each([
    ['deploy', (error: Error) => loadDeploySteps(() => Promise.reject(error)), 'deploy'],
    [
      'publish',
      (error: Error) => loadPublishSteps(() => Promise.reject(error)),
      'platforms publish',
    ],
  ])(
    'asks for the matching version when the installed CLI lacks the %s subpath',
    async (_name, load, command) => {
      const older = Object.assign(
        new Error(
          'Package subpath \'./publish\' is not defined by "exports" in /work/node_modules/@indx-workspace/cli/package.json imported from /work/node_modules/@indx-workspace/aw/dist/cli-bridge.js',
        ),
        { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
      );

      await expect(load(older)).rejects.toThrow(
        new CommandRefusedError(
          `@indx-workspace/cli is older than aw; aw ${command} runs its steps`,
          fix,
        ),
      );
      await expect(load(older)).rejects.toMatchObject({ fix });
    },
  );

  it('rethrows a missing package of an installed @indx-workspace/cli as it is', async () => {
    const brokenInstall = Object.assign(
      new Error("Cannot find package 'pg' imported from /usr/lib/node_modules/@indx-workspace/cli"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );

    await expect(loadDeploySteps(() => Promise.reject(brokenInstall))).rejects.toBe(brokenInstall);
    await expect(loadPublishSteps(() => Promise.reject(brokenInstall))).rejects.toBe(brokenInstall);
  });
});
