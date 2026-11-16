/**
 * The Under the hood tab's real source (spec "The store app", item 7): for each live entry, a
 * bounded excerpt of its demo agent file and the layout of its source folder, read here from the
 * repository and written to `examples/store/catalog/sources.generated.ts`, because the store may not
 * read outside itself (the No fork cell). `APPS_WRITE=1 pnpm vitest run --project tests tests/store`
 * rewrites the file; without it a stale file fails.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CATALOG, type LiveEntry, type SourceView } from '../../examples/store/catalog/index.ts';
import { SOURCES } from '../../examples/store/catalog/sources.generated.ts';
import { REPOSITORY_ROOT } from '../apps/registry.ts';

const WRITE = process.env['APPS_WRITE'] === '1';
const GENERATED = path.join(REPOSITORY_ROOT, 'examples/store/catalog/sources.generated.ts');

/** The most lines of a demo agent's file the tab shows. */
export const EXCERPT_MAX_LINES = 40;
/** The most entries listed under one directory of the layout. */
const LAYOUT_CHILDREN = 5;
const byName = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** The entries directly under `prefix` among `paths` (relative, tracked), directories marked `/`. */
function childrenOf(paths: readonly string[], prefix: string): string[] {
  const names = new Set<string>();
  for (const file of paths) {
    if (!file.startsWith(prefix)) continue;
    const [head, ...rest] = file.slice(prefix.length).split('/');
    if (head) names.add(rest.length > 0 ? `${head}/` : head);
  }
  return [...names].sort((left, right) =>
    byName(left.replace(/\/$/u, ''), right.replace(/\/$/u, '')),
  );
}

/**
 * The layout of a folder from its tracked files (paths relative to the folder): each directory's
 * first {@link LAYOUT_CHILDREN} entries are indented under it. Untracked and ignored files a local
 * build leaves behind (`next-env.d.ts`, `.env`, `.agent-workspace/`) never appear.
 */
export function layoutFromPaths(paths: readonly string[]): string[] {
  return childrenOf(paths, '').flatMap((name) => {
    if (!name.endsWith('/')) return [name];
    const children = childrenOf(paths, name);
    return [
      name,
      ...children.slice(0, LAYOUT_CHILDREN).map((child) => `  ${child}`),
      ...(children.length > LAYOUT_CHILDREN ? ['  …'] : []),
    ];
  });
}

/** `folder`'s tracked layout, as `git ls-files` lists it. */
export function layoutOf(folder: string): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--', '.'], {
    cwd: folder,
    encoding: 'utf8',
  });
  return layoutFromPaths(listed.split('\0').filter(Boolean));
}

/** The first {@link EXCERPT_MAX_LINES} lines of `text`, and whether there were more. */
export function excerptOf(text: string): { excerpt: string; truncated: boolean } {
  const lines = text.replace(/\s+$/u, '').split('\n');
  return {
    excerpt: lines.slice(0, EXCERPT_MAX_LINES).join('\n'),
    truncated: lines.length > EXCERPT_MAX_LINES,
  };
}

function viewOf(entry: LiveEntry): SourceView {
  const agentFile = `${entry.source}/agents/${entry.demo.agent}.ts`;
  const text = readFileSync(path.join(REPOSITORY_ROOT, agentFile), 'utf8');
  return {
    agentFile,
    ...excerptOf(text),
    layout: layoutOf(path.join(REPOSITORY_ROOT, entry.source)),
  };
}

const liveEntries = CATALOG.filter((entry): entry is LiveEntry => entry.status === 'live');

const HEADER = `// Generated from each live entry's source folder by \`APPS_WRITE=1 pnpm vitest run --project tests tests/store\`.
// Do not edit by hand: tests/store/sources.test.ts fails when it differs from the sources.
`;

function render(views: Readonly<Record<string, SourceView>>): string {
  return `${HEADER}
import type { SourceView } from './define.ts';

/** The real source each live entry's Under the hood tab shows, keyed by the entry's slug. */
export const SOURCES: Readonly<Record<string, SourceView>> = ${JSON.stringify(views, null, 2)};
`;
}

describe('the Under the hood sources', () => {
  const views = Object.fromEntries(liveEntries.map((entry) => [entry.slug, viewOf(entry)]));

  it('examples/store/catalog/sources.generated.ts matches the live entries’ source folders', async () => {
    if (WRITE) await writeFile(GENERATED, render(views));
    expect(
      SOURCES,
      'examples/store/catalog/sources.generated.ts is stale; run with APPS_WRITE=1',
    ).toEqual(views);
  });

  it('holds one view per live entry, with the demo agent in its layout', () => {
    expect(Object.keys(views).sort()).toEqual(liveEntries.map((entry) => entry.slug).sort());
    for (const entry of liveEntries) {
      expect(views[entry.slug]?.layout, entry.slug).toContain('agents/');
    }
  });

  it('bounds each excerpt', () => {
    for (const [slug, view] of Object.entries(views)) {
      expect(view.excerpt.split('\n').length, slug).toBeLessThanOrEqual(EXCERPT_MAX_LINES);
      expect(view.excerpt.length, slug).toBeGreaterThan(0);
    }
    const long = Array.from(
      { length: EXCERPT_MAX_LINES + 5 },
      (_, index) => `line ${String(index)}`,
    ).join('\n');
    expect(excerptOf(long)).toMatchObject({ truncated: true });
    expect(excerptOf('one\ntwo\n')).toEqual({ excerpt: 'one\ntwo', truncated: false });
  });

  it('lays out tracked files only, never an ignored one', () => {
    const tracked = ['package.json', 'agents/a.ts', 'agents/b.ts', 'app/page.tsx'];
    expect(layoutFromPaths(tracked)).toEqual([
      'agents/',
      '  a.ts',
      '  b.ts',
      'app/',
      '  page.tsx',
      'package.json',
    ]);
    for (const view of Object.values(views)) {
      for (const ignored of ['next-env.d.ts', '.env', '.agent-workspace/', 'test-results/']) {
        expect(view.layout).not.toContain(ignored);
      }
    }
  });
});
