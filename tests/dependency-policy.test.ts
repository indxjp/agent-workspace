/**
 * The pinning policy as a gate: exact versions, one version per third-party package.
 *
 * `.npmrc`'s `save-exact` only shapes `pnpm add`; a hand edit or a Dependabot PR bypasses it, and
 * one package bumped in only some manifests silently puts a second copy in the lockfile. Every
 * workspace manifest is discovered from the directories, never listed. `peerDependencies` are
 * ranges by design and are not read.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const specifiers = z.record(z.string(), z.string()).optional();
const manifestSchema = z.looseObject({
  dependencies: specifiers,
  devDependencies: specifiers,
  optionalDependencies: specifiers,
});

const manifestPaths = [
  'package.json',
  ...['apps', 'packages'].flatMap((group) =>
    readdirSync(path.join(repoRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}/package.json`),
  ),
].filter((manifestPath) => existsSync(path.join(repoRoot, manifestPath)));

interface Entry {
  readonly manifest: string;
  readonly name: string;
  readonly specifier: string;
}

const entries: readonly Entry[] = manifestPaths.flatMap((manifest) => {
  const parsed = manifestSchema.parse(
    JSON.parse(readFileSync(path.join(repoRoot, manifest), 'utf8')),
  );
  return [parsed.dependencies, parsed.devDependencies, parsed.optionalDependencies].flatMap(
    (block) =>
      Object.entries(block ?? {})
        .filter(([, specifier]) => !specifier.startsWith('workspace:'))
        .map(([name, specifier]) => ({ manifest, name, specifier })),
  );
});

describe('the workspace dependency pinning policy', () => {
  it('pins every third-party dependency exactly', () => {
    const offenders = entries
      .filter(
        ({ specifier }) =>
          !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(specifier.replace(/^npm:(@?[^@]+)@/u, '')),
      )
      .map(({ manifest, name, specifier }) => `${manifest} ${name} ${specifier}`);
    expect(offenders).toStrictEqual([]);
  });

  it('declares each third-party package at one version', () => {
    const byName = new Map<string, Set<string>>();
    for (const { name, specifier } of entries) {
      byName.set(name, (byName.get(name) ?? new Set<string>()).add(specifier));
    }
    const split = [...byName]
      .filter(([, versions]) => versions.size > 1)
      .map(([name, versions]) => `${name} ${[...versions].join(' ')}`);
    expect(split).toStrictEqual([]);
  });
});
