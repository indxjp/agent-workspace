import { spawnSync } from 'node:child_process';

import { remainingBefore } from '../../../generated-project/images.mjs';

import {
  createSupportProject,
  journeyShell,
  preparePackages,
} from '../../build-deploy-journey/journey.e2e.mjs';
import { buildJourneyImages, startRegistry } from '../../build-deploy-journey/registry.mjs';

/** @param {ReturnType<typeof import('../journey.e2e.mjs').createJourneyContext>} context */
export function createCreateStep(context) {
  const { names, s, work, npmPort, registryPort, deadline, ROOT } = context;
  return {
    async create() {
      const shell = journeyShell({ work, npmPort });
      Object.assign(s, shell);
      context.prepared = true;
      await preparePackages({ work, npmPort, npmUrl: shell.npmUrl, deadline });
      startRegistry(registryPort);
      const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
      s['images'] = buildJourneyImages({
        registry: `localhost:${String(registryPort)}`,
        revision: git.status === 0 ? git.stdout.trim() : 'unknown',
        deadline,
      });
      remainingBefore(deadline);
      s['created'] = createSupportProject({ work, name: names.project, userEnv: shell.userEnv });
    },
  };
}
