/**
 * The apps benchmark's offline cells (issue #1531): for every app under `examples/`, the
 * handwritten lines are within its budget, it imports only published packages, every file the
 * generators recorded is still as they wrote it or counted as handwritten, and every declared
 * verdict names evidence that exists.
 *
 * `examples/README.md` shows the scoreboard between `<!-- apps-benchmark:start -->` and
 * `<!-- apps-benchmark:end -->`. A hand edit that disagrees fails here;
 * `APPS_WRITE=1 pnpm vitest run --project tests tests/apps` rewrites it.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseGeneratedManifest, type GeneratedManifest } from '@indx-workspace/sdk/project';
import { afterAll, describe, expect, it } from 'vitest';

import {
  APP_CELLS,
  countedLines,
  evidenceProblem,
  countHandwritten,
  generatedFileStates,
  importOffenders,
  isExcludedFromCount,
  renderScoreboard,
  scoreApp,
  scoreOf,
  type AppBenchmark,
  type AppScore,
  type HandwrittenCount,
} from './benchmark.ts';
import {
  atScopeVersion,
  differingFiles,
  parseRegenerateArgs,
  PACKED_OVERRIDES_MARK,
  withoutPackedOverrides,
  withPackedOverrides,
} from './regenerate.mjs';
import { LANE_STEPS } from './lane.mjs';
import { EXAMPLES_DIR, loadExampleApps, REPOSITORY_ROOT } from './registry.ts';

const START = '<!-- apps-benchmark:start -->';
const END = '<!-- apps-benchmark:end -->';
const WRITE = process.env['APPS_WRITE'] === '1';
const README = path.join(EXAMPLES_DIR, 'README.md');

/** The reference apps the criterion names, with their handwritten budgets. */
const REFERENCE_APPS: Readonly<Record<string, number>> = {
  'team-chat': 150,
  wiki: 100,
  crm: 200,
  'service-desk': 250,
};

const apps = loadExampleApps();
const temporary: string[] = [];

afterAll(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function manifestOf(appDir: string): Promise<GeneratedManifest> {
  return parseGeneratedManifest(await readFile(path.join(appDir, 'aw-generated.json'), 'utf8'));
}

/** Why a count is over budget, naming every counted file; `undefined` within budget. */
function overBudget(count: HandwrittenCount, budget: number): string | undefined {
  if (count.lines <= budget) return undefined;
  const files = count.files.map(({ file, lines }) => `  ${file}: ${String(lines)}`).join('\n');
  return `${String(count.lines)} handwritten lines, over the budget of ${String(budget)}:\n${files}`;
}

/** A copy of examples/minimal to plant a fixture in. */
async function minimalCopy(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'apps-benchmark-'));
  temporary.push(parent);
  const copy = path.join(parent, 'minimal');
  await cp(path.join(EXAMPLES_DIR, 'minimal'), copy, { recursive: true });
  return copy;
}

async function scoreOfApp(benchmark: AppBenchmark, dir: string): Promise<AppScore> {
  const manifest = await manifestOf(dir);
  return scoreApp(benchmark, {
    handwritten: await countHandwritten(dir, manifest),
    offenders: await importOffenders(dir),
    states: await generatedFileStates(dir, manifest),
  });
}

describe('apps benchmark registry', () => {
  it('registers every examples/ directory holding a benchmark.ts, and only those', async () => {
    const entries = await readdir(EXAMPLES_DIR, { withFileTypes: true });
    const withBenchmark = entries
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(path.join(EXAMPLES_DIR, entry.name, 'benchmark.ts')),
      )
      .map((entry) => entry.name)
      .sort();
    expect(apps.map(({ benchmark }) => benchmark.id).sort()).toStrictEqual(withBenchmark);
    expect(new Set(apps.map(({ benchmark }) => benchmark.order)).size).toBe(apps.length);
  });

  it('the four reference apps are team-chat, wiki, crm, service-desk with budgets 150, 100, 200, 250', () => {
    const reference = apps
      .filter(({ benchmark }) => benchmark.reference)
      .map(({ benchmark }) => benchmark);
    expect(Object.fromEntries(reference.map((b) => [b.id, b.budget]))).toStrictEqual(
      REFERENCE_APPS,
    );
    expect(
      apps.filter(({ benchmark }) => !benchmark.reference).map((app) => app.benchmark.id),
    ).toEqual(['minimal']);
  });
});

describe.each(apps.map((app) => [app.benchmark.id, app] as const))('%s', (id, app) => {
  it('handwritten lines are within budget', async () => {
    const count = await countHandwritten(app.dir, await manifestOf(app.dir));
    expect(overBudget(count, app.benchmark.budget), id).toBeUndefined();
  });

  it('imports only published packages', async () => {
    expect(await importOffenders(app.dir)).toStrictEqual([]);
  });

  it('every manifest file is unedited or counted as handwritten', async () => {
    const manifest = await manifestOf(app.dir);
    const counted = new Set((await countHandwritten(app.dir, manifest)).files.map((f) => f.file));
    const unaccounted = [...(await generatedFileStates(app.dir, manifest))].flatMap(
      ([file, state]) =>
        state === 'unedited' || counted.has(file) || isExcludedFromCount(file)
          ? []
          : [`${file} (${state})`],
    );
    expect(unaccounted).toStrictEqual([]);
  });

  it('takes over only generated files it has edited', async () => {
    const states = await generatedFileStates(app.dir, await manifestOf(app.dir));
    const stale = (app.benchmark.takenOver ?? []).filter((file) => states.get(file) !== 'edited');
    expect(stale, `${id}: takenOver names files that are not edited generated files`).toEqual([]);
  });

  it('names evidence that exists', async () => {
    for (const cell of ['journeys', 'agentOnData', 'selfHost'] as const) {
      const declared = app.benchmark.cells[cell];
      const where = `${id}.${cell}`;
      expect(declared.note.trim(), `${where}: a note`).not.toBe('');
      // Every cell names evidence, a gap too: the lane runs the journey or step a gap names, and
      // a declared Journeys gap excuses exactly that journey and its `alsoExcused` (lane.mjs).
      const file = path.join(REPOSITORY_ROOT, declared.file);
      expect(existsSync(file), `${where}: ${declared.file} does not exist`).toBe(true);
      const text = await readFile(file, 'utf8');
      expect(evidenceProblem(declared, text, LANE_STEPS), where).toBeUndefined();
    }
  });

  it('names further excused journeys only on a Journeys gap, each a journey of its spec', async () => {
    const journeys = app.benchmark.cells.journeys;
    const also = journeys.alsoExcused ?? [];
    if (also.length > 0)
      expect(journeys.verdict, `${id}.journeys: alsoExcused on an ok`).toBe('gap');
    expect(new Set([journeys.ref, ...also]).size, `${id}.journeys: a title named twice`).toBe(
      also.length + 1,
    );
    const text = await readFile(path.join(REPOSITORY_ROOT, journeys.file), 'utf8');
    for (const ref of also) {
      expect(
        evidenceProblem({ ...journeys, ref }, text, LANE_STEPS),
        `${id}.journeys`,
      ).toBeUndefined();
    }
  });
});

describe('the offline cells, on fixtures', () => {
  it('a 1-line handwritten file under budget 0 fails, naming the file', async () => {
    const copy = await minimalCopy();
    await writeFile(path.join(copy, 'app/extra.ts'), "export const extra = 'mine';\n");

    const count = await countHandwritten(copy, await manifestOf(copy));

    expect(count).toStrictEqual({ lines: 1, files: [{ file: 'app/extra.ts', lines: 1 }] });
    expect(overBudget(count, 0)).toContain('  app/extra.ts: 1');
  });

  it('an @agent-workspace/core import fails No fork', async () => {
    const copy = await minimalCopy();
    await writeFile(
      path.join(copy, 'app/planted.ts'),
      "import { createDb } from '@agent-workspace/core';\nexport const db = createDb;\n",
    );

    expect(await importOffenders(copy)).toStrictEqual([
      'app/planted.ts: @agent-workspace/core is the platform, not a published package',
    ]);
  });

  it('a relative import escaping the app, an unpublished package and a path dependency fail No fork', async () => {
    const copy = await minimalCopy();
    await writeFile(
      path.join(copy, 'app/escape.ts'),
      "export { x } from '../../elsewhere/x.ts';\nexport type Y = import('@indx-workspace/core').Y;\n",
    );
    const manifestPath = path.join(copy, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies['@indx-workspace/sdk'] = 'file:../../packages/sdk';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(await importOffenders(copy)).toStrictEqual([
      'app/escape.ts: ../../elsewhere/x.ts reaches outside the app',
      'app/escape.ts: @indx-workspace/core is not a published package',
      'package.json: dependencies.@indx-workspace/sdk is installed from file:../../packages/sdk',
    ]);
  });

  it('an edited generated file counts in full', async () => {
    const copy = await minimalCopy();
    const resource = path.join(copy, 'resources/note.ts');
    const text = await readFile(resource, 'utf8');
    await writeFile(resource, text.replace('write: false', "write: ['title']"));

    const count = await countHandwritten(copy, await manifestOf(copy));

    expect(count.files).toStrictEqual([
      { file: 'resources/note.ts', lines: countedLines('resources/note.ts', text) },
    ]);
    expect((await generatedFileStates(copy, await manifestOf(copy))).get('resources/note.ts')).toBe(
      'edited',
    );
  });

  it('an edited generated file is a Generated gap unless the app takes it over', async () => {
    const copy = await minimalCopy();
    const resource = path.join(copy, 'resources/note.ts');
    const text = await readFile(resource, 'utf8');
    await writeFile(resource, text.replace('write: false', "write: ['title']"));
    const [minimal] = apps;
    if (minimal === undefined) throw new Error('examples/minimal is not registered');

    const plain = await scoreOfApp(minimal.benchmark, copy);
    const takenOver = await scoreOfApp(
      { ...minimal.benchmark, takenOver: ['resources/note.ts'] },
      copy,
    );

    expect(plain.verdicts.generated).toBe('gap');
    expect(takenOver.verdicts.generated).toBe('ok');
    expect(takenOver.handwritten).toBe(countedLines('resources/note.ts', text));
  });

  it('the regenerated comparison leaves out declared edits, never the manifest', async () => {
    const copy = await minimalCopy();
    await writeFile(path.join(copy, 'resources/note.ts'), 'export {};\n');
    await writeFile(path.join(copy, 'aw-generated.json'), '{}\n');
    const generated = new Map([
      ['resources/note.ts', 'as generated\n'],
      ['aw-generated.json', '{ "version": 1 }\n'],
    ]);

    expect(differingFiles(generated, copy)).toStrictEqual([
      'resources/note.ts',
      'aw-generated.json',
    ]);
    expect(
      differingFiles(generated, copy, ['resources/note.ts', 'aw-generated.json']),
    ).toStrictEqual(['aw-generated.json']);
  });

  it('app.config.ts and the journal with their recorded resource lines count 0', async () => {
    const dir = path.join(EXAMPLES_DIR, 'minimal');
    const states = await generatedFileStates(dir, await manifestOf(dir));
    const config = await readFile(path.join(dir, 'app.config.ts'), 'utf8');

    expect(config).toContain("import note from './resources/note.ts';");
    expect(states.get('app.config.ts')).toBe('unedited');
    expect(states.get('db/migrations/meta/_journal.json')).toBe('unedited');
    expect(states.get('package.json')).toBe('unedited');
    expect((await countHandwritten(dir, await manifestOf(dir))).files).toStrictEqual([]);
  });

  it('counts only lines that are not blank or comments', () => {
    const ts = '// a\n/* b\n * c\n */\n\nconst x = 1; /* d */\n/* e */ const y = 2;\n';
    expect(countedLines('a.ts', ts)).toBe(2);
    expect(countedLines('a.sh', '#!/bin/sh\n# note\necho hi\n\n')).toBe(1);
    expect(countedLines('a.yaml', 'a: 1 # one\n# two\n')).toBe(1);
  });

  it('leaves the benchmark files, tests, specs, lockfiles and build output out of the count', () => {
    for (const file of [
      'commands.sh',
      'benchmark.ts',
      'README.md',
      'e2e/minimal.e2e.mjs',
      'tests/agent-on-data.test.ts',
      '.aw/app-identity.json',
      'pnpm-lock.yaml',
      'node_modules/x/index.js',
      '.next/server/app.js',
      'migrations/meta/_journal.json',
      'db/migrations/meta/0003_snapshot.json',
    ]) {
      expect(isExcludedFromCount(file), file).toBe(true);
    }
    expect(isExcludedFromCount('app/page.tsx')).toBe(false);
    expect(isExcludedFromCount('db/migrations/0003_create_notes.sql')).toBe(false);
  });
});

describe('the evidence check', () => {
  const spec = "test('J3: a member opens a note and edits it', async () => {});\n";
  const lane = "export const LANE_STEPS = ['regenerate', 'self-host'];\n";

  it('takes a step id of lane.mjs, or a quoted test title of the named .e2e.mjs', () => {
    const step = { evidence: 'lane', file: 'tests/apps/lane.mjs', ref: 'self-host' } as const;
    const title = {
      evidence: 'lane',
      file: 'examples/minimal/e2e/minimal.e2e.mjs',
      ref: 'J3: a member opens a note and edits it',
    } as const;

    expect(evidenceProblem(step, lane, ['regenerate', 'self-host'])).toBeUndefined();
    expect(evidenceProblem(title, spec, [])).toBeUndefined();
  });

  it('fails a lane ref naming a missing title or step id', () => {
    const missingStep = { evidence: 'lane', file: 'tests/apps/lane.mjs', ref: 'selfHost' } as const;
    const missingTitle = {
      evidence: 'lane',
      file: 'examples/minimal/e2e/minimal.e2e.mjs',
      ref: 'J3: a member opens a note',
    } as const;
    const notASpec = { evidence: 'lane', file: 'examples/minimal/README.md', ref: 'x' } as const;

    expect(evidenceProblem(missingStep, lane, ['regenerate', 'self-host'])).toBe(
      "'selfHost' is not a step of tests/apps/lane.mjs",
    );
    expect(evidenceProblem(missingTitle, spec, [])).toBe(
      "no journey titled 'J3: a member opens a note' in examples/minimal/e2e/minimal.e2e.mjs",
    );
    expect(evidenceProblem(notASpec, 'x', [])).toContain('is neither tests/apps/lane.mjs');
    expect(
      evidenceProblem({ evidence: 'contract', file: 'a.test.ts', ref: 'b' }, "it('c')", []),
    ).toBe("no title 'b' in a.test.ts");
  });
});

describe('regenerate.mjs', () => {
  it('takes --check or --write and one example id', () => {
    expect(parseRegenerateArgs(['--check', 'minimal'])).toStrictEqual({
      mode: 'check',
      id: 'minimal',
    });
    expect(() => parseRegenerateArgs(['--diff', 'minimal'])).toThrow('usage:');
    expect(() => parseRegenerateArgs(['--write', '../x'])).toThrow('is not an example id');
  });

  it('names each generated file the example differs in, except the ones it takes over', async () => {
    const copy = await minimalCopy();
    const resource = path.join(copy, 'resources/note.ts');
    const generated = new Map([['resources/note.ts', await readFile(resource, 'utf8')]]);
    await writeFile(resource, `${generated.get('resources/note.ts') ?? ''}// mine\n`);

    expect(differingFiles(generated, copy)).toStrictEqual(['resources/note.ts']);
    expect(differingFiles(generated, copy, ['resources/note.ts'])).toStrictEqual([]);
  });

  it('adds the tarball overrides and takes exactly them away again', () => {
    const tarballs = { '@indx-workspace/sdk': '/packs/sdk.tgz' };
    const withOwn = "allowBuilds:\n  'esbuild': false\noverrides:\n  'undici@<7': '^7'\n";
    const without = "allowBuilds:\n  'esbuild': false\n";

    expect(withPackedOverrides(withOwn, tarballs)).toBe(
      `${withOwn}  ${PACKED_OVERRIDES_MARK}\n  '@indx-workspace/sdk': 'file:/packs/sdk.tgz'\n`,
    );
    expect(withoutPackedOverrides(withPackedOverrides(withOwn, tarballs))).toBe(withOwn);
    expect(withoutPackedOverrides(withPackedOverrides(without, tarballs))).toBe(without);
    expect(() => withPackedOverrides(`${withOwn}catalog: {}\n`, tarballs)).toThrow(
      'a block after its overrides',
    );
  });

  it('moves the lock-step version, and the manifest hash of each file it changes', () => {
    const packageJson =
      '{\n  "dependencies": {\n    "@indx-workspace/sdk": "0.7.0",\n    "next": "0.7.0"\n  }\n}\n';
    const files = new Map([
      ['package.json', packageJson],
      ['app/page.tsx', 'export default 1;\n'],
    ]);
    const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
    const manifest = JSON.stringify({
      entries: {
        'project:x': { files: { 'package.json': hash(packageJson) }, edits: [] },
        'app:x': { edits: [{ added: '{"dependencies":{"@indx-workspace/sdk":"0.7.0"}}' }] },
      },
    });
    files.set('aw-generated.json', manifest);

    const moved = atScopeVersion(files, '0.7.0', '0.6.12');
    const movedPackage = packageJson.replace('"0.7.0",', '"0.6.12",');

    expect(moved.get('package.json')).toBe(movedPackage);
    expect(moved.get('app/page.tsx')).toBe('export default 1;\n');
    expect(moved.get('aw-generated.json')).toContain('\\"@indx-workspace/sdk\\":\\"0.6.12\\"');
    expect(moved.get('aw-generated.json')).toContain(`"${hash(movedPackage)}"`);
    expect(moved.get('aw-generated.json')).not.toContain(hash(packageJson));
    expect(atScopeVersion(files, '0.7.0', undefined)).toStrictEqual(files);
  });
});

describe('the scoreboard', () => {
  it('examples/README.md shows the scoreboard', async () => {
    const scores = await Promise.all(apps.map((app) => scoreOfApp(app.benchmark, app.dir)));
    const board = renderScoreboard(scores);
    const text = await readFile(README, 'utf8');
    const start = text.indexOf(START);
    const end = text.indexOf(END);
    expect(start, `examples/README.md has no ${START} marker`).toBeGreaterThanOrEqual(0);
    expect(end, `examples/README.md has no ${END} marker after ${START}`).toBeGreaterThan(start);
    const expected = `${text.slice(0, start + START.length)}\n\n${board}\n\n${text.slice(end)}`;
    // Rendering again from the rendered file gives the same text: APPS_WRITE=1 is idempotent.
    expect(renderScoreboard(scores)).toBe(board);
    if (WRITE) {
      await writeFile(README, expected);
      return;
    }
    expect(text, 'examples/README.md is stale; run with APPS_WRITE=1').toBe(expected);
  });

  it('scores the share of ok cells, and shows each declared gap', async () => {
    const [minimal] = apps;
    if (minimal === undefined) throw new Error('examples/minimal is not registered');
    const score = await scoreOfApp(minimal.benchmark, minimal.dir);

    expect(Object.keys(score.verdicts)).toStrictEqual([...APP_CELLS]);
    expect(score.verdicts).toMatchObject({
      generated: 'ok',
      handwritten: 'ok',
      agentOnData: 'ok',
      noFork: 'ok',
    });
    expect(scoreOf(score)).toBe(
      APP_CELLS.filter((cell) => score.verdicts[cell] === 'ok').length / APP_CELLS.length,
    );
    const { cells } = score.benchmark;
    const withGap = {
      ...score,
      benchmark: {
        ...score.benchmark,
        cells: { ...cells, selfHost: { ...cells.selfHost, verdict: 'gap', note: 'no image' } },
      },
      verdicts: { ...score.verdicts, selfHost: 'gap' },
    } as const;
    expect(renderScoreboard([withGap])).toContain(
      'Declared gaps:\n\n- minimal, Self-host: no image',
    );
    expect(renderScoreboard([score])).not.toContain('Declared gaps');
  });
});
