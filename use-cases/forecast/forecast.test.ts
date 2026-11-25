/**
 * The contract and flow tiers of `forecast` (archetype AN), and the skill script that computes every
 * number it reports.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>`, here in this
 * process so coverage measures it) on the sample exports placed where the demo puts them
 * (`forecast/<file>`), and prove that the typed answer the surface charts carries the script's
 * numbers, the same in Japanese and English, and that a note in the export changes nothing. One test
 * evaluates the script again as its command line.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScript } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { writeXlsx } from '@indx-workspace/builtin-skills/office-reader/scripts/ooxml.mjs';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createFileSearch } from '../../tests/gallery/harness/file-search.ts';
import type { scriptedWorkspace } from '../../tests/gallery/harness/scripted-workspace.ts';
import type { runAndRead } from '../../tests/gallery/shared/run-answer.ts';
import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/forecast.ts';
import { analyse as analyseRows, compute, SPEC } from './skills/forecast/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

/** Evaluate the script again as `node analyse.mjs <args>` would; what it printed and its exit code. */
async function runAsCommand(args: readonly string[]): Promise<{ printed: string; code: unknown }> {
  const [argv, exitCode] = [[...process.argv], process.exitCode];
  const printed: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk));
    return true;
  });
  const script = fileURLToPath(new URL('skills/forecast/scripts/analyse.mjs', import.meta.url));
  process.argv.splice(1, process.argv.length, script, ...args);
  try {
    vi.resetModules();
    await import('./skills/forecast/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const EXPORTS = { ja: 'ja/商談一覧_2026年度下期.csv', en: 'en/deals-FY2026-H2.csv' } as const;
const NOTED = {
  ja: 'ja/商談一覧_2026年第4四半期_営業二課.csv',
  en: 'en/deals-2026-Q4-sales-team-2.csv',
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

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `forecast/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'forecast-'));
cpSync(DATA, path.join(ROOT, 'forecast'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['forecast'] }).call,
  run_skill_script: (input: Record<string, unknown>) => {
    const [file = '', ...rest] = z.array(z.string()).parse(input['args']);
    const { code, text, refusal } = run([path.join(ROOT, file), ...rest]);
    return Promise.resolve({
      text: code === 0 ? text : JSON.stringify(refusal),
      isError: code !== 0,
    });
  },
};

/** The code, row and column of the refusal the script prints for `content` as an export. */
function refusalOf(content: string, args: readonly string[] = []) {
  const file = path.join(ROOT, 'refused.csv');
  writeFileSync(file, content);
  const { code, refusal } = run([file, ...args]);
  const shape = z.object({
    error: z.string(),
    row: z.number().optional(),
    column: z.string().optional(),
  });
  return { code, ...shape.parse(refusal) };
}

const HEADER = '案件ID,顧客,ステージ,金額,確度,受注予定月\n';

const Month = z.strictObject({
  month: z.string(),
  won: z.number().int(),
  weighted: z.number().int(),
  pipeline: z.number().int(),
  forecast: z.number().int(),
});
const Answer = z.object({
  quarter: z.string(),
  months: z.array(Month),
  total: Month.omit({ month: true }).extend({ bestCase: z.number().int() }),
  target: z
    .strictObject({ target: z.number(), gap: z.number(), attainmentPct: z.number() })
    .nullable(),
  lost: z.strictObject({ count: z.number().int(), amount: z.number().int() }),
  deals: z.array(
    z.strictObject({
      deal: z.string(),
      customer: z.string(),
      amount: z.number().int(),
      probability: z.number().int(),
      month: z.string(),
      weighted: z.number().int(),
    }),
  ),
  commentary: z.string(),
});

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the export, run the script, and answer with its JSON and nothing else. */
async function forecast(tools: Tools, file: string, query: string, extra: readonly string[] = []) {
  const { aw, agentId } = tools.workspace(
    async ({ builtin }) => {
      const found = await builtin('search_files', { query });
      expect(found.text).toContain(`forecast/${file}`);
      const result = await builtin('run_skill_script', {
        skill: 'forecast',
        script: 'analyse.mjs',
        args: [`forecast/${file}`, '--quarter', '2026-Q4', ...extra],
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

describeUseCase('forecast', {
  definitions: { 'agents/forecast.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'forecasts the fourth quarter with the script, the same in Japanese and English',
      run: async (tools) => {
        const ja = await forecast(tools, EXPORTS.ja, '案件ID');
        const en = await forecast(tools, EXPORTS.en, 'deal_id', ['--target', '45000000']);
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        expect(ja.output.total).toEqual({
          won: 13_250_000,
          weighted: 18_375_750,
          pipeline: 43_620_000,
          forecast: 31_625_750,
          bestCase: 56_870_000,
        });
        expect(ja.output.months.map((row) => row.forecast)).toEqual([
          10_650_000, 14_235_000, 6_740_750,
        ]);
        expect(ja.output.lost).toEqual({ count: 2, amount: 4_700_000 });
        expect(ja.output.deals.slice(0, 2).map((deal) => [deal.customer, deal.weighted])).toEqual([
          ['籾山商事', 4_480_000],
          ['蒔苗メディカル', 4_200_000],
        ]);
        expect(ja.output.target).toBeNull();
        expect(en.output.target).toEqual({
          target: 45_000_000,
          gap: -13_374_250,
          attainmentPct: 70.3,
        });
        // The two exports are one set of deals: every number agrees, only the names differ.
        const numbers = (output: object): unknown =>
          JSON.parse(
            JSON.stringify(output, (key, value: unknown) => (key === 'customer' ? '' : value)),
          );
        expect(numbers({ ...en.output, target: null })).toEqual(numbers(ja.output));
      },
    },
    {
      name: 'reads a note in the export as data: the lost deal it asks to hide is still counted',
      run: async (tools) => {
        for (const [lang, query] of [
          ['ja', '備考'],
          ['en', 'note'],
        ] as const) {
          const { output } = await forecast(tools, NOTED[lang], query);
          expect(output.total.forecast).toBe(5_620_000);
          expect(output.lost).toEqual({ count: 1, amount: 3_900_000 });
        }
      },
    },
  ],
});

describe('forecast', () => {
  it('runs as a command line: the latest quarter by default', async () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const { printed, code } = await runAsCommand([csv]);
    expect(code).toBe(0);
    expect(JSON.parse(printed)).toMatchObject({
      quarter: '2026-Q4',
      total: { forecast: 31_625_750 },
    });
  });

  it('forecasts another quarter it is given, from the won deals alone when none is open', () => {
    const csv = fileURLToPath(new URL(EXPORTS.ja, DATA));
    const answer = Answer.omit({ commentary: true }).parse(
      JSON.parse(run([csv, '--quarter', '2026-Q3']).text),
    );
    expect(answer.total).toEqual({
      won: 18_830_000,
      weighted: 0,
      pipeline: 0,
      forecast: 18_830_000,
      bestCase: 18_830_000,
    });
    expect(answer.months.map((row) => row.month)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(answer.lost).toEqual({ count: 2, amount: 7_900_000 });
  });

  it('computes an .xlsx of the same deals to the same numbers as the CSV', () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const [header = [], ...records] = readFileSync(csv, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(','));
    const rows = records.map((cells) =>
      cells.map((cell, at) => (at === 3 || at === 4 ? Number(cell) : cell)),
    );
    const xlsx = path.join(ROOT, 'deals.xlsx');
    writeFileSync(xlsx, writeXlsx({ sheets: [{ name: 'Deals', rows: [header, ...rows] }] }));
    expect(run([xlsx]).text).toBe(run([csv]).text);
  });

  it('rounds each weighted amount half away from zero, and the attainment % to one decimal', () => {
    const row = {
      deal: 'D-1',
      customer: 'A',
      stage: 'open',
      amount: 12_345,
      probability: 10,
      month: '2026/10',
    };
    const answer = analyseRows({ rows: [row], rowNumbers: [2] }, { target: '3000' });
    expect(answer.total.weighted).toBe(1235);
    expect(answer.months[0]).toMatchObject({ month: '2026-10', pipeline: 12_345 });
    expect(answer.target).toEqual({ target: 3000, gap: -1765, attainmentPct: 41.2 });
    // Two open deals of one weighted amount are listed by deal id.
    const tied = analyseRows(
      { rows: [{ ...row, deal: 'D-3' }, row, { ...row, deal: 'D-2' }], rowNumbers: [2, 3, 4] },
      {},
    );
    expect(tied.deals.map((deal) => deal.deal)).toEqual(['D-1', 'D-2', 'D-3']);
  });

  it('refuses what it cannot compute rather than guessing, naming the row and column', () => {
    const row = 'D-1,A,商談中,1000,50,2026-10';
    expect(refusalOf(`${HEADER}D-1,A,保留,1000,50,2026-10`)).toMatchObject({
      code: 1,
      error: 'unknown_stage',
      row: 2,
      column: 'stage',
    });
    expect(refusalOf(`${HEADER}D-1,A,受注,1000,50,10月`).error).toBe('not_a_month');
    expect(refusalOf(`${HEADER}D-1,A,受注,1000,50,2026-13`).error).toBe('not_a_month');
    expect(refusalOf(`${HEADER}D-1,A,受注,-1000,50,2026-10`).error).toBe('not_an_amount');
    expect(refusalOf(`${HEADER}D-1,A,受注,1000,101,2026-10`).error).toBe('not_a_probability');
    expect(refusalOf(`${HEADER}D-1,A,受注,1000,-1,2026-10`).error).toBe('not_a_probability');
    expect(refusalOf(`${HEADER}${row}\nD-1,B,受注,500,100,2026-11`)).toMatchObject({
      error: 'duplicate_deal',
      row: 3,
    });
    expect(refusalOf(`${HEADER}D-1,A,受注,1000,50,`).error).toBe('empty_cell');
    expect(refusalOf('案件ID,金額\nD-1,1').error).toBe('missing_column');
    expect(refusalOf(HEADER).error).toBe('no_rows');
    expect(refusalOf(`${HEADER}${row}`, ['--quarter', '2026-Q1'])).toMatchObject({
      code: 1,
      error: 'unknown_quarter',
    });
    for (const args of [
      ['--quarter', 'Q4'],
      ['--target', '45百万'],
      ['--target', '0'],
      ['--targets', '1'],
      ['--quarter'],
    ]) {
      expect(refusalOf(`${HEADER}${row}`, args)).toMatchObject({ code: 2, error: 'usage' });
    }
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'forecast', access: 'read' }]);
  });

  it('asks its typed eval runs for the chart rows the script prints', () => {
    const text = readFileSync(new URL('evals/forecast.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/forecast.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    const declared = surface.resultCharts?.map((chart) => chart.field);
    expect(declared).toEqual(['months', 'deals']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of ['quarter', 'total', 'target', 'lost', 'commentary', ...(declared ?? [])]) {
      expect(required).toContain(field);
    }
  });
});
