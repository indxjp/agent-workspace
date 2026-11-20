/**
 * The checker behind `pnpm test-inputs:check` (scripts/policy-check-test-inputs.mjs), on fixture
 * repositories. The real tree is checked by the command itself, in check:fast and CI's static
 * checks — not here: this file belongs to the `tests` project, whose Nx inputs do not (and should
 * not) include every other project's files, so a result computed here would be replayed from the
 * cache after a change it never saw.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectedFiles,
  expandInputs,
  globsCover,
  repositoryPathOf,
  scanSource,
  uncoveredReads,
  workspaceProjects,
} from '../scripts/policy-check-test-inputs.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'test-inputs-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

const TOP_LEVEL = new Set(['manuals', 'packages', 'scripts', 'package.json', '.config']);

describe('repositoryPathOf', () => {
  it('names a path whose first segment is a top-level entry, cut at its first wildcard', () => {
    expect(repositoryPathOf('manuals/adr/0001.md', TOP_LEVEL)).toBe('manuals/adr/0001.md');
    expect(repositoryPathOf('./manuals/fixture-adr/', TOP_LEVEL)).toBe('manuals/fixture-adr');
    expect(repositoryPathOf('manuals/fixture-site/**/*.mdx', TOP_LEVEL)).toBe(
      'manuals/fixture-site',
    );
    expect(repositoryPathOf('.config/fixture/ci.yml', TOP_LEVEL)).toBe('.config/fixture/ci.yml');
  });

  it('takes a bare top-level name; the scan drops it when it names a directory (uncoveredReads)', () => {
    expect(repositoryPathOf('package.json', TOP_LEVEL)).toBe('package.json');
    expect(repositoryPathOf('manuals', TOP_LEVEL)).toBe('manuals');
  });

  it('ignores URLs, prose and paths outside the repository', () => {
    expect(repositoryPathOf('https://manuals/x', TOP_LEVEL)).toBeNull();
    expect(repositoryPathOf('manuals are good', TOP_LEVEL)).toBeNull();
    expect(repositoryPathOf('src/index.ts', TOP_LEVEL)).toBeNull();
  });
});

describe('scanSource', () => {
  it('reports imports, import.meta.url-relative URLs, join() literals and path strings', () => {
    const file = '/repo/tests/x/a.test.ts';
    const references = scanSource(
      file,
      [
        "import { a } from './a.js';",
        "export * from '../b.js';",
        "import pkg from 'vitest';",
        "const lazy = () => import('./lazy.js');",
        "const here = new URL('./data.json', import.meta.url);",
        "const adr = path.join(root, 'manuals', 'fixture-adr');",
        "const site = 'manuals/fixture-site/index.mdx';",
        'const dynamic = `manuals/notes/${name}.md`;',
      ].join('\n'),
      TOP_LEVEL,
    );
    expect(references.map(({ kind, path: target }) => `${kind} ${target}`)).toEqual([
      'import /repo/tests/x/a.js',
      'import /repo/tests/b.js',
      'package vitest',
      'import /repo/tests/x/lazy.js',
      'read /repo/tests/x/data.json',
      'read manuals/fixture-adr',
      'read manuals/fixture-site/index.mdx',
      'read manuals/notes',
    ]);
  });
});

describe('scanSource on a bare top-level name', () => {
  it('counts it as a path when it is passed straight to a call, and not in a title or an assertion', () => {
    const references = scanSource(
      '/repo/tests/a.test.ts',
      [
        "const files = tracked('manuals', 'scripts');",
        "describe('manuals', () => {});",
        "expect(name).toBe('scripts');",
        "const word = 'manuals';",
      ].join('\n'),
      TOP_LEVEL,
    );
    expect(references.map(({ path: target, bare }) => `${target} ${String(bare)}`)).toEqual([
      'manuals false',
      'scripts false',
      'manuals true',
      'scripts true',
      'manuals true',
    ]);
  });
});

describe('globsCover', () => {
  it('matches dot directories the way Nx does, and honours negations', () => {
    const inputs = expandInputs(
      ['{projectRoot}/**/*', '{workspaceRoot}/packages/**/*', '!{workspaceRoot}/packages/x/**/*'],
      {},
      'tests/p',
    );
    expect(globsCover(inputs, 'packages/a/.github/ci.yml', false)).toBe(true);
    expect(globsCover(inputs, 'packages/x/src/a.ts', false)).toBe(false);
    expect(globsCover(inputs, 'tests/p/fixtures', true)).toBe(true);
    expect(globsCover(inputs, 'manuals', true)).toBe(false);
  });

  it('expands named inputs and notes a dependency input', () => {
    const inputs = expandInputs(['default', '^default'], { default: ['{projectRoot}/**/*'] }, 'a');
    expect(inputs).toEqual({ globs: ['a/**/*'], negated: [], dependencyInputs: true });
  });
});

describe('collectedFiles', () => {
  it('applies include under the Vitest root, then exclude and node_modules', () => {
    const root = fixture({
      'tests/a.test.ts': '',
      'tests/nested/b.test.ts': '',
      'tests/node_modules/c.test.ts': '',
      'tests/helper.ts': '',
    });
    expect(
      collectedFiles(root, { root: 'tests', include: ['**/*.test.ts'], exclude: ['nested/**'] }),
    ).toEqual(['tests/a.test.ts']);
  });
});

describe('uncoveredReads', () => {
  const files = {
    'package.json': JSON.stringify({ name: 'root' }),
    'docs/guide.md': '# guide',
    'scripts/helper.mjs': "export const guide = 'docs/guide.md';\n",
    'packages/lib/package.json': JSON.stringify({ name: 'lib' }),
    'packages/lib/src/index.ts': 'export const one = 1;\n',
    'packages/lib/data/table.json': '{}',
    'tests/p/project.json': JSON.stringify({ name: 'tests-p' }),
    'tests/p/a.test.ts': [
      "import { guide } from '../../scripts/helper.mjs';",
      "import { one } from '../../packages/lib/src/index.js';",
      '',
    ].join('\n'),
    'tests/p/b.test.ts': "const table = 'packages/lib/data/table.json';\nconst word = 'docs';\n",
  };

  function check(root: string, inputs: readonly string[], implicitDependencies: string[]) {
    return uncoveredReads({
      repoRoot: root,
      project: {
        name: 'tests-p',
        projectRoot: 'tests/p',
        testFiles: ['tests/p/a.test.ts', 'tests/p/b.test.ts'],
        inputs: expandInputs(inputs, {}, 'tests/p'),
        implicitDependencies,
      },
      projects: workspaceProjects(root),
      topLevel: new Set(['docs', 'packages', 'scripts', 'tests', 'package.json']),
    }).map(({ read, reason }) => `${read.path}: ${reason.split(' — ')[0] ?? ''}`);
  }

  it('reports every read the inputs miss, and why', () => {
    const root = fixture(files);
    expect(check(root, ['{projectRoot}/**/*'], [])).toEqual([
      expect.stringMatching(/^scripts\/helper\.mjs: imports a file the root project owns/u),
      expect.stringMatching(/^packages\/lib\/src\/index\.ts: imports lib/u),
      expect.stringMatching(
        /^packages\/lib\/data\/table\.json: reads lib without a declared input/u,
      ),
      'docs/guide.md: a root-project path not declared as an input',
    ]);
  });

  it('passes once each read is declared: root files by path, package imports through ^default', () => {
    const root = fixture(files);
    expect(
      check(
        root,
        [
          '{projectRoot}/**/*',
          '^default',
          '{workspaceRoot}/scripts/helper.mjs',
          '{workspaceRoot}/docs/guide.md',
          '{workspaceRoot}/packages/lib/data/**/*',
        ],
        ['!root'],
      ),
    ).toEqual([]);
  });

  it('counts a package import as an Nx edge only from a file under the project root', () => {
    const root = fixture({
      ...files,
      'tests/helper.ts': "import { one } from 'lib';\nexport const two = one + 1;\n",
      'tests/p/a.test.ts': [
        "import { one } from 'lib/sub';",
        "import { two } from '../helper.js';",
        '',
      ].join('\n'),
      'tests/p/b.test.ts': '',
      'tests/project.json': JSON.stringify({ name: 'tests' }),
    });
    const inputs = ['{projectRoot}/**/*', '^default', '{workspaceRoot}/tests/helper.ts'];
    // The test file's own import is this project's edge; the helper's is the `tests` project's.
    expect(check(root, inputs, ['!root', '!tests'])).toEqual([
      expect.stringMatching(
        /^packages\/lib: imports lib from tests\/helper\.ts, which another project owns/u,
      ),
    ]);
    expect(check(root, inputs, ['!root', '!tests', 'lib'])).toEqual([]);
  });

  it('accepts a read of a package through an implicit dependency, which ^default then hashes', () => {
    const root = fixture(files);
    expect(
      check(
        root,
        [
          '{projectRoot}/**/*',
          '^default',
          '{workspaceRoot}/scripts/helper.mjs',
          '{workspaceRoot}/docs/guide.md',
        ],
        ['!root', 'lib'],
      ),
    ).toEqual([]);
  });
});
