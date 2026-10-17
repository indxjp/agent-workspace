import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { renderProjectShell } from './render.js';

/** The repository root as a filesystem path; see `consumer.test.ts` for why not `node:url`. */
function repositoryRoot(): string {
  const pathname = decodeURIComponent(new URL('../../../../', import.meta.url).pathname);
  return /^\/[A-Za-z]:\//u.test(pathname) ? pathname.slice(1) : pathname;
}

function readYaml(path: string): unknown {
  const text = ts.sys.readFile(`${repositoryRoot()}${path}`);
  if (text === undefined) throw new Error(`cannot read ${path}`);
  return parse(text);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`${what} is not a mapping`);
  return value;
}

/** The answers of an `allowBuilds:` block. */
function allowBuildsOf(document: unknown, what: string): ReadonlyMap<string, boolean> {
  const entries = Object.entries(record(record(document, what)['allowBuilds'], what));
  return new Map(
    entries.map(([name, allowed]) => {
      if (typeof allowed !== 'boolean') throw new Error(`${what}: ${name} is not answered`);
      return [name, allowed] as const;
    }),
  );
}

/** `a/b/../c` → `a/c`. */
function normalise(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '.' && segment !== '') segments.push(segment);
  }
  return segments.join('/');
}

/**
 * Every package name the runtime installs: from `packages/embedded`, its dependencies and optional
 * dependencies (not dev), followed through workspace links and the lockfile's snapshots.
 */
function runtimeTree(): ReadonlySet<string> {
  const lock = record(readYaml('pnpm-lock.yaml'), 'pnpm-lock.yaml');
  const importers = record(lock['importers'], 'importers');
  const snapshots = record(lock['snapshots'], 'snapshots');
  const names = new Set<string>();
  const visited = new Set<string>();

  const follow = (node: unknown, importerPath: string | undefined): void => {
    if (!isRecord(node)) return;
    for (const field of ['dependencies', 'optionalDependencies']) {
      const dependencies = node[field];
      if (!isRecord(dependencies)) continue;
      for (const [name, entry] of Object.entries(dependencies)) {
        // An importer lists `{ specifier, version }`; a snapshot lists the version alone.
        const version = isRecord(entry) ? entry['version'] : entry;
        if (typeof version !== 'string') throw new Error(`${name} has no version`);
        if (version.startsWith('link:')) {
          if (importerPath === undefined) throw new Error(`${name} links from a snapshot`);
          visitImporter(normalise(`${importerPath}/${version.slice('link:'.length)}`));
          continue;
        }
        // `1.0.0(peer@2.0.0)` carries peer suffixes; an npm alias's version is itself
        // `real-name@1.0.0`, and is then the whole snapshot key.
        const [base = version] = version.split('(');
        const aliased = base.lastIndexOf('@') > 0;
        names.add(aliased ? base.slice(0, base.lastIndexOf('@')) : name);
        const key = aliased ? version : `${name}@${version}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (!(key in snapshots)) throw new Error(`no snapshot ${key}`);
        follow(snapshots[key], undefined);
      }
    }
  };
  const visitImporter = (path: string): void => {
    if (visited.has(`importer:${path}`)) return;
    visited.add(`importer:${path}`);
    if (!(path in importers)) throw new Error(`no importer ${path}`);
    follow(importers[path], path);
  };

  // Every package the shell pins is installed with its whole tree, so each one is walked.
  for (const importer of ['packages/aw', 'packages/embedded', 'packages/sdk']) {
    visitImporter(importer);
  }
  return names;
}

describe("the starter project's install-script answers", () => {
  const shell = renderProjectShell({ name: 'my-project', version: '0.3.0', engine: 'pi' });
  const workspace = shell.find((file) => file.path === 'pnpm-workspace.yaml');
  const answers = allowBuildsOf(parse(workspace?.contents ?? ''), 'the shell');
  const root = allowBuildsOf(readYaml('pnpm-workspace.yaml'), 'the root pnpm-workspace.yaml');

  it('answer every install script of the runtime tree as the repository root does', () => {
    const tree = runtimeTree();
    expect(tree.has('embedded-postgres')).toBe(true);
    const expected = [...root].filter(([name]) => tree.has(name));
    expect(expected.length).toBeGreaterThan(0);
    for (const [name, allowed] of expected) {
      expect(answers.get(name), name).toBe(allowed);
    }
  });

  it("carry the same answers in package.json's allowScripts for npm", () => {
    const manifest = shell.find((file) => file.path === 'package.json');
    const parsed: unknown = JSON.parse(manifest?.contents ?? '');
    const scripts = new Map(
      Object.entries(record(record(parsed, 'package.json')['allowScripts'], 'package.json')),
    );
    expect(scripts).toEqual(answers);
    for (const name of ['@embedded-postgres/linux-x64', 'protobufjs', '@google/genai', 'esbuild']) {
      expect(scripts.has(name), name).toBe(true);
    }
  });

  it('answer nothing the repository root does not', () => {
    for (const [name, allowed] of answers) {
      expect(root.get(name), name).toBe(allowed);
    }
  });
});

/** A root `overrides:` key's package name: `@scope/name@>=1 <2` → `@scope/name`. */
function overriddenName(key: string): string {
  const at = key.indexOf('@', 1);
  return at === -1 ? key : key.slice(0, at);
}

describe("the starter project's security overrides (BH061-007)", () => {
  const shell = renderProjectShell({ name: 'my-project', version: '0.3.0', engine: 'pi' });
  const workspace = record(
    parse(shell.find((file) => file.path === 'pnpm-workspace.yaml')?.contents ?? ''),
    'the shell',
  );
  const manifest = record(
    JSON.parse(shell.find((file) => file.path === 'package.json')?.contents ?? ''),
    'package.json',
  );
  const root = record(record(readYaml('pnpm-workspace.yaml'), 'root')['overrides'], 'overrides');

  it('carry every root override that reaches the runtime tree, for pnpm and npm alike', () => {
    const tree = runtimeTree();
    const expected = Object.entries(root).filter(([key]) => tree.has(overriddenName(key)));
    expect(expected.map(([key]) => overriddenName(key))).toContain('undici');
    expect(Object.entries(record(workspace['overrides'], 'the shell overrides'))).toEqual(expected);
    expect(Object.entries(record(manifest['overrides'], 'npm overrides'))).toEqual(expected);
  });
});
