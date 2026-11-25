/**
 * The contract, moment and flow tiers of `cash` (archetype AN), and the skill script that computes
 * every number it reports.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>` in the run's
 * working directory, here in this process so coverage measures it) on the sample exports placed
 * where the demo puts them (`cash/<lang>/<file>`), and prove that the typed answer the surface
 * charts carries the script's numbers, the same in Japanese and English, and that a note asking to
 * leave a payment out changes nothing. The tests below pin what the script refuses.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runScript } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createFileSearch } from '../../tests/gallery/harness/file-search.ts';
import type { scriptedWorkspace } from '../../tests/gallery/harness/scripted-workspace.ts';
import type { runAndRead } from '../../tests/gallery/shared/run-answer.ts';
import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/cash.ts';
import { compute, forecast, SPEC } from './skills/cash/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

const FILES = {
  ja: ['ja/入出金予定_2026-11-20.csv', 'ja/口座残高_2026-11-20.csv'],
  en: ['en/scheduled-flows_2026-11-20.csv', 'en/bank-balances_2026-11-20.csv'],
} as const;

/**
 * The script's command line, as `runWhenMain` runs it: the exit code, what it printed on stdout and
 * the refusal it printed on stderr (`{ error, message, row? }`), if any.
 */
function run(args: readonly string[]) {
  const [out, err]: [string[], string[]] = [[], []];
  const code = runScript(args, SPEC, compute, {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
  });
  const refusal =
    err.length === 0 ? undefined : (JSON.parse(err.join('')) as { error: string; row?: number });
  return { code, text: out.join(''), refusal };
}

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `cash/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'cash-'));
cpSync(new URL('data/', import.meta.url), path.join(ROOT, 'cash'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['cash'] }).call,
  run_skill_script: (input: Record<string, unknown>) => {
    const [flows = '', balances = '', ...rest] = z.array(z.string()).parse(input['args']);
    const { code, text, refusal } = run([
      path.join(ROOT, flows),
      path.join(ROOT, balances),
      ...rest,
    ]);
    return Promise.resolve({
      text: code === 0 ? text : JSON.stringify(refusal),
      isError: code !== 0,
    });
  },
};

/** A file of `content` in the test's workspace: its path. */
function exportFile(name: string, content: string): string {
  const file = path.join(ROOT, name);
  writeFileSync(file, content);
  return file;
}

const BALANCES = exportFile('balances.csv', 'as_of,account,balance\n2026-11-20,A,1000\n');
const FLOWS_HEADER = 'date,direction,counterparty,amount\n';

/** The refusal the script prints for `flows` (CSV text) against `balances` (a path). */
function refusalOf(flows: string, balances = BALANCES, args: readonly string[] = []) {
  const { code, refusal } = run([exportFile('flows.csv', flows), balances, ...args]);
  return { code, ...refusal };
}

const Week = z.strictObject({
  week: z.string(),
  inflow: z.number().int(),
  outflow: z.number().int(),
  net: z.number().int(),
  closing: z.number().int(),
  short: z.boolean(),
});
const Answer = z.object({
  asOf: z.string(),
  opening: z.number().int(),
  minimum: z.number().int(),
  weeks: z.array(Week),
  lowest: z.strictObject({ week: z.string(), closing: z.number().int() }),
  short: z.array(z.string()),
  commentary: z.string(),
});

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the exports, run the script, and answer with its JSON and nothing else. */
async function forecastRun(
  { workspace, runAndRead: read }: Tools,
  lang: keyof typeof FILES,
  query: string,
  extra: readonly string[] = [],
) {
  const { aw, agentId } = workspace(
    async ({ builtin }) => {
      const found = await builtin('search_files', { query });
      for (const file of FILES[lang]) expect(found.text).toContain(`cash/${file}`);
      const result = await builtin('run_skill_script', {
        skill: 'cash',
        script: 'analyse.mjs',
        args: [...FILES[lang].map((file) => `cash/${file}`), ...extra],
      });
      expect(result.isError).toBe(false);
      // The typed answer is what the script printed, less `outside` (which the commentary mentions).
      const printed = Object.entries(JSON.parse(result.text) as Record<string, unknown>);
      const computed = Object.fromEntries(printed.filter(([key]) => key !== 'outside'));
      return { text: result.text, structured: { ...computed, commentary: '' } };
    },
    {},
    BUILTINS,
  );
  return read(aw, agentId, { prompt: query }, Answer);
}

describeUseCase('cash', {
  definitions: { 'agents/cash.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'computes the 13 weeks with the script, the same in Japanese and English',
      run: async (tools) => {
        const ja = await forecastRun(tools, 'ja', '2026/11/20');
        const en = await forecastRun(tools, 'en', '2026-11-20');
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        expect(ja.output).toEqual(en.output);
        expect(ja.output).toMatchObject({
          asOf: '2026-11-20',
          opening: 43_800_000,
          minimum: 0,
          lowest: { week: '2027-02-12', closing: 10_450_000 },
          short: [],
        });
        expect(ja.output.weeks).toHaveLength(13);
        // The inspection equipment payment the note asks to leave out is in its week all the same.
        expect(ja.output.weeks[7]).toEqual({
          week: '2027-01-15',
          inflow: 0,
          outflow: 20_900_000,
          net: -20_900_000,
          closing: 15_200_000,
          short: false,
        });
      },
    },
    {
      name: 'flags the weeks below the minimum the request names',
      run: async (tools) => {
        const { output } = await forecastRun(tools, 'ja', '2026/11/20', ['--minimum', '15000000']);
        expect(output.short).toEqual(['2027-01-29', '2027-02-05', '2027-02-12']);
        expect(output.weeks.map((week) => week.closing).slice(-6)).toEqual([
          15_200_000, 15_200_000, 14_750_000, 11_650_000, 10_450_000, 16_050_000,
        ]);
      },
    },
  ],
});

describe('cash', () => {
  it('leaves out the flows the balance already holds and those after the 13th week', () => {
    const { code, text } = run(FILES.en.map((file) => path.join(ROOT, 'cash', file)));
    expect(code).toBe(0);
    expect(JSON.parse(text)).toMatchObject({ outside: [2, 27] });
  });

  it('sums every account of the balance date, and counts receipts and payments by direction', () => {
    const balances = exportFile(
      'two.csv',
      '基準日,口座,残高\n2026/11/20,普通,"1,000"\n2026/11/20,当座,500\n',
    );
    const flows = `予定日,区分,取引先,金額\n2026/11/21,入金,甲,300\n2026/11/27,出金,乙,2000\n2026/11/28,出金,丙,100\n`;
    const { code, text } = run([exportFile('flows.csv', flows), balances]);
    expect(code).toBe(0);
    const { opening, weeks, lowest } = Answer.omit({ commentary: true }).parse(JSON.parse(text));
    expect(opening).toBe(1500);
    expect(weeks.slice(0, 2)).toEqual([
      { week: '2026-11-27', inflow: 300, outflow: 2000, net: -1700, closing: -200, short: true },
      { week: '2026-12-04', inflow: 0, outflow: 100, net: -100, closing: -300, short: true },
    ]);
    expect(lowest).toEqual({ week: '2026-12-04', closing: -300 });
  });

  it('has a default minimum of 0 when called without one', () => {
    const table = { rows: [], rowNumbers: [] };
    const balances = { rows: [{ asOf: '2026-11-20', account: 'A', balance: 5 }] };
    expect(forecast(table, balances, {})).toMatchObject({ minimum: 0, short: [], outside: [] });
  });

  it('refuses what it cannot compute rather than guessing', () => {
    const flow = '2026-11-21,in,A,100';
    expect(refusalOf(`${FLOWS_HEADER}2026-11-21,refund,A,100`)).toMatchObject({
      code: 1,
      error: 'unknown_direction',
      row: 2,
    });
    expect(refusalOf(`${FLOWS_HEADER}2026-11-21,out,A,0`)).toMatchObject({
      error: 'not_positive',
      row: 2,
    });
    expect(refusalOf(`${FLOWS_HEADER}2026-11-31,out,A,1`).error).toBe('not_a_date');
    expect(refusalOf(`${FLOWS_HEADER}2026-11-21,out,A,1.5`).error).toBe('not_a_whole_number');
    const empty = exportFile('empty.csv', 'as_of,account,balance\n');
    expect(refusalOf(`${FLOWS_HEADER}${flow}`, empty).error).toBe('no_rows');
    const mixed = exportFile(
      'mixed.csv',
      'as_of,account,balance\n2026-11-20,A,1\n2026-11-21,B,1\n',
    );
    expect(refusalOf(`${FLOWS_HEADER}${flow}`, mixed).error).toBe('mixed_dates');
    for (const minimum of ['15,000,000', '-1', 'high']) {
      expect(refusalOf(`${FLOWS_HEADER}${flow}`, BALANCES, ['--minimum', minimum])).toMatchObject({
        code: 2,
        error: 'usage',
      });
    }
    expect(run([exportFile('flows.csv', FLOWS_HEADER)])).toMatchObject({
      code: 2,
      refusal: { error: 'usage' },
    });
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'cash', access: 'read' }]);
  });

  it('asks its typed eval run for the weeks the surface charts', () => {
    const text = readFileSync(new URL('evals/cash.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/cash.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    expect(surface.resultCharts?.map((chart) => chart.field)).toEqual(['weeks', 'weeks']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    expect(required).toEqual([
      'asOf',
      'opening',
      'minimum',
      'weeks',
      'lowest',
      'short',
      'commentary',
    ]);
  });
});
