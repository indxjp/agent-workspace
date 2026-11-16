/**
 * The config `node tests/settings-table/run.mjs` runs `tests/settings-table.test.ts` with.
 *
 * `pnpm docs:check` runs it before any package is built. The runner manager's settings module
 * builds each driver to see what it reads, so it imports `@agent-workspace/runtime` and, through
 * the runner, `core`, `run-protocol` and `engine`. Here those packages are read from `src`: each
 * export's `dist/….js` becomes the `src/….ts` it is built from. Only this run uses these aliases;
 * the `tests` project keeps resolving them through `node_modules`, as it always did.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, mergeConfig } from 'vitest/config';

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

export default mergeConfig(
  { ...testsConfig, resolve: { ...testsConfig.resolve, alias: [] } },
  defineConfig({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    resolve: {
      alias: [
        ...(testsAliases as { find: string | RegExp; replacement: string }[]),
        ...['runtime', 'run-protocol', 'core', 'engine'].flatMap(sourceAliasesOf),
      ],
    },
    test: { include: ['tests/settings-table.test.ts'] },
  }),
);
