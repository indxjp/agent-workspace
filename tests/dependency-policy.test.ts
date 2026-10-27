/**
 * The pinning policy as a gate: exact versions, one version per third-party package.
 *
 * `.npmrc`'s `save-exact` only shapes `pnpm add`; a hand edit or a Dependabot PR bypasses it, and
 * one package bumped in only some manifests silently puts a second copy in the lockfile. Every
 * workspace manifest is discovered from the globs of `pnpm-workspace.yaml`, never listed.
 * `peerDependencies` are ranges by design and are not read.
 */
import { globSync, readFileSync } from 'node:fs';
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

/**
 * The `packages:` list of `pnpm-workspace.yaml`. Only a plain list of positive globs is
 * understood; anything else throws rather than silently checking fewer manifests.
 */
function workspaceGlobs(yamlText: string): readonly string[] {
  const lines = yamlText.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^packages:\s*$/u.test(line));
  if (start === -1) throw new Error('pnpm-workspace.yaml has no `packages:` list');
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    const item = /^\s+-\s+(.+?)\s*$/u.exec(line)?.[1]?.replace(/^(['"])(.*)\1$/u, '$2');
    if (item === undefined) continue;
    if (item.startsWith('!')) throw new Error(`unsupported negated workspace glob: ${item}`);
    globs.push(item);
  }
  if (globs.length === 0) throw new Error('pnpm-workspace.yaml `packages:` list is empty');
  return globs;
}

const globs = workspaceGlobs(readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));

const manifestPaths = [
  'package.json',
  ...globSync(
    globs.map((glob) => `${glob}/package.json`),
    { cwd: repoRoot },
  )
    .map((manifest) => manifest.split(path.sep).join('/'))
    .sort(),
];

interface Entry {
  readonly manifest: string;
  readonly name: string;
  readonly specifier: string;
}

/** The package a declaration installs and its version: `foo: npm:bar@1` installs `bar` at `1`. */
function resolveSpecifier(name: string, specifier: string): { name: string; version: string } {
  const alias = /^npm:(@?[^@]+)@(.*)$/u.exec(specifier);
  return alias?.[1] === undefined || alias[2] === undefined
    ? { name, version: specifier }
    : { name: alias[1], version: alias[2] };
}

/** One line per resolved package that is declared at more than one version. */
function splitVersions(declared: readonly Pick<Entry, 'name' | 'specifier'>[]): string[] {
  const byName = new Map<string, Set<string>>();
  for (const { name, specifier } of declared) {
    const resolved = resolveSpecifier(name, specifier);
    byName.set(
      resolved.name,
      (byName.get(resolved.name) ?? new Set<string>()).add(resolved.version),
    );
  }
  return [...byName]
    .filter(([, versions]) => versions.size > 1)
    .map(([name, versions]) => `${name} ${[...versions].join(' ')}`);
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
        ({ name, specifier }) =>
          !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(resolveSpecifier(name, specifier).version),
      )
      .map(({ manifest, name, specifier }) => `${manifest} ${name} ${specifier}`);
    expect(offenders).toStrictEqual([]);
  });

  it('declares each third-party package at one version', () => {
    expect(splitVersions(entries)).toStrictEqual([]);
  });

  it('groups by the package an npm: alias installs, not by the declared key', () => {
    expect(
      splitVersions([
        { name: 'foo', specifier: 'npm:bar@1.0.0' },
        { name: 'bar', specifier: '2.0.0' },
      ]),
    ).toStrictEqual(['bar 1.0.0 2.0.0']);
    expect(
      splitVersions([
        { name: 'foo', specifier: 'npm:@scope/x@1.0.0' },
        { name: '@scope/x', specifier: '2.0.0' },
      ]),
    ).toStrictEqual(['@scope/x 1.0.0 2.0.0']);
    expect(
      splitVersions([
        { name: 'foo', specifier: 'npm:bar@1.0.0' },
        { name: 'baz', specifier: 'npm:bar@1.0.0' },
      ]),
    ).toStrictEqual([]);
  });
});

describe('workspace discovery', () => {
  it('reads the globs of pnpm-workspace.yaml', () => {
    const yamlText = "packages:\n  - apps/*\n  - 'tools/*'\n\noverrides:\n  - x\n";
    expect(workspaceGlobs(yamlText)).toStrictEqual(['apps/*', 'tools/*']);
  });

  it('rejects a negated or missing list instead of checking fewer manifests', () => {
    expect(() => workspaceGlobs('packages:\n  - apps/*\n  - "!apps/old"\n')).toThrow(/negated/u);
    expect(() => workspaceGlobs('packages:\noverrides:\n  x: 1\n')).toThrow(/empty/u);
    expect(() => workspaceGlobs('overrides:\n  x: 1\n')).toThrow(/no `packages:`/u);
  });

  it('finds a manifest for every glob of the real workspace file', () => {
    for (const glob of globs) {
      expect(globSync(`${glob}/package.json`, { cwd: repoRoot }).length, glob).toBeGreaterThan(0);
    }
    expect(manifestPaths).toEqual(
      expect.arrayContaining([
        'package.json',
        'apps/web/package.json',
        'packages/core/package.json',
      ]),
    );
  });
});
