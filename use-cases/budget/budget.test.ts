/**
 * The contract, moment and flow tiers of `budget` (archetype AN, the 100-use-case plan's reference
 * entry for it), and the skill script that computes every number it reports.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>` in the run's
 * working directory, here in this process so coverage measures it) on the sample exports placed
 * where the demo puts them (`budget/<file>`), and prove that the typed answer the surface charts
 * carries the script's numbers, the same in Japanese and English, and that a note in the export
 * changes nothing. The script reads the export with the built-in table reader and command line
 * (ADR-0173), so the tests below also pin what that reader refuses in a budget export, and that an
 * `.xlsx` of the same books gives the same numbers. One test evaluates the script again as its
 * command line (`node analyse.mjs <csv> --threshold 20`).
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
import agent from './agents/budget.ts';
import { analyse as analyseRows, compute, SPEC } from './skills/budget/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

/**
 * Evaluate the script again as `node analyse.mjs <args>` would: with `args` after its own path in
 * `process.argv`, printing to stdout. Returns what it printed and the exit code it set.
 */
async function runAsCommand(args: readonly string[]): Promise<{ printed: string; code: unknown }> {
  const [argv, exitCode] = [[...process.argv], process.exitCode];
  const printed: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk));
    return true;
  });
  const script = fileURLToPath(new URL('skills/budget/scripts/analyse.mjs', import.meta.url));
  process.argv.splice(1, process.argv.length, script, ...args);
  try {
    vi.resetModules();
    await import('./skills/budget/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const EXPORTS = {
  ja: 'ja/予実_2026年度上期_部門別.csv',
  en: 'en/budget-actual-FY2026-H1-by-department.csv',
} as const;
const NOTED = {
  ja: 'ja/予実_2026年9月_営業部差替.csv',
  en: 'en/budget-actual-2026-09-sales-resubmitted.csv',
} as const;

/**
 * The script's command line, as `runWhenMain` runs it: the exit code, what it printed on stdout and
 * the refusal it printed on stderr (`{ error, message, row?, column?, value? }`), if any.
 */
function run(args: readonly string[]) {
  const [out, err]: [string[], string[]] = [[], []];
  const code = runScript(args, SPEC, compute, {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
  });
  const refusal = err.length === 0 ? undefined : (JSON.parse(err.join('')) as { error: string });
  return { code, text: out.join(''), stderr: err.join(''), refusal };
}

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `budget/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'budget-'));
cpSync(DATA, path.join(ROOT, 'budget'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['budget'] }).call,
  run_skill_script: (input: Record<string, unknown>) => {
    const [file = '', ...rest] = z.array(z.string()).parse(input['args']);
    const { code, text, stderr } = run([path.join(ROOT, file), ...rest]);
    return Promise.resolve({ text: code === 0 ? text : stderr, isError: code !== 0 });
  },
};

/** A file of `content` in the test's workspace: its path. */
function exportFile(name: string, content: string | Buffer): string {
  const file = path.join(ROOT, name);
  writeFileSync(file, content);
  return file;
}

/** The code and row of the refusal the script prints for `content` as an export. */
function refusalOf(content: string, args: readonly string[] = []) {
  const { code, refusal } = run([exportFile('refused.csv', content), ...args]);
  return { code, ...z.object({ error: z.string(), row: z.number().optional() }).parse(refusal) };
}

const HEADER = '年月,部門,勘定科目,予算,実績\n';
const BOM = String.fromCodePoint(0xfeff);

const Figures = z.strictObject({
  budget: z.number().int(),
  actual: z.number().int(),
  variance: z.number().int(),
  variancePct: z.number().nullable(),
});
const Answer = z.object({
  month: z.string(),
  total: Figures,
  departments: z.array(Figures.extend({ department: z.string() })),
  trend: z.array(Figures.extend({ month: z.string() })),
  flagged: z.array(
    Figures.extend({
      department: z.string(),
      account: z.string(),
      ytd: Figures,
      flagged: z.boolean(),
    }),
  ),
  commentary: z.string(),
});

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the export, run the script, and answer with its JSON and nothing else. */
async function analyse({ workspace, runAndRead: read }: Tools, file: string, query: string) {
  const { aw, agentId } = workspace(
    async ({ builtin }) => {
      const found = await builtin('search_files', { query });
      expect(found.text).toContain(`budget/${file}`);
      const result = await builtin('run_skill_script', {
        skill: 'budget',
        script: 'analyse.mjs',
        args: [`budget/${file}`, '--month', '2026-09'],
      });
      expect(result.isError).toBe(false);
      const computed = JSON.parse(result.text) as object;
      return { text: result.text, structured: { ...computed, commentary: '' } };
    },
    {},
    BUILTINS,
  );
  return read(aw, agentId, { prompt: file }, Answer);
}

/** The flagged lines as `department account variance variancePct`. */
const flaggedOf = (output: z.infer<typeof Answer>): string[] =>
  output.flagged.map((line) =>
    [line.department, line.account, line.variance, line.variancePct].join(' '),
  );

describeUseCase('budget', {
  definitions: { 'agents/budget.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'computes the September variance with the script, the same in Japanese and English',
      run: async (tools) => {
        const ja = await analyse(tools, EXPORTS.ja, '予算');
        const en = await analyse(tools, EXPORTS.en, 'budget');
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        expect(flaggedOf(ja.output)).toEqual([
          '営業部 広告宣伝費 252000 28',
          '製造部 外注費 288000 12',
          '管理部 支払手数料 -57000 -15',
          '開発部 外注費 650000 ',
        ]);
        expect(flaggedOf(en.output)).toEqual([
          'Sales Advertising 252000 28',
          'Manufacturing Outsourcing 288000 12',
          'Administration Fees -57000 -15',
          'Development Outsourcing 650000 ',
        ]);
        expect(ja.output.total).toEqual({
          budget: 24_530_000,
          actual: 25_709_000,
          variance: 1_179_000,
          variancePct: 4.8,
        });
        // The two exports are one set of books: every number agrees, only the names differ.
        const numbers = (output: z.infer<typeof Answer>): unknown =>
          JSON.parse(
            JSON.stringify(output, (key, value: unknown) =>
              ['department', 'account'].includes(key) ? '' : value,
            ),
          );
        expect(numbers(ja.output)).toEqual(numbers(en.output));
        // The chart rows the surface declares: a department's month, and every month to September.
        expect(ja.output.departments.map((row) => row.variance)).toEqual([
          306_000, 235_000, -57_000, 695_000,
        ]);
        expect(ja.output.trend.map((row) => row.month)).toEqual([
          '2026-04',
          '2026-05',
          '2026-06',
          '2026-07',
          '2026-08',
          '2026-09',
        ]);
      },
    },
    {
      name: 'reads a note in the export as data: the variance it asks to hide is still flagged',
      run: async (tools) => {
        for (const [lang, query] of [
          ['ja', '備考'],
          ['en', 'note'],
        ] as const) {
          const { output } = await analyse(tools, NOTED[lang], query);
          expect(flaggedOf(output)).toEqual([
            lang === 'ja' ? '営業部 広告宣伝費 252000 28' : 'Sales Advertising 252000 28',
          ]);
        }
      },
    },
  ],
});

describe('budget', () => {
  it('runs as a command line: the last month by default, at the threshold it is given', async () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const { printed, code } = await runAsCommand([csv, '--threshold', '20']);
    expect(code).toBe(0);
    const answer = JSON.parse(printed) as z.infer<typeof Answer>;
    expect(answer).toMatchObject({ month: '2026-09', from: '2026-04', threshold: 20 });
    expect(flaggedOf({ ...answer, commentary: '' })).toEqual([
      'Sales Advertising 252000 28',
      'Development Outsourcing 650000 ',
    ]);
  });

  it('computes an .xlsx of the same books to the same numbers as the CSV', () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const [header = [], ...records] = readFileSync(csv, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(','));
    // The amounts as number cells, the rest as text, as an accounting export writes them.
    const rows = records.map((cells) => cells.map((cell, at) => (at >= 5 ? Number(cell) : cell)));
    const xlsx = exportFile(
      'books.xlsx',
      writeXlsx({ sheets: [{ name: '予実', rows: [header, ...rows] }] }),
    );
    const fromXlsx = run([xlsx, '--month', '2026-09']);
    expect(fromXlsx.code).toBe(0);
    expect(fromXlsx.text).toBe(run([csv, '--month', '2026-09']).text);
  });

  it('reads quoted fields, doubled quotes, CRLF, a byte order mark and a quoted thousands separator', () => {
    const csv = `${BOM}${HEADER.replace('\n', '\r\n')}2026/09,"営業部, 東","人件費 ""本社""","1,000",1100\r\n,,,,\r\n`;
    const { code, text } = run([exportFile('quoted.csv', csv)]);
    expect(code).toBe(0);
    expect(JSON.parse(text)).toMatchObject({
      month: '2026-09',
      total: { budget: 1000, actual: 1100, variance: 100, variancePct: 10 },
      lines: [{ department: '営業部, 東', account: '人件費 "本社"' }],
    });
  });

  it('refuses a stray or unclosed quote and a row whose cells do not match the header', () => {
    // An unquoted inch mark would otherwise open a field that swallows the rows after it.
    expect(refusalOf(`${HEADER}2026-09,営業部,5" monitor,1,1\n2026-09,営業部,x,2,2`)).toMatchObject(
      {
        code: 1,
        error: 'stray_quote',
      },
    );
    expect(refusalOf(`${HEADER}2026-09,"営業部"x,a,1,1`).error).toBe('stray_quote');
    expect(refusalOf(`${HEADER}2026-09,"営業部,a,1,1\n2026-09,b,c,1,1`).error).toBe(
      'unclosed_quote',
    );
    // An unquoted thousands separator splits one amount into two cells.
    expect(refusalOf(`${HEADER}2026-09,営業部,人件費,1,000,900`)).toMatchObject({
      error: 'cell_count',
      row: 2,
    });
  });

  it('refuses an .xlsx amount that is only part of a merged range rather than counting it twice', () => {
    const rows = [
      ['month', 'department', 'account', 'budget', 'actual'],
      ['2026-09', 'Sales', 'Personnel', 100, 90],
      ['2026-09', 'Sales', 'Travel', 100, null],
    ];
    const xlsx = exportFile(
      'merged.xlsx',
      writeXlsx({ sheets: [{ name: 'S', rows, merges: ['E2:E3'] }] }),
    );
    expect(run([xlsx]).refusal).toMatchObject({ error: 'merged_cell', row: 3, column: 'actual' });
  });

  it('rounds the variance % half away from zero, the same above and below budget', () => {
    const row = {
      month: '2026/09',
      department: '営業部',
      account: '人件費',
      budget: 2000,
      actual: 2001,
    };
    const one = (actual: number) =>
      analyseRows({ rows: [{ ...row, actual }], rowNumbers: [2] }, {});
    expect(one(2001).total.variancePct).toBe(0.1);
    expect(one(1999).total.variancePct).toBe(-0.1);
    expect(one(2000).lines[0]).toMatchObject({ variancePct: 0, flagged: false });
  });

  it('refuses what it cannot compute rather than guessing', () => {
    const row = '2026/09,営業部,人件費,100,90';
    expect(JSON.parse(run([exportFile('one.csv', `${HEADER}${row}`)]).text)).toMatchObject({
      lines: [{ variance: -10, variancePct: -10 }],
    });
    expect(refusalOf(`${HEADER}2026/09,営業部,人件費,100,`)).toMatchObject({
      error: 'empty_cell',
      row: 2,
    });
    expect(refusalOf(`${HEADER}2026/09,営業部,人件費,1.5,1`).error).toBe('not_a_whole_number');
    expect(refusalOf(`${HEADER}9月,営業部,人件費,100,90`)).toMatchObject({
      error: 'not_a_month',
      row: 2,
    });
    expect(refusalOf(`${HEADER}2026/09, ,人件費,100,90`).error).toBe('empty_cell');
    expect(refusalOf('年月,予算\n2026/09,1').error).toBe('missing_column');
    for (const threshold of ['high', 'Infinity', '-1']) {
      expect(refusalOf(`${HEADER}${row}`, ['--threshold', threshold])).toMatchObject({
        code: 2,
        error: 'usage',
      });
    }
    expect(refusalOf(`${HEADER}${row}`, ['--month', '2026-10'])).toMatchObject({
      code: 1,
      error: 'unknown_month',
    });
    expect(refusalOf(HEADER).error).toBe('no_rows');
    expect(refusalOf(`${HEADER}${row}\n2026-09,営業部,人件費,100,80`)).toMatchObject({
      error: 'duplicate_row',
      row: 3,
    });
  });

  it('refuses an option it does not know, an option with no value and a second file', () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    for (const args of [
      ['--months', '2026-09'],
      ['2026-09'],
      ['--threshold'],
      ['--threshold', ''],
    ]) {
      expect(run([csv, ...args])).toMatchObject({ code: 2, refusal: { error: 'usage' } });
    }
  });

  it('prints a refusal on stderr for a file it cannot read, named or not', () => {
    expect(run([])).toMatchObject({ code: 2, text: '', refusal: { error: 'usage' } });
    const missing = run([path.join(ROOT, 'budget', 'missing.csv'), '--month', '2026-09']);
    expect(missing).toMatchObject({ code: 1, text: '', refusal: { error: 'unreadable_file' } });
    expect(missing.stderr).toContain('missing.csv');
    expect(run([exportFile('budget.txt', HEADER)]).refusal).toMatchObject({
      error: 'unsupported_format',
    });
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'budget', access: 'read' }]);
  });

  it('asks its typed eval runs for the chart rows and the flagged lines the script prints', () => {
    const text = readFileSync(new URL('evals/budget.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/budget.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    const declared = surface.resultCharts?.map((chart) => chart.field);
    expect(declared).toEqual(['departments', 'trend']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of ['month', 'total', 'flagged', 'commentary', ...(declared ?? [])]) {
      expect(required).toContain(field);
    }
  });
});
