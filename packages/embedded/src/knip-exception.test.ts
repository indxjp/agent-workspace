/**
 * The knip exception of this package, held to its rule (README, "The knip exception").
 *
 * `knip.json` ignores, for this workspace only, the dependencies no file under `src/` imports by
 * name: the third-party externals of the bundle that only inlined workspace members import, and
 * the members reached only through other members. They are real run-time dependencies knip cannot
 * see. This test keeps the list exactly that: a name may be on it only when it is a dependency of
 * this manifest that `src/` never imports, and every such dependency must be on it, except one
 * that a workspace member it depends on declares as a peer, which knip counts as used.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { packageNameOf } from './packaging/externals.ts';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

const manifest = z
  .looseObject({ dependencies: z.record(z.string(), z.string()) })
  .parse(JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8')));

const ignored = z
  .looseObject({
    workspaces: z.looseObject({
      'packages/embedded': z.looseObject({ ignoreDependencies: z.array(z.string()) }),
    }),
  })
  .parse(JSON.parse(readFileSync(path.join(packageDirectory, '..', '..', 'knip.json'), 'utf8')))
  .workspaces['packages/embedded'].ignoreDependencies;

/**
 * Every package a file under `src/` imports, statically or with `import()`, parsed as TypeScript
 * so a specifier inside a string or a comment does not count (knip does not count it either).
 */
function packagesImportedBySource(): ReadonlySet<string> {
  const names = new Set<string>();
  const sourceDirectory = path.join(packageDirectory, 'src');
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const source = readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      const name = packageNameOf(fileName);
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

/** Every package a workspace member this manifest depends on declares as a peer (`@indx-workspace/cli`'s bucket clients). */
function peersOfDependencies(): ReadonlySet<string> {
  const peers = new Set<string>();
  for (const [name, specifier] of Object.entries(manifest.dependencies)) {
    if (!specifier.startsWith('workspace:')) continue;
    const installed = path.join(
      packageDirectory,
      'node_modules',
      ...name.split('/'),
      'package.json',
    );
    const parsed = z
      .looseObject({ peerDependencies: z.record(z.string(), z.string()).optional() })
      .parse(JSON.parse(readFileSync(installed, 'utf8')));
    for (const peer of Object.keys(parsed.peerDependencies ?? {})) peers.add(peer);
  }
  return peers;
}

describe('the knip ignoreDependencies exception of packages/embedded', () => {
  const imported = packagesImportedBySource();
  const peers = peersOfDependencies();

  it('lists exactly the dependencies that src/ never imports by name and no dependency peers', () => {
    const expected = Object.keys(manifest.dependencies)
      .filter((name) => !imported.has(name) && !peers.has(name))
      .sort();
    expect([...ignored].sort()).toStrictEqual(expected);
  });

  it('lists only inlined workspace members and pinned third-party externals', () => {
    // The build fails unless every third-party pin is a staged dependency of the published
    // manifest (`checkWorkspacePins`), so a pinned name here is one the published package needs.
    const neither = ignored.filter((name) => {
      const specifier = manifest.dependencies[name];
      return (
        specifier === undefined || (!specifier.startsWith('workspace:') && !/^\d/u.test(specifier))
      );
    });
    expect(neither).toStrictEqual([]);
  });
});
