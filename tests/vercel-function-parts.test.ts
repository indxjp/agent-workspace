/**
 * #830: each Vercel function part installs with `pnpm install --frozen-lockfile --filter {<pkg>}...`,
 * which skips the root's devDependencies, then the part's own `tsc` build (which compiles
 * `src/api/index.ts`) runs with the part's own `node_modules`. Root `tsconfig.json` has no DOM lib,
 * so `Request` and the `node:` modules come from `@types/node`: the part must declare it (and any
 * other `@types/*` its sources need) itself, or the build fails with TS2339 on `Request`. The import scan matches
 * static `from`, side-effect and dynamic `import('…')` specifiers in either quote style.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const readManifest = (directory: string): Manifest =>
  JSON.parse(readFileSync(path.join(ROOT, directory, 'package.json'), 'utf8')) as Manifest;

const workspaceDirectories = ['.', 'apps', 'packages'].flatMap((parent) =>
  parent === '.'
    ? ['.']
    : readdirSync(path.join(ROOT, parent)).map((name) => path.posix.join(parent, name)),
);
const manifests = new Map(
  workspaceDirectories
    .filter((directory) => existsSync(path.join(ROOT, directory, 'package.json')))
    .map((directory) => [directory, readManifest(directory)]),
);

const functionParts = [...manifests.keys()].filter((directory) =>
  existsSync(path.join(ROOT, directory, 'src', 'api', 'index.ts')),
);

function sourceFiles(directory: string): string[] {
  return readdirSync(path.join(ROOT, directory), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => path.join(ROOT, directory, file));
}

function bareImports(directory: string): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(`${directory}/src`)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(
      /(?:\bfrom\s+|\bimport\s*\(?\s*)['"]((?:@[\w.-]+\/)?[\w.-]+)/gu,
    )) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return names;
}

describe('Vercel function parts', () => {
  // `packages/cli/src/render/vercel.test.ts` ties this list to `VERCEL_PARTS`.
  it('finds the gateway and the runner manager', () => {
    expect(functionParts).toEqual(['apps/runner', 'packages/gateway']);
  });

  describe.each(functionParts)('%s', (directory) => {
    const manifest = manifests.get(directory);
    const declared = { ...manifest?.dependencies, ...manifest?.devDependencies };

    it('declares @types/node at the root version, which the part install does not inherit', () => {
      const rootVersion = manifests.get('.')?.devDependencies?.['@types/node'];
      expect(rootVersion).toBeDefined();
      expect(declared['@types/node']).toBe(rootVersion);
    });

    it('declares every @types package the workspace pins for a package its sources import', () => {
      const pinned = new Map<string, string>();
      for (const other of manifests.values()) {
        for (const [name, version] of Object.entries({
          ...other.dependencies,
          ...other.devDependencies,
        })) {
          if (name.startsWith('@types/')) pinned.set(name, version);
        }
      }
      for (const imported of bareImports(directory)) {
        const typesName = `@types/${imported.replace(/^@/u, '').replace('/', '__')}`;
        const version = pinned.get(typesName);
        if (version !== undefined) expect(declared[typesName], typesName).toBe(version);
      }
    });
  });
});
