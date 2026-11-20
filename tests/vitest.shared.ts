/**
 * The Vitest config of one `tests/` project (tests/projects.mjs lists them). Every project of the
 * root `tests/` tree resolves modules the same way, so the resolution lives here once and each
 * `vitest.config.ts` is one call.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

import rootConfig from '../vitest.config.js';
import { testsProject } from './projects.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const rootAlias = rootConfig.resolve?.alias;
if (!Array.isArray(rootAlias)) {
  throw new Error('vitest.config.ts: the root resolve.alias must be an array');
}
const rootAliases: readonly { readonly find: string | RegExp; readonly replacement: string }[] =
  rootAlias;

/** @param name the project's name in tests/projects.mjs */
export function testsProjectConfig(name: string) {
  const project = testsProject(name);
  return defineConfig({
    root: path.join(repoRoot, project.root),
    // A project does not inherit the root aliases. These two packages are read from `src`, because
    // the static checks (tests/static-checks/vitest.config.ts, which starts from these aliases) run
    // in `pnpm docs:check` and `pnpm policy:check` before any package is built; the rest keep
    // resolving through `node_modules`, as they always did here. The settings table
    // (`tests/settings-table/settings-table.docs-check.ts`) imports `@agent-workspace/egress-proxy`,
    // and the sign-in settings it reads import `@agent-workspace/core/posture`, so both come from
    // `src`; so does `@agent-workspace/gateway/settings`, the gateway's settings module.
    resolve: {
      alias: [
        ...rootAliases.filter(({ find }) =>
          /@indx-workspace\\?\/(contracts|platforms)/u.test(String(find)),
        ),
        // The store's recordings run the reference apps' own agents on their own resources
        // (`tests/store/recordings/apps.ts`), so the app package comes from `src` as well: the
        // examples are not installed here, and a bare `@indx-workspace/app` would find nothing.
        {
          find: /^@indx-workspace\/app\/(server|db|testing|react)$/u,
          replacement: path.join(repoRoot, 'packages/app/src/$1/index.ts'),
        },
        {
          find: /^@indx-workspace\/app$/u,
          replacement: path.join(repoRoot, 'packages/app/src/index.ts'),
        },
        {
          find: /^@agent-workspace\/egress-proxy$/u,
          replacement: path.join(repoRoot, 'packages/egress-proxy/src/index.ts'),
        },
        {
          find: /^@agent-workspace\/gateway\/settings$/u,
          replacement: path.join(repoRoot, 'packages/gateway/src/settings.ts'),
        },
        {
          find: /^@agent-workspace\/core\/posture$/u,
          replacement: path.join(repoRoot, 'packages/core/src/posture.ts'),
        },
      ],
    },
    test: {
      name: project.name,
      include: [...project.include],
      exclude: [...configDefaults.exclude, ...project.exclude],
      pool: project.pool,
      isolate: project.isolate,
      fileParallelism: project.fileParallelism,
      sequence: { groupOrder: project.groupOrder },
    },
  });
}
