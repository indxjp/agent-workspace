/**
 * The contract, moment and flow tiers of `territory` (archetype AN), and the skill script that
 * splits the areas into territories.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>` in the run's
 * working directory, here in this process so coverage measures it) on the sample exports placed
 * where the demo puts them (`territory/<file>`), and prove that the typed answer the surface charts
 * carries the script's split, the same in Japanese and English, that the planted note changes
 * nothing, and that nothing in the answer is a person. One test evaluates the script again as its
 * command line.
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
import agent from './agents/territory.ts';
import { analyse as analyseRows, compute, SPEC } from './skills/territory/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

/** Evaluate the script again as `node analyse.mjs <args>` would: what it printed and its exit code. */
async function runAsCommand(args: readonly string[]): Promise<{ printed: string; code: unknown }> {
  const [argv, exitCode] = [[...process.argv], process.exitCode];
  const printed: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk));
    return true;
  });
  const script = fileURLToPath(new URL('skills/territory/scripts/analyse.mjs', import.meta.url));
  process.argv.splice(1, process.argv.length, script, ...args);
  try {
    vi.resetModules();
    await import('./skills/territory/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const EXPORTS = {
  ja: 'ja/顧客一覧_2026年度上期.csv',
  en: 'en/customer-list-fy2026-h1.csv',
} as const;

/** The script's command line, as `runWhenMain` runs it: exit code, stdout and the refusal. */
function run(args: readonly string[]) {
  const [out, err]: [string[], string[]] = [[], []];
  const code = runScript(args, SPEC, compute, {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
  });
  const refusal = err.length === 0 ? undefined : (JSON.parse(err.join('')) as { error: string });
  return { code, text: out.join(''), stderr: err.join(''), refusal };
}

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `territory/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'territory-'));
cpSync(DATA, path.join(ROOT, 'territory'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['territory'] }).call,
  run_skill_script: (input: Record<string, unknown>) => {
    const [file = '', ...rest] = z.array(z.string()).parse(input['args']);
    const { code, text, stderr } = run([path.join(ROOT, file), ...rest]);
    return Promise.resolve({ text: code === 0 ? text : stderr, isError: code !== 0 });
  },
};

/** The code and row of the refusal the script prints for `content` as an export. */
function refusalOf(content: string, args: readonly string[] = []) {
  const file = path.join(ROOT, 'refused.csv');
  writeFileSync(file, content);
  const { code, refusal } = run([file, ...args]);
  return { code, ...z.object({ error: z.string(), row: z.number().optional() }).parse(refusal) };
}

const HEADER = '顧客ID,顧客名,都道府県,担当者,年間売上_千円,訪問回数,備考\n';

const Territory = z.strictObject({
  territory: z.string(),
  areas: z.array(z.string()),
  accounts: z.number(),
  sales: z.number(),
  visits: z.number(),
  value: z.number(),
  sharePct: z.number(),
});
const Answer = z.object({
  by: z.string(),
  count: z.number(),
  total: z.number(),
  spread: z.number(),
  spreadPct: z.number(),
  territories: z.array(Territory),
  notes: z.array(z.object({ id: z.string(), note: z.string() })),
});
type Output = z.infer<typeof Answer>;

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the export, run the script, and answer with its JSON and nothing else. */
async function plan(tools: Tools, file: string, query: string, args: readonly string[] = []) {
  const { aw, agentId } = tools.workspace(
    async ({ builtin }) => {
      const found = await builtin('search_files', { query });
      expect(found.text).toContain(`territory/${file}`);
      const result = await builtin('run_skill_script', {
        skill: 'territory',
        script: 'analyse.mjs',
        args: [`territory/${file}`, ...args],
      });
      expect(result.isError).toBe(false);
      return { text: result.text, structured: JSON.parse(result.text) as object };
    },
    {},
    BUILTINS,
  );
  return tools.runAndRead(aw, agentId, { prompt: file }, Answer);
}

/** Each territory as `name areas value share`. */
const splitOf = (output: Output): string[] =>
  output.territories.map((one) =>
    [one.territory, one.areas.join('+'), one.value, one.sharePct].join(' '),
  );

describeUseCase('territory', {
  definitions: { 'agents/territory.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'splits the areas into territories by sales, the same in Japanese and English',
      run: async (tools) => {
        const ja = await plan(tools, EXPORTS.ja, '都道府県');
        const en = await plan(tools, EXPORTS.en, 'prefecture');
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        expect(ja.output).toMatchObject({
          by: 'sales',
          count: 3,
          total: 144300,
          spread: 1600,
          spreadPct: 3.3,
        });
        expect(splitOf(ja.output)).toEqual([
          'T1 東京都+福岡県 48500 33.6',
          'T2 大阪府+千葉県+埼玉県 47100 32.6',
          'T3 愛知県+神奈川県+宮城県 48700 33.7',
        ]);
        expect(splitOf(en.output)).toEqual([
          'T1 Tokyo+Fukuoka 48500 33.6',
          'T2 Osaka+Chiba+Saitama 47100 32.6',
          'T3 Aichi+Kanagawa+Miyagi 48700 33.7',
        ]);
        // The planted note is data: Osaka keeps its sales, and the note is printed as a note.
        expect(ja.output.notes.map((note) => note.id)).toEqual(['C-1006', 'C-1013']);
        // No owner reaches the answer: the script never reads that column.
        for (const owner of ['汐見', '鳰川', '柊木', '楪']) {
          expect(JSON.stringify(ja.output)).not.toContain(owner);
        }
      },
    },
    {
      name: 'balances visits over four territories when asked',
      run: async (tools) => {
        const { output } = await plan(tools, EXPORTS.ja, '訪問回数', [
          '--territories',
          '4',
          '--by',
          'visits',
        ]);
        expect(output).toMatchObject({ by: 'visits', count: 4, spread: 7, spreadPct: 13.5 });
        expect(splitOf(output)).toEqual([
          'T1 東京都 54 26',
          'T2 大阪府+福岡県 49 23.6',
          'T3 愛知県+埼玉県 49 23.6',
          'T4 神奈川県+千葉県+宮城県 56 26.9',
        ]);
      },
    },
  ],
});

describe('territory', () => {
  it('runs as a command line: the number of territories and the measure it is given', async () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const { printed, code } = await runAsCommand([csv, '--territories', '2', '--by', 'accounts']);
    expect(code).toBe(0);
    const answer = JSON.parse(printed) as Output;
    expect(answer).toMatchObject({ by: 'accounts', count: 2, total: 20, spread: 0 });
  });

  it('places the larger area first, breaks a tie by name, and gives a tie to the first territory', () => {
    const row = (id: string, area: string, sales: number) => ({
      id,
      customer: id,
      area,
      sales,
      visits: 1,
      note: null,
    });
    const rows = [row('1', 'B', 5), row('2', 'A', 5), row('3', 'C', 2), row('4', 'A', 0)];
    const result = analyseRows({ rows, rowNumbers: [2, 3, 4, 5] }, { territories: '2' });
    expect(result.territories.map((one) => one.areas)).toEqual([['A', 'C'], ['B']]);
    expect(result.notes).toEqual([]);
    const flipped = analyseRows({ rows: rows.slice(0, 3).reverse(), rowNumbers: [2, 3, 4] }, {});
    expect(flipped.areas.map((one) => one.area)).toEqual(['A', 'B', 'C']);
  });

  it('refuses what it cannot compute rather than guessing', () => {
    const row = 'C-1,株式会社テスト,東京都,担当,100,2,';
    const other = 'C-2,株式会社テスト2,大阪府,担当,100,2,';
    expect(refusalOf(`${HEADER}${row}\n${row}`)).toMatchObject({ error: 'duplicate_row', row: 3 });
    expect(refusalOf(`${HEADER}C-1,テスト,東京都,担当,-5,2,`)).toMatchObject({
      error: 'negative_value',
      row: 2,
    });
    expect(refusalOf(`${HEADER}C-1,テスト,東京都,担当,5,-2,`).error).toBe('negative_value');
    expect(refusalOf(`${HEADER}C-1,テスト,東京都,担当,多い,2,`).error).toBe('not_a_whole_number');
    expect(refusalOf(`${HEADER}${row}\n${other}`, ['--territories', '3'])).toMatchObject({
      code: 1,
      error: 'too_few_areas',
    });
    expect(
      refusalOf(`${HEADER}C-1,テ,東京都,担当,0,0,\nC-2,テ,大阪府,担当,0,0,`, ['--territories', '2'])
        .error,
    ).toBe('nothing_to_balance');
    expect(refusalOf(HEADER).error).toBe('no_rows');
    expect(refusalOf('顧客ID,都道府県\nC-1,東京都').error).toBe('missing_column');
    for (const args of [
      ['--territories', '1'],
      ['--territories', '10'],
      ['--by', 'owner'],
    ]) {
      expect(refusalOf(`${HEADER}${row}\n${other}`, args)).toMatchObject({
        code: 2,
        error: 'usage',
      });
    }
  });

  it('refuses an option it does not know, an option with no value and a second file', () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    for (const args of [['--owner', 'x'], ['other.csv'], ['--by']]) {
      expect(run([csv, ...args])).toMatchObject({ code: 2, refusal: { error: 'usage' } });
    }
    expect(run([path.join(ROOT, 'territory', 'missing.csv')]).refusal).toMatchObject({
      error: 'unreadable_file',
    });
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'territory', access: 'read' }]);
  });

  it('asks its typed eval run for the chart rows the script prints, and no field about a person', () => {
    const text = readFileSync(new URL('evals/territory.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/territory.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    expect(surface.resultCharts?.map((chart) => chart.field)).toEqual(['territories']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    expect(required).toContain('territories');
    expect(JSON.stringify(schemas[0])).not.toMatch(/owner|person|rep|score|rank/u);
  });
});
