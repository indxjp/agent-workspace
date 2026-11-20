/**
 * The static checks: assertions about the committed tree that run as `pnpm docs:check` and
 * `pnpm policy:check`, not as tests (ADR-0053 Amendment 2026-11-19f, part 3).
 *
 * They are written as Vitest files because they read the repository's TypeScript (the settings
 * catalogues, the platform targets, the store catalog, the route and screen readers), and Vitest is
 * this repository's TypeScript runner. They are named `*.docs-check.ts` and `*.policy-check.ts`, so
 * no `tests*` project collects them (Vitest's default `include` is `*.{test,spec}.*`): each runs
 * once per change, in the cheap static job, instead of again inside the test lanes.
 *
 * - `docs-check` — the committed documents agree with the code and with each other: the platform
 *   matrix, the settings table and the docs-truth assertions.
 *   `node tests/static-checks/run.mjs docs-check`, in `pnpm docs:check`.
 * - `policy-check` — the inventories and registers agree with the tracked tree: the route and
 *   screen inventories, the RF-001 expected-failure register, the catalog-fake and vocabulary
 *   allowlists. `pnpm policy:check` (scripts/policy-check.mjs). Its files run without isolation,
 *   so the files one worker runs share the scanners it has loaded (`git ls-files`, the declaration
 *   and specification readers).
 *
 * Both run before any package is built (fast-checks has no build), so every workspace package a
 * check imports is read from `src`: the `tests` project's aliases, and every export of runtime,
 * run-protocol, core and engine (`dist/….js` becomes the `src/….ts` it is built from), which the
 * runner manager's settings module reaches.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

import testsConfig from '../vitest.config.js';

interface Manifest {
  readonly name: string;
  readonly exports: Readonly<Record<string, string | { readonly default: string }>>;
}

function sourceAliasesOf(pkg: string): { find: RegExp; replacement: string }[] {
  const root = new URL(`../../packages/${pkg}/`, import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as Manifest;
  return Object.entries(manifest.exports).map(([subpath, target]) => {
    const built = typeof target === 'string' ? target : target.default;
    const name = `${manifest.name}${subpath === '.' ? '' : subpath.slice(1)}`;
    return {
      find: new RegExp(`^${name.replaceAll('/', '\\/')}$`, 'u'),
      replacement: fileURLToPath(
        new URL(built.replace('./dist/', './src/').replace(/\.js$/u, '.ts'), root),
      ),
    };
  });
}

const testsAliases = testsConfig.resolve?.alias;
if (!Array.isArray(testsAliases)) {
  throw new Error('tests/vitest.config.ts: resolve.alias must be an array');
}

const resolve = {
  alias: [
    ...(testsAliases as { find: string | RegExp; replacement: string }[]),
    ...['runtime', 'run-protocol', 'core', 'engine'].flatMap(sourceAliasesOf),
  ],
};
const root = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        root,
        resolve,
        test: {
          name: 'docs-check',
          include: ['tests/**/*.docs-check.ts'],
          exclude: [...configDefaults.exclude],
        },
      },
      {
        root,
        resolve,
        test: {
          name: 'policy-check',
          include: ['tests/**/*.policy-check.ts'],
          exclude: [...configDefaults.exclude],
          // Measured (ADR-0053 Amendment 2026-11-19f, part 3): files in parallel beat one
          // worker (3.2 s against 6.8 s here; the three whole-tree scans dominate), and no isolation
          // lets the files a worker runs share the scanners it has loaded (4.0 s against 4.4 s at
          // two workers).
          isolate: false,
        },
      },
    ],
  },
});
