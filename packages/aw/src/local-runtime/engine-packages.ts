import type { EngineId } from '@indx-workspace/contracts/engines';
import { ENGINE_PACKAGES } from '@indx-workspace/sdk/project';

import { CommandRefusedError } from '../io.js';
import { findPackageDirectory } from './resolve.js';

/**
 * Refuses `aw dev` when the project lacks a package one of its agents' `engines` loads (#691): the
 * local runtime declares every engine's packages as optional peers, so a project installs only the
 * engines it uses, and an agent moved to another engine needs that engine's packages first. The
 * refusal's fix is the one line that installs them, at the versions this release runs.
 */
export async function requireEnginePackages(
  cwd: string,
  engines: Iterable<EngineId>,
): Promise<void> {
  for (const engine of new Set(engines)) {
    const packages = Object.entries(ENGINE_PACKAGES[engine]);
    const present = await Promise.all(
      packages.map(async ([name]) => (await findPackageDirectory(cwd, name)) !== undefined),
    );
    const missing = packages.filter((_, index) => !present[index]);
    if (missing.length > 0) {
      throw new CommandRefusedError(
        `engine ${engine} is not installed`,
        `npm install ${missing.map(([name, version]) => `${name}@${version}`).join(' ')}`,
      );
    }
  }
}
