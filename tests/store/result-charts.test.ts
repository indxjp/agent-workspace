/**
 * The Try it section's result charts (unit G2b of the Agent Store 100-use-case plan; ADR-0168 D5):
 * an entry's demo asks its runs for `demo.outputSchema`, and the charts its demo agent's surfaces
 * declare (`resultCharts`) are drawn under the answer from `run.output.structured`.
 *
 * The store may not read outside itself (the No fork cell), so this test is the generator: it reads
 * the charts from the surfaces and writes `examples/store/catalog/charts.generated.ts`
 * (`APPS_WRITE=1 pnpm vitest run --project tests-store tests/store/result-charts.test.ts`); without
 * it a stale file fails. It also checks what the catalog cannot from inside: the schema is within
 * the platform's limits, is the suggested eval case's schema, and holds every charted field; and a
 * run of the budget entry against the scripted model records its typed answer and charts it.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { outputSchemaViolation } from '@indx-workspace/contracts/runs';
import { resultChartData, type ResultChart } from '@indx-workspace/contracts/surfaces';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import budgetSurface from '../../use-cases/budget/surfaces/main.ts';
import { CATALOG } from '../../examples/store/catalog/index.ts';
import { hasSource, type SourcedEntry } from '../../examples/store/catalog/define.ts';
import { RESULT_CHARTS } from '../../examples/store/catalog/charts.generated.ts';
import { recordingSchema } from '../../examples/store/catalog/recording.ts';
import { chartsFor } from '../../examples/store/app/agents/[slug]/try/charts.ts';
import { fallbackContent } from '../../examples/store/app/agents/[slug]/try/replay.ts';
import { beginTurn } from '../../examples/store/app/agents/[slug]/try/transcript.ts';
import { createFileSearch } from '../gallery/harness/file-search.ts';
import { scriptedWorkspace } from '../gallery/harness/scripted-workspace.ts';
import { REPOSITORY_ROOT } from '../apps/registry.ts';
import { recordTurn } from './proof/record-turn.ts';
import { playTurn } from './recordings/run.ts';

const WRITE = process.env['APPS_WRITE'] === '1';
/** The budget entry's skill script, which the scripted run runs as a command. */
const SCRIPT = path.join(REPOSITORY_ROOT, 'use-cases/budget/skills/budget/scripts/analyse.mjs');
const GENERATED = path.join(REPOSITORY_ROOT, 'examples/store/catalog/charts.generated.ts');

/** The part of a defined surface the charts are read from. */
interface SurfaceCharts {
  readonly agent: string;
  readonly resultCharts?: readonly ResultChart[] | undefined;
}

/**
 * Every surface of an entry's source that declares `resultCharts`, by repository path, imported by
 * literal specifier (the import gates refuse a computed `import()`). A surface that gains charts
 * fails the next test until it is listed here.
 */
const SURFACES: ReadonlyMap<string, SurfaceCharts> = new Map([
  ['use-cases/budget/surfaces/main.ts', budgetSurface],
]);

const sourced = CATALOG.filter(hasSource);

/** The surface files of `entry`'s source, by repository path. */
function surfaceFiles(entry: SourcedEntry): string[] {
  const folder = path.join(REPOSITORY_ROOT, entry.source, 'surfaces');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `${entry.source}/surfaces/${name}`);
}

/** The charts of `entry`: those of its demo agent's surfaces, in file order, each once (ADR-0168 D1). */
function chartsOf(entry: SourcedEntry): ResultChart[] {
  const charts: ResultChart[] = [];
  for (const file of surfaceFiles(entry)) {
    const surface = SURFACES.get(file);
    if (surface?.agent !== entry.demo.agent) continue;
    for (const chart of surface.resultCharts ?? []) {
      const seen = charts.some((known) => JSON.stringify(known) === JSON.stringify(chart));
      if (!seen) charts.push(chart);
    }
  }
  return charts;
}

const HEADER = `// Generated from each entry's surfaces by \`APPS_WRITE=1 pnpm vitest run --project tests-store tests/store/result-charts.test.ts\`.
// Do not edit by hand: tests/store/result-charts.test.ts fails when it differs from the surfaces.
`;

function render(charts: Readonly<Record<string, readonly ResultChart[]>>): string {
  return `${HEADER}
/**
 * The result charts (ADR-0168) each entry's demo agent's surfaces declare, keyed by slug. Data: the
 * Try it section parses it with the contracts' \`ResultChartsSchema\` before it draws any.
 */
export const RESULT_CHARTS: Readonly<Record<string, readonly unknown[]>> = ${JSON.stringify(charts, null, 2)};
`;
}

const declared = Object.fromEntries(
  sourced.flatMap((entry) => {
    const charts = chartsOf(entry);
    return charts.length === 0 ? [] : [[entry.slug, charts] as const];
  }),
);

const JsonSchemaNode = z.looseObject({
  type: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  items: z.unknown().optional(),
});

/** Why `chart` cannot be drawn from an answer of `schema`: its field is no array of rows with its keys. */
function chartSchemaProblem(chart: ResultChart, schema: Readonly<Record<string, unknown>>) {
  const field = JsonSchemaNode.safeParse(JsonSchemaNode.parse(schema).properties?.[chart.field]);
  if (!field.success || field.data.type !== 'array') return `${chart.field} is not an array`;
  const row = JsonSchemaNode.safeParse(field.data.items);
  const keys = Object.keys((row.success ? row.data.properties : undefined) ?? {});
  const missing = [chart.label, chart.value].filter((key) => !keys.includes(key));
  return missing.length === 0 ? null : `${chart.field} rows have no ${missing.join(', ')}`;
}

/** The `outputSchema` of the demo agent's eval case tagged `suggested`, or `null` without one. */
function suggestedSchema(entry: SourcedEntry): Readonly<Record<string, unknown>> | null {
  const file = path.join(REPOSITORY_ROOT, entry.source, 'evals', `${entry.demo.agent}.yaml`);
  if (!existsSync(file)) return null;
  const evals = readEvalCaseFile(readFileSync(file, 'utf8'), path.basename(file));
  const suggested = evals.cases.find((evalCase) => evalCase.tags?.includes('suggested'));
  return suggested?.outputSchema ?? null;
}

describe('the result charts of the Try it section', () => {
  it('examples/store/catalog/charts.generated.ts matches the surfaces', async () => {
    if (WRITE) await writeFile(GENERATED, render(declared));
    expect(RESULT_CHARTS, 'charts.generated.ts is stale; run with APPS_WRITE=1').toEqual(declared);
  });

  it('lists every surface of an entry that declares charts', () => {
    const files = sourced.flatMap(surfaceFiles).filter((file) => {
      const text = readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8');
      return text.includes('resultCharts');
    });
    expect([...SURFACES.keys()].sort()).toEqual(files.sort());
    expect(Object.keys(declared)).toContain('budget');
  });

  it("asks a charted entry's runs for a schema within the limits that holds each charted field", () => {
    for (const entry of sourced) {
      const schema = entry.demo.outputSchema;
      const charts = declared[entry.slug] ?? [];
      if (charts.length > 0) expect(schema, `${entry.slug}: no demo.outputSchema`).toBeDefined();
      if (schema === undefined) continue;
      expect(outputSchemaViolation(schema), entry.slug).toBeNull();
      for (const chart of charts) expect(chartSchemaProblem(chart, schema), entry.slug).toBeNull();
    }
  });

  it("asks for exactly the schema of the entry's suggested eval case, which must declare one", () => {
    const declaring = sourced.filter((entry) => entry.demo.outputSchema !== undefined);
    for (const entry of declaring) {
      const suggested = suggestedSchema(entry);
      expect(
        suggested,
        `${entry.slug}: no suggested eval case with an outputSchema`,
      ).not.toBeNull();
      expect(entry.demo.outputSchema, entry.slug).toEqual(suggested);
    }
    expect(declaring.map((entry) => entry.slug)).toContain('budget');
  });

  it('refuses a charted field the schema does not hold as rows with its keys', () => {
    const chart = { ...budgetSurface.resultCharts?.[0], field: 'rows' } as ResultChart;
    const rows = { type: 'array', items: { type: 'object', properties: { department: {} } } };
    expect(chartSchemaProblem(chart, { type: 'object' })).toBe('rows is not an array');
    expect(chartSchemaProblem(chart, { type: 'object', properties: { rows } })).toBe(
      'rows rows have no variance',
    );
    expect(
      chartSchemaProblem(chart, { type: 'object', properties: { rows: { type: 'array' } } }),
    ).toBe('rows rows have no department, variance');
  });

  it('draws only the charts the typed output fits, and none for an entry without charts', () => {
    expect(chartsFor('budget', null)).toEqual([]);
    expect(chartsFor('budget', undefined)).toEqual([]);
    expect(chartsFor('nda', { findings: [] })).toEqual([]);
    // A chart the output does not fit is hidden, never shown as the developer's mismatch sentence.
    expect(chartsFor('budget', {})).toEqual([]);
    const departments = [{ department: '営業部', variance: 252000 }];
    expect(chartsFor('budget', { departments, trend: [] })).toEqual(
      declared['budget']?.filter((chart) => chart.field === 'departments'),
    );
  });

  it('records no typed answer for a run asked for none, and starts a turn without one', () => {
    expect(recordTurn('q', [{ frames: [], structured: null }])).toEqual({
      prompt: 'q',
      steps: [],
      stopReason: null,
    });
    expect(beginTurn('run', 'q').structured).toBeNull();
  });

  it("records the budget demo's typed answer against the scripted model and charts it", async () => {
    const entry = sourced.find((candidate) => candidate.slug === 'budget');
    const outputSchema = entry?.demo.outputSchema;
    if (entry === undefined || outputSchema === undefined) throw new Error('no budget schema');
    const root = mkdtempSync(path.join(tmpdir(), 'store-charts-'));
    cpSync(path.join(REPOSITORY_ROOT, entry.source, 'data'), path.join(root, 'budget'), {
      recursive: true,
    });
    const builtins = {
      search_files: createFileSearch({ root, grants: ['budget'] }).call,
      run_skill_script: (input: Record<string, unknown>) => {
        const [file = '', ...rest] = z.array(z.string()).parse(input['args']);
        // As run_skill_script runs it: `node analyse.mjs <args>`, the package resolved from its source.
        const ran = spawnSync(process.execPath, [SCRIPT, path.join(root, file), ...rest], {
          encoding: 'utf8',
        });
        const ok = ran.status === 0;
        return Promise.resolve({ text: ok ? ran.stdout : ran.stderr, isError: !ok });
      },
    };
    const file = 'ja/予実_2026年度上期_部門別.csv';
    const prompt = entry.demo.prompts[0]?.ja ?? '';
    const workspace = scriptedWorkspace(
      async ({ builtin }) => {
        const result = await builtin('run_skill_script', {
          skill: 'budget',
          script: 'analyse.mjs',
          args: [`budget/${file}`, '--month', '2026-09'],
        });
        const computed = JSON.parse(result.text) as object;
        return { text: '差異の大きい行を示します。', structured: { ...computed, commentary: '' } };
      },
      {},
      builtins,
    );
    const runs = await playTurn(workspace, { prompt, outputSchema });
    const turn = recordTurn(prompt, runs);
    const recording = recordingSchema.parse({
      slug: 'budget',
      lang: 'ja',
      recordedWith: 'scripted-model',
      turn,
    });
    expect(recording.turn.structured).toMatchObject({ month: '2026-09' });
    const content = fallbackContent(recording, 'ja');
    expect(content.kind === 'recording' ? content.charts : []).toEqual(declared['budget']);
    for (const chart of chartsFor('budget', recording.turn.structured)) {
      const data = resultChartData(chart, recording.turn.structured);
      expect(data.kind, chart.field).toBe('points');
    }
  });
});
