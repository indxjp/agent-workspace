/**
 * The use cases' handwritten budget (SSOT §4, README.md): every `use-cases/<slug>/` stays within
 * its archetype's budget (QA 40; RV, TR, RP, DR, AC 80; AN 150), counted by the counter the apps
 * benchmark uses (`tests/apps/handwritten.ts`) with the rules in `kit/budget.ts`. The archetype is
 * the generator's `project:<archetype>` entry in the use case's `aw-generated.json`.
 *
 * The fixtures are built in a temporary `use-cases/` tree by the real generator (`kit/generate.ts`),
 * so the real tree holds only real use cases.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseGeneratedManifest } from '@indx-workspace/sdk/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ARCHETYPE_BUDGETS } from './kit/archetypes.ts';
import { archetypeOf, budgetProblems, isSkippedInUseCase, measureUseCase } from './kit/budget.ts';
import { generateUseCase } from './kit/generate.ts';

/** Folders of `use-cases/` that are not a use case (layout.test.ts). */
const WORKSPACE_FOLDERS = new Set(['kit', 'templates', 'node_modules', 'coverage']);

function useCaseDirs(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !WORKSPACE_FOLDERS.has(entry.name) &&
        existsSync(path.join(root, entry.name, 'agent-workspace.yaml')),
    )
    .map((entry) => path.join(root, entry.name))
    .sort();
}

describe('the use cases benchmark', () => {
  it('keeps every use case within its archetype budget', async () => {
    const problems: string[] = [];
    for (const dir of useCaseDirs(import.meta.dirname)) {
      problems.push(...budgetProblems(await measureUseCase(dir)));
    }
    expect(problems).toEqual([]);
    // Measures every committed use case's import graph from disk: it grows with each new use case.
  }, 60_000);

  it('has the budgets of SSOT §4', () => {
    expect(ARCHETYPE_BUDGETS).toEqual({
      QA: 40,
      RV: 80,
      TR: 80,
      RP: 80,
      DR: 80,
      AC: 80,
      AN: 150,
    });
  });
});

describe('the budget on a generated fixture', () => {
  let root = '';
  let useCases = '';
  const template = {
    'agent-workspace.yaml': 'apiVersion: agentworkspace.dev/v2\nkind: Project\nname: __slug__\n',
    'agents/__slug__.ts': "export default { name: '__slug__' };\n",
    'agents/__slug__.md': '# __slug__\n',
    'evals/__slug__.yaml': 'cases: []\n',
    '__slug__.test.ts': "import './agents/__slug__.ts';\n",
  };
  const lines = (count: number): string =>
    Array.from({ length: count }, (_, at) => `export const v${String(at)} = ${String(at)};`).join(
      '\n',
    );

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'use-cases-benchmark-'));
    useCases = path.join(root, 'use-cases');
    for (const [file, text] of Object.entries(template)) {
      await mkdir(path.dirname(path.join(useCases, 'templates', 'qa', file)), { recursive: true });
      await writeFile(path.join(useCases, 'templates', 'qa', file), text);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const generated = async (slug: string): Promise<string> => {
    await generateUseCase({ useCasesDir: useCases, archetype: 'QA', slug });
    return path.join(useCases, slug);
  };

  it('writes the template with the slug and records it as project:qa', async () => {
    const files = await generateUseCase({ useCasesDir: useCases, archetype: 'qa', slug: 'nda' });
    expect(files).toEqual([
      'agent-workspace.yaml',
      'agents/nda.md',
      'agents/nda.ts',
      'evals/nda.yaml',
      'nda.test.ts',
    ]);
    const dir = path.join(useCases, 'nda');
    expect(await readFile(path.join(dir, 'agents/nda.ts'), 'utf8')).toBe(
      "export default { name: 'nda' };\n",
    );
    const manifest = parseGeneratedManifest(
      await readFile(path.join(dir, 'aw-generated.json'), 'utf8'),
    );
    expect(Object.keys(manifest.entries)).toEqual(['project:qa']);
    expect(archetypeOf(manifest)).toBe('QA');
  });

  it('counts nothing of an unedited copy of its template', async () => {
    const measure = await measureUseCase(await generated('policy-qa'));
    expect(measure).toMatchObject({ slug: 'policy-qa', archetype: 'QA', budget: 40, lines: 0 });
    expect(budgetProblems(measure)).toEqual([]);
  });

  it('counts an edited generated file in full and a new script, and passes within budget', async () => {
    const dir = await generated('faq-bot');
    await writeFile(path.join(dir, 'agents/faq-bot.ts'), `${lines(3)}\n`);
    await mkdir(path.join(dir, 'skills/x/scripts'), { recursive: true });
    await writeFile(path.join(dir, 'skills/x/scripts/x.mjs'), `// note\n${lines(2)}\n`);
    await writeFile(path.join(dir, 'skills/x/SKILL.md'), `${lines(100)}\n`);
    const measure = await measureUseCase(dir);
    expect(measure.files).toEqual([
      { file: 'agents/faq-bot.ts', lines: 3 },
      { file: 'skills/x/scripts/x.mjs', lines: 2 },
    ]);
    expect(budgetProblems(measure)).toEqual([]);
  });

  it('fails a use case over its budget, naming its files', async () => {
    const dir = await generated('glossary');
    await mkdir(path.join(dir, 'skills/x/scripts'), { recursive: true });
    await writeFile(path.join(dir, 'skills/x/scripts/big.mjs'), `${lines(41)}\n`);
    expect(budgetProblems(await measureUseCase(dir))).toEqual([
      'glossary: 41 handwritten lines, over the QA budget of 40 (skills/x/scripts/big.mjs 41)',
    ]);
  });

  it('counts a handwritten file whose hash the entry wrote into its own manifest', async () => {
    const dir = await generated('expense');
    const big = `${lines(50)}\n`;
    await writeFile(path.join(dir, 'agents/helper.ts'), big);
    const manifest = JSON.parse(await readFile(path.join(dir, 'aw-generated.json'), 'utf8')) as {
      entries: Record<string, { files: Record<string, string> }>;
    };
    const entry = manifest.entries['project:qa'];
    if (entry === undefined) throw new Error('no project:qa entry');
    entry.files['agents/helper.ts'] = createHash('sha256').update(big).digest('hex');
    await writeFile(path.join(dir, 'aw-generated.json'), JSON.stringify(manifest));
    const measure = await measureUseCase(dir);
    expect(measure.files).toEqual([{ file: 'agents/helper.ts', lines: 50 }]);
    expect(budgetProblems(measure)).toEqual([
      'expense: 50 handwritten lines, over the QA budget of 40 (agents/helper.ts 50)',
      'expense: aw-generated.json records agents/helper.ts, which its template does not make so',
    ]);
  });

  it('refuses a manifest entry or edit the use-case generator never writes', async () => {
    const dir = await generated('invoice');
    const sha = createHash('sha256').update('x').digest('hex');
    await writeFile(
      path.join(dir, 'aw-generated.json'),
      JSON.stringify({
        version: 1,
        entries: {
          'project:qa': { files: {}, edits: [{ path: 'agents/invoice.ts', added: 'x' }] },
          'agent:extra': { files: { 'agents/extra.ts': sha }, edits: [] },
        },
      }),
    );
    expect((await measureUseCase(dir)).problems).toEqual([
      'aw-generated.json holds agent:extra, which the use-case generator never writes',
      'aw-generated.json records an edit of agents/invoice.ts, which the generator never makes',
    ]);
  });

  it('skips nothing as generated for an archetype with no template yet', async () => {
    const dir = path.join(useCases, 'budget');
    await mkdir(path.join(dir, 'agents'), { recursive: true });
    await writeFile(path.join(dir, 'agent-workspace.yaml'), 'name: budget\n');
    await writeFile(path.join(dir, 'agents/budget.ts'), `${lines(2)}\n`);
    const sha = createHash('sha256')
      .update(`${lines(2)}\n`)
      .digest('hex');
    await writeFile(
      path.join(dir, 'aw-generated.json'),
      JSON.stringify({
        version: 1,
        entries: { 'project:an': { files: { 'agents/budget.ts': sha }, edits: [] } },
      }),
    );
    const measure = await measureUseCase(dir);
    expect(measure).toMatchObject({ archetype: 'AN', budget: 150, lines: 3 });
    expect(measure.problems).toEqual([
      'aw-generated.json records agents/budget.ts, which its template does not make so',
    ]);
  });

  it('counts every file a production file imports, wherever it is, transitively', async () => {
    const dir = await generated('newcomer');
    await mkdir(path.join(useCases, 'shared/lib'), { recursive: true });
    await writeFile(path.join(useCases, 'shared/a.ts'), "import './b.js';\nexport const a = 1;\n");
    await writeFile(path.join(useCases, 'shared/b.ts'), "import './lib';\nexport const b = 2;\n");
    await writeFile(path.join(useCases, 'shared/lib/index.mts'), 'export const c = 3;\n');
    await writeFile(path.join(useCases, 'shared/types.d.ts'), 'export type T = string;\n');
    await writeFile(path.join(useCases, 'shared/table.json'), '{"a": 1}\n');
    await writeFile(
      path.join(dir, 'agents/newcomer.ts'),
      [
        "import { a } from '../../shared/a.ts';",
        "import './local.ts';",
        "import type { T } from '../../shared/types.d.ts';",
        "import table from '../../shared/table.json' with { type: 'json' };",
        "import { readFile } from 'node:fs';",
        'export default { a, readFile, table } satisfies Record<string, unknown> as T | object;',
        '',
      ].join('\n'),
    );
    await writeFile(path.join(dir, 'agents/local.ts'), "import '../../shared/a.ts';\n");
    const measure = await measureUseCase(dir);
    expect(measure.files).toEqual([
      { file: 'agents/local.ts', lines: 1 },
      { file: 'agents/newcomer.ts', lines: 6 },
      { file: '../shared/a.ts', lines: 2 },
      { file: '../shared/b.ts', lines: 2 },
      { file: '../shared/lib/index.mts', lines: 1 },
    ]);
    expect(measure.problems).toEqual([]);
  });

  it('counts and refuses a production import of data/ code or test support', async () => {
    const dir = await generated('announce');
    await mkdir(path.join(dir, 'data/ja'), { recursive: true });
    await writeFile(path.join(dir, 'data/ja/hidden.mjs'), `${lines(30)}\n`);
    await writeFile(path.join(dir, 'announce.fixture.test-support.ts'), `${lines(30)}\n`);
    await writeFile(
      path.join(dir, 'agents/announce.ts'),
      "import '../data/ja/hidden.mjs';\nimport '../announce.fixture.test-support.ts';\n",
    );
    const measure = await measureUseCase(dir);
    expect(measure.files).toEqual([
      { file: 'agents/announce.ts', lines: 2 },
      { file: 'data/ja/hidden.mjs', lines: 30 },
      { file: 'announce.fixture.test-support.ts', lines: 30 },
    ]);
    expect(measure.problems).toEqual([
      'agents/announce.ts: imports data/ja/hidden.mjs; production code may not import data/ code or tests',
      'agents/announce.ts: imports announce.fixture.test-support.ts; production code may not import data/ code or tests',
    ]);
  });

  it('lets production code import JSON under data/, uncounted, and still refuses TypeScript there', async () => {
    const dir = await generated('patent-map');
    await mkdir(path.join(dir, 'data/snapshot'), { recursive: true });
    await writeFile(
      path.join(dir, 'data/snapshot/items.json'),
      `{\n${'  "a": 1,\n'.repeat(40)}  "b": 2\n}\n`,
    );
    await writeFile(path.join(dir, 'data/snapshot/helper.ts'), `${lines(10)}\n`);
    await writeFile(
      path.join(dir, 'agents/patent-map.ts'),
      "import items from '../data/snapshot/items.json' with { type: 'json' };\nexport default items;\n",
    );
    const allowed = await measureUseCase(dir);
    expect(allowed.files).toEqual([{ file: 'agents/patent-map.ts', lines: 2 }]);
    expect(allowed.problems).toEqual([]);

    await writeFile(
      path.join(dir, 'agents/patent-map.ts'),
      "import '../data/snapshot/helper.ts';\nimport items from '../data/snapshot/items.json' with { type: 'json' };\nexport default items;\n",
    );
    const refused = await measureUseCase(dir);
    expect(refused.files).toEqual([
      { file: 'agents/patent-map.ts', lines: 3 },
      { file: 'data/snapshot/helper.ts', lines: 10 },
    ]);
    expect(refused.problems).toEqual([
      'agents/patent-map.ts: imports data/snapshot/helper.ts; production code may not import data/ code or tests',
    ]);

    // Only JSON is data: WebAssembly, a native addon, JSON5 or text under data/ is refused too.
    for (const file of ['blob.wasm', 'addon.node', 'items.json5', 'notes.txt']) {
      await writeFile(path.join(dir, 'data/snapshot', file), 'x\n');
    }
    await writeFile(
      path.join(dir, 'agents/patent-map.ts'),
      [
        "import '../data/snapshot/blob.wasm';",
        "import '../data/snapshot/addon.node';",
        "import '../data/snapshot/items.json5';",
        "import '../data/snapshot/notes.txt';",
        '',
      ].join('\n'),
    );
    expect((await measureUseCase(dir)).problems).toEqual(
      ['blob.wasm', 'addon.node', 'items.json5', 'notes.txt'].map(
        (file) =>
          `agents/patent-map.ts: imports data/snapshot/${file}; production code may not import data/ code or tests`,
      ),
    );
  });

  it('fails an unresolved relative import, a subpath import and an absolute one', async () => {
    const dir = await generated('handover');
    await writeFile(
      path.join(dir, 'agents/handover.ts'),
      "import './missing.ts';\nimport '#internal/x';\nimport '/etc/x.mjs';\n",
    );
    expect((await measureUseCase(dir)).problems).toEqual([
      'agents/handover.ts: cannot resolve ./missing.ts',
      'agents/handover.ts: imports #internal/x, which the budget cannot follow',
      'agents/handover.ts: imports /etc/x.mjs, which the budget cannot follow',
    ]);
  });

  it('resolves like TypeScript: .js to .ts or .tsx, .mjs to .mts, .cjs to .cts, a folder index', async () => {
    const dir = await generated('decision-log');
    await mkdir(path.join(dir, 'lib/dir'), { recursive: true });
    await writeFile(path.join(dir, 'lib/a.tsx'), 'export const a = 1;\n');
    await writeFile(path.join(dir, 'lib/b.mts'), 'export const b = 1;\n');
    await writeFile(path.join(dir, 'lib/c.cts'), 'export const c = 1;\n');
    await writeFile(path.join(dir, 'lib/dir/index.ts'), 'export const d = 1;\n');
    await writeFile(path.join(dir, 'lib/e.jsx'), 'export const e = 1;\n');
    await writeFile(
      path.join(dir, 'agents/decision-log.ts'),
      "import '../lib/a.js';\nimport '../lib/b.mjs';\nimport '../lib/c.cjs';\nimport '../lib/dir';\nimport '../lib/e';\n",
    );
    // Every import resolves; the .cts it reaches is then refused as a script coverage cannot measure.
    expect((await measureUseCase(dir)).problems).toEqual([
      'lib/c.cts: the coverage gate cannot measure this script; write it in JavaScript or TypeScript',
    ]);
  });

  it('counts every file but what is not code, and refuses a script coverage cannot measure', async () => {
    const dir = await generated('tests');
    await mkdir(path.join(dir, 'skills/x/scripts'), { recursive: true });
    for (const file of ['a.cjs', 'b.mts', 'c.cts', 'd.sh', 'e.py', 'run', 'a.test.mjs']) {
      await writeFile(path.join(dir, 'skills/x/scripts', file), 'x\n');
    }
    await mkdir(path.join(dir, 'tools'), { recursive: true });
    await writeFile(path.join(dir, 'tools/build.sh'), 'x\n');
    await writeFile(path.join(dir, 'skills/x/package.json'), '{}\n');
    const measure = await measureUseCase(dir);
    expect(measure.files.map(({ file }) => file)).toEqual([
      'skills/x/package.json',
      'skills/x/scripts/a.cjs',
      'skills/x/scripts/b.mts',
      'skills/x/scripts/c.cts',
      'skills/x/scripts/d.sh',
      'skills/x/scripts/e.py',
      'skills/x/scripts/run',
      'tools/build.sh',
    ]);
    expect(measure.problems).toEqual([
      'skills/x/scripts/c.cts: a skill script must be JavaScript or TypeScript the coverage gate measures',
      'skills/x/scripts/d.sh: a skill script must be JavaScript or TypeScript the coverage gate measures',
      'skills/x/scripts/e.py: a skill script must be JavaScript or TypeScript the coverage gate measures',
      'skills/x/scripts/run: a skill script must be JavaScript or TypeScript the coverage gate measures',
      'tools/build.sh: the coverage gate cannot measure this script; write it in JavaScript or TypeScript',
    ]);
  });

  it('refuses a use case whose aw-generated.json names no archetype', async () => {
    const dir = path.join(useCases, 'handwritten');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'agent-workspace.yaml'), 'name: handwritten\n');
    const measure = await measureUseCase(dir);
    expect(measure).toMatchObject({ archetype: null, budget: null, lines: 1 });
    expect(budgetProblems(measure)).toEqual([
      'handwritten: aw-generated.json names no archetype (one project:<qa|rv|tr|rp|dr|ac|an> entry)',
    ]);
  });

  it('reads no archetype from a manifest with none, two, or an unknown code', () => {
    const manifest = (keys: readonly string[]) =>
      parseGeneratedManifest(
        JSON.stringify({
          version: 1,
          entries: Object.fromEntries(keys.map((key) => [key, { files: {}, edits: [] }])),
        }),
      );
    expect(archetypeOf(manifest(['project:an', 'agent:x']))).toBe('AN');
    expect(archetypeOf(manifest([]))).toBeNull();
    expect(archetypeOf(manifest(['project:qa', 'project:rv']))).toBeNull();
    expect(archetypeOf(manifest(['project:zz']))).toBeNull();
    expect(archetypeOf(manifest(['agent:qa']))).toBeNull();
  });

  it('leaves out only what is not code: Markdown, eval YAML, data, tests', () => {
    for (const file of [
      'agent-workspace.yaml',
      'agents/nda.ts',
      'surfaces/main.tsx',
      'skills/x/scripts/a.mjs',
      'skills/x/scripts/a.py',
      'evals/helper.ts',
      'types.d.ts',
      'skills/x/package.json',
      'other.yaml',
    ]) {
      expect(isSkippedInUseCase(file), file).toBe(false);
    }
    for (const file of [
      'README.md',
      'agents/nda.md',
      'evals/nda.yaml',
      'data/ja/a.ts',
      'skills/x/data/a.mjs',
      'nda.test.ts',
      'nda.fixture.test-support.ts',
      'node_modules/x/index.js',
    ]) {
      expect(isSkippedInUseCase(file), file).toBe(true);
    }
  });

  it('refuses an unknown archetype, a bad slug, a missing template and an existing folder', async () => {
    await expect(
      generateUseCase({ useCasesDir: useCases, archetype: 'XX', slug: 'a' }),
    ).rejects.toThrow('unknown archetype XX; one of QA, RV, TR, RP, DR, AC, AN');
    await expect(
      generateUseCase({ useCasesDir: useCases, archetype: 'QA', slug: 'Bad_Slug' }),
    ).rejects.toThrow('Bad_Slug is not a kebab-case catalog slug');
    await expect(
      generateUseCase({ useCasesDir: useCases, archetype: 'AN', slug: 'cash' }),
    ).rejects.toThrow('no template templates/an');
    await expect(
      generateUseCase({ useCasesDir: useCases, archetype: 'QA', slug: 'nda' }),
    ).rejects.toThrow('nda already exists');
  });

  it('refuses a symbolic link inside a use case, which would escape the count and coverage', async () => {
    const dir = await generated('kyt');
    await mkdir(path.join(dir, 'data'), { recursive: true });
    await writeFile(path.join(dir, 'data/tool.mjs'), `${lines(60)}\n`);
    await mkdir(path.join(dir, 'skills/s/scripts'), { recursive: true });
    await symlink('../../../data/tool.mjs', path.join(dir, 'skills/s/scripts/run.mjs'));
    const measure = await measureUseCase(dir);
    expect(measure.problems).toEqual([
      'skills/s/scripts/run.mjs: a symbolic link; a use case holds its own files',
    ]);
    expect(budgetProblems(measure)).toContain(
      'kyt: skills/s/scripts/run.mjs: a symbolic link; a use case holds its own files',
    );
  });
});
