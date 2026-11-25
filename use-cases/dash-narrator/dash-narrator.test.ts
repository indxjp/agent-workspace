/**
 * The contract, moment and flow tiers of `dash-narrator` (archetype AN), and the skill script that
 * computes every number it reports.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>` in the run's
 * working directory, here in this process so coverage measures it) on the sample exports placed
 * where the demo puts them (`dash-narrator/<file>`), and prove that the typed answer the surface
 * charts carries the script's numbers, the same in Japanese and English, and that a note in the
 * export changes nothing. The tests below pin the script's rules and refusals, and one evaluates it
 * again as its command line.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScript } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createFileSearch } from '../../tests/gallery/harness/file-search.ts';
import type { scriptedWorkspace } from '../../tests/gallery/harness/scripted-workspace.ts';
import type { runAndRead } from '../../tests/gallery/shared/run-answer.ts';
import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/dash-narrator.ts';
import { analyse as analyseRows, compute, SPEC } from './skills/dash-narrator/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

const SCRIPT = 'skills/dash-narrator/scripts/analyse.mjs';

/** Evaluate the script again as `node analyse.mjs <args>` would: what it printed and its exit code. */
async function runAsCommand(args: readonly string[]): Promise<{ printed: string; code: unknown }> {
  const [argv, exitCode] = [[...process.argv], process.exitCode];
  const printed: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk));
    return true;
  });
  process.argv.splice(
    1,
    process.argv.length,
    fileURLToPath(new URL(SCRIPT, import.meta.url)),
    ...args,
  );
  try {
    vi.resetModules();
    await import('./skills/dash-narrator/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const SHOP = {
  ja: 'ja/ダッシュボード_ECサイト_2026年10月.csv',
  en: 'en/dashboard-online-shop-2026-10.csv',
} as const;
const NOTED = {
  ja: 'ja/ダッシュボード_問い合わせ_2026年11月第1週.csv',
  en: 'en/dashboard-support-2026-11-week1.csv',
} as const;

/** The script's command line, as `runWhenMain` runs it: exit code, stdout and the refusal. */
function run(args: readonly string[]) {
  const [out, err]: [string[], string[]] = [[], []];
  const code = runScript(args, SPEC, compute, {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
  });
  const refusal = err.length === 0 ? undefined : (JSON.parse(err.join('')) as { error: string });
  return { code, text: out.join(''), refusal };
}

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `dash-narrator/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'dash-narrator-'));
cpSync(DATA, path.join(ROOT, 'dash-narrator'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['dash-narrator'] }).call,
  run_skill_script: (input: Record<string, unknown>) => {
    const [file = '', ...rest] = z.array(z.string()).parse(input['args']);
    const { code, text, refusal } = run([path.join(ROOT, file), ...rest]);
    return Promise.resolve({
      text: code === 0 ? text : JSON.stringify(refusal),
      isError: code !== 0,
    });
  },
};

/** The code and row of the refusal the script prints for `content` as an export. */
function refusalOf(content: string, args: readonly string[] = []) {
  const file = path.join(ROOT, 'refused.csv');
  writeFileSync(file, content);
  const { code, refusal } = run([file, ...args]);
  return { code, ...z.object({ error: z.string(), row: z.number().optional() }).parse(refusal) };
}

const HEADER = '日付,指標,値\n';
const Point = z.strictObject({ date: z.string(), value: z.number() });
const Answer = z.object({
  from: z.string(),
  to: z.string(),
  metrics: z.array(
    z.strictObject({
      metric: z.string(),
      first: z.number(),
      last: z.number(),
      change: z.number(),
      changePct: z.number().nullable(),
      mean: z.number(),
      peak: Point,
      low: Point,
    }),
  ),
  unusual: z.array(
    z.strictObject({ metric: z.string(), date: z.string(), value: z.number(), z: z.number() }),
  ),
  commentary: z.string(),
});
type Answer = z.infer<typeof Answer>;

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the export, run the script, and answer with its JSON and nothing else. */
async function narrate(tools: Tools, file: string, query: string, args: readonly string[] = []) {
  const { aw, agentId } = tools.workspace(
    async ({ builtin }) => {
      const found = await builtin('search_files', { query });
      expect(found.text).toContain(`dash-narrator/${file}`);
      const result = await builtin('run_skill_script', {
        skill: 'dash-narrator',
        script: 'analyse.mjs',
        args: [`dash-narrator/${file}`, ...args],
      });
      expect(result.isError).toBe(false);
      const computed = JSON.parse(result.text) as object;
      return { text: result.text, structured: { ...computed, commentary: '' } };
    },
    {},
    BUILTINS,
  );
  return tools.runAndRead(aw, agentId, { prompt: file }, Answer);
}

/** The unusual points as `metric date value z`. */
const unusualOf = (output: Answer): string[] =>
  output.unusual.map((point) => [point.metric, point.date, point.value, point.z].join(' '));
/** The numbers alone: the two languages' exports are one dashboard, only the names differ. */
const numbers = (output: Answer): unknown =>
  JSON.parse(JSON.stringify(output, (key, value: unknown) => (key === 'metric' ? '' : value)));

describeUseCase('dash-narrator', {
  definitions: { 'agents/dash-narrator.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'explains the month with the script, the same in Japanese and English',
      run: async (tools) => {
        const ja = await narrate(tools, SHOP.ja, '訪問数');
        const en = await narrate(tools, SHOP.en, 'visits');
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        expect(numbers(ja.output)).toEqual(numbers(en.output));
        expect(ja.output).toMatchObject({ from: '2026-10-05', to: '2026-11-01' });
        expect(en.output.metrics.map((row) => [row.metric, row.changePct])).toEqual([
          ['Visits', 24.4],
          ['Orders', 20.8],
          ['Sales (yen)', 20.8],
          ['Average order value (yen)', 0],
        ]);
        expect(en.output.metrics[0]).toMatchObject({
          peak: { date: '2026-10-24', value: 4000 },
          low: { date: '2026-10-15', value: 41 },
        });
        expect(unusualOf(en.output)).toEqual([
          'Orders 2026-10-24 268 5.07',
          'Sales (yen) 2026-10-24 1058639 4.86',
          'Visits 2026-10-15 41 -4.72',
          'Average order value (yen) 2026-10-24 3950.1 -4.53',
        ]);
      },
    },
    {
      name: 'explains one week when the request names it, and the planted note changes nothing',
      run: async (tools) => {
        const week = await narrate(tools, SHOP.ja, '注文数', [
          '--from',
          '2026-10-12',
          '--to',
          '2026-10-18',
        ]);
        expect(unusualOf(week.output)).toEqual(['訪問数 2026-10-15 41 -2.39']);
        expect(week.output.metrics[0]).toMatchObject({ first: 3320, last: 3960, changePct: 19.3 });
        for (const [lang, query] of [
          ['ja', '備考'],
          ['en', 'note'],
        ] as const) {
          const { output } = await narrate(tools, NOTED[lang], query);
          expect(output.unusual.map((point) => [point.date, point.value, point.z])).toEqual([
            ['2026-11-05', 120, 2.45],
            ['2026-11-05', 47.5, 2.45],
          ]);
        }
      },
    },
  ],
});

describe('dash-narrator', () => {
  it('runs as a command line, at the threshold it is given', async () => {
    const csv = fileURLToPath(new URL(SHOP.en, DATA));
    const { printed, code } = await runAsCommand([csv, '--z', '4.8']);
    expect(code).toBe(0);
    const answer = JSON.parse(printed) as Answer;
    expect(answer).toMatchObject({ from: '2026-10-05', to: '2026-11-01', z: 4.8 });
    expect(unusualOf(answer)).toEqual([
      'Orders 2026-10-24 268 5.07',
      'Sales (yen) 2026-10-24 1058639 4.86',
    ]);
  });

  it('marks nothing unusual in a metric that never changes, and no change % from a first value of 0', () => {
    const rows = ['2026-10-01', '2026-10-02', '2026-10-03'].map((date) => ({
      date,
      metric: 'm',
      value: 5,
    }));
    const zero = [
      { date: '2026-10-01', metric: 'n', value: 0 },
      { date: '2026-10-02', metric: 'n', value: 3 },
    ];
    const result = analyseRows({ rows: [...rows, ...zero], rowNumbers: [2, 3, 4, 5, 6] }, {});
    expect(result.unusual).toEqual([]);
    expect(result.metrics).toEqual([
      {
        metric: 'm',
        first: 5,
        last: 5,
        change: 0,
        changePct: 0,
        mean: 5,
        peak: { date: '2026-10-01', value: 5 },
        low: { date: '2026-10-01', value: 5 },
      },
      {
        metric: 'n',
        first: 0,
        last: 3,
        change: 3,
        changePct: null,
        mean: 1.5,
        peak: { date: '2026-10-02', value: 3 },
        low: { date: '2026-10-01', value: 0 },
      },
    ]);
  });

  it('rounds half away from zero, the same above and below, with no float noise', () => {
    const two = (first: number, last: number) =>
      analyseRows(
        {
          rows: [
            { date: '2026-10-01', metric: 'm', value: first },
            { date: '2026-10-02', metric: 'm', value: last },
          ],
          rowNumbers: [2, 3],
        },
        { z: '9' },
      ).metrics[0];
    expect(two(0.1, 0.3)).toMatchObject({ change: 0.2, mean: 0.2 });
    expect(two(8, 7.99)).toMatchObject({ change: -0.01, changePct: -0.1 });
    expect(two(2000, 2001)).toMatchObject({ changePct: 0.1 });
  });

  it('reads the dates in the range in date order, whatever the order of the rows', () => {
    const csv = `${HEADER}2026/10/3,m,3\n2026-10-01,m,1\n2026-10-02,m,2\n`;
    const result = refusalFree(csv, ['--from', '2026-10-02']);
    expect(result.metrics[0]).toMatchObject({ first: 2, last: 3 });
  });

  it('refuses what it cannot compute rather than guessing', () => {
    const row = '2026-10-01,訪問数,100';
    expect(refusalOf(`${HEADER}10月1日,訪問数,100`)).toMatchObject({
      code: 1,
      error: 'not_a_date',
      row: 2,
    });
    expect(refusalOf(`${HEADER}2026-10-01,訪問数,多い`).error).toBe('not_a_decimal');
    expect(refusalOf(`${HEADER}2026-10-01,訪問数,`).error).toBe('empty_cell');
    expect(refusalOf('日付,値\n2026-10-01,1').error).toBe('missing_column');
    expect(refusalOf(HEADER).error).toBe('no_rows');
    expect(refusalOf(`${HEADER}${row}\n2026-10-01,訪問数,90`)).toMatchObject({
      error: 'duplicate_row',
      row: 3,
    });
    expect(
      refusalOf(`${HEADER}${row}`, ['--from', '2026-11-01', '--to', '2026-11-02']),
    ).toMatchObject({
      code: 1,
      error: 'empty_range',
    });
    for (const args of [
      ['--z', '0'],
      ['--z', 'high'],
      ['--z', '-1'],
      ['--from', '2026/10/01'],
      ['--to', 'October'],
      ['--from', '2026-10-02', '--to', '2026-10-01'],
      ['--zz', '2'],
      ['--from'],
      ['second.csv'],
    ]) {
      expect(refusalOf(`${HEADER}${row}`, args)).toMatchObject({ code: 2, error: 'usage' });
    }
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'dash-narrator', access: 'read' }]);
  });

  it('asks its typed eval run for the chart rows and the unusual points the script prints', () => {
    const text = readFileSync(new URL('evals/dash-narrator.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/dash-narrator.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    const declared = surface.resultCharts?.map((chart) => chart.field);
    expect(declared).toEqual(['changes']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of ['from', 'to', 'z', 'unusual', 'commentary', ...(declared ?? [])]) {
      expect(required).toContain(field);
    }
  });
});

/** The script's result for `content` as an export, which it must compute. */
function refusalFree(content: string, args: readonly string[] = []): Answer {
  const file = path.join(ROOT, 'computed.csv');
  writeFileSync(file, content);
  const { code, text } = run([file, ...args]);
  expect(code).toBe(0);
  return Answer.parse({ ...(JSON.parse(text) as object), commentary: '' });
}
