/**
 * The contract, moment and flow tiers of `kpi` (archetype AN), and the skill script that computes
 * every number it reports.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>` in the run's
 * working directory, here in this process so coverage measures it) on the sample exports placed
 * where the demo puts them (`kpi/<file>`), and prove that the typed answer the surface charts
 * carries the script's numbers, the same in Japanese and English, and that a note in the export
 * changes nothing. One test evaluates the script again as its command line.
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
import agent from './agents/kpi.ts';
import { analyse as analyseRows, compute, SPEC } from './skills/kpi/scripts/analyse.mjs';
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
  const script = fileURLToPath(new URL('skills/kpi/scripts/analyse.mjs', import.meta.url));
  process.argv.splice(1, process.argv.length, script, ...args);
  try {
    vi.resetModules();
    await import('./skills/kpi/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const EXPORTS = {
  ja: 'ja/週次KPI_2026年9月-11月.csv',
  en: 'en/weekly-kpi-2026-09-to-11.csv',
} as const;
const NOTED = {
  ja: 'ja/週次KPI_2026年11月16日週_差替.csv',
  en: 'en/weekly-kpi-week-of-2026-11-16-resubmitted.csv',
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

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `kpi/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'kpi-'));
cpSync(DATA, path.join(ROOT, 'kpi'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['kpi'] }).call,
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

const HEADER = '週,指標,値,単位,備考\n';

const Metric = z.strictObject({
  metric: z.string(),
  unit: z.string(),
  value: z.number(),
  previous: z.number().nullable(),
  change: z.number().nullable(),
  changePct: z.number().nullable(),
  avg4: z.number().nullable(),
  moved: z.boolean(),
  note: z.string().nullable(),
});
const Answer = z.object({
  week: z.string(),
  previousWeek: z.string().nullable(),
  threshold: z.number(),
  metrics: z.array(Metric),
  moved: z.array(Metric),
  commentary: z.string(),
});
type Output = z.infer<typeof Answer>;

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the export, run the script, and answer with its JSON and nothing else. */
async function analyse({ workspace, runAndRead: read }: Tools, file: string, query: string) {
  const { aw, agentId } = workspace(
    async ({ builtin }) => {
      const found = await builtin('search_files', { query });
      expect(found.text).toContain(`kpi/${file}`);
      const result = await builtin('run_skill_script', {
        skill: 'kpi',
        script: 'analyse.mjs',
        args: [`kpi/${file}`],
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

/** The moved metrics as `metric change changePct`. */
const movedOf = (output: Pick<Output, 'moved'>): string[] =>
  output.moved.map((line) => [line.metric, line.change, line.changePct].join(' '));

describeUseCase('kpi', {
  definitions: { 'agents/kpi.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: "computes the latest week's movers with the script, the same in Japanese and English",
      run: async (tools) => {
        const ja = await analyse(tools, EXPORTS.ja, '指標');
        const en = await analyse(tools, EXPORTS.en, 'metric');
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        expect(ja.output).toMatchObject({ week: '2026-11-16', previousWeek: '2026-11-09' });
        expect(movedOf(ja.output)).toEqual([
          '新規会員数 149 35',
          '平均応答時間 10.7 25.7',
          '解約率 0.2 11.8',
        ]);
        expect(movedOf(en.output)).toEqual([
          'New members 149 35',
          'Average response time 10.7 25.7',
          'Churn rate 0.2 11.8',
        ]);
        // The two exports are one set of numbers: every number agrees, only the words differ.
        const numbers = (output: Output): unknown =>
          JSON.parse(
            JSON.stringify(output, (key, value: unknown) =>
              ['metric', 'unit', 'note'].includes(key) ? '' : value,
            ),
          );
        expect(numbers(ja.output)).toEqual(numbers(en.output));
        // The chart rows the surface declares: every metric of the week, with no null to hide it.
        expect(ja.output.metrics.map((row) => row.changePct)).toEqual([
          35, 2.2, 2.4, 11.8, 25.7, 7.4,
        ]);
        expect(ja.output.metrics.map((row) => row.avg4)).toEqual([
          420, 85.5, 12357.5, 1.8, 42.13, 239,
        ]);
      },
    },
    {
      name: 'reads a note in the export as data: the metrics it asks to hide still moved',
      run: async (tools) => {
        for (const [lang, query] of [
          ['ja', '備考'],
          ['en', 'note'],
        ] as const) {
          const { output } = await analyse(tools, NOTED[lang], query);
          expect(output.moved).toHaveLength(3);
          expect(output.metrics.every((row) => row.avg4 === null)).toBe(true);
          expect(output.moved[0]?.note).toMatch(/AIへの指示|Instruction to the agent/u);
        }
      },
    },
  ],
});

describe('kpi', () => {
  it('runs as a command line: a named week at the threshold it is given', async () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const { printed, code } = await runAsCommand([
      csv,
      '--week',
      '2026-10-26',
      '--threshold',
      '20',
    ]);
    expect(code).toBe(0);
    const answer = JSON.parse(printed) as Output;
    expect(answer).toMatchObject({ week: '2026-10-26', previousWeek: '2026-10-19', threshold: 20 });
    expect(movedOf(answer)).toEqual(['Orders won -22 -23.9', 'Revenue -2740 -20.9']);
  });

  it('computes an .xlsx of the same numbers to the same result as the CSV', () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const [header = [], ...records] = readFileSync(csv, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(','));
    const rows = records.map((cells) => cells.map((cell, at) => (at === 2 ? Number(cell) : cell)));
    const xlsx = exportFile(
      'kpi.xlsx',
      writeXlsx({ sheets: [{ name: 'KPI', rows: [header, ...rows] }] }),
    );
    const fromXlsx = run([xlsx]);
    expect(fromXlsx.code).toBe(0);
    expect(fromXlsx.text).toBe(run([csv]).text);
  });

  it('gives a first week no previous value, and a metric that left zero no change %', () => {
    const rows = [
      { week: '2026-11-02', metric: 'A', value: 0, unit: '件', note: null },
      { week: '2026-11-02', metric: 'B', value: 4, unit: '件', note: null },
      { week: '2026-11-09', metric: 'A', value: 3, unit: '件', note: null },
      { week: '2026-11-09', metric: 'B', value: 4.04, unit: '件', note: null },
      { week: '2026-11-09', metric: 'C', value: 1, unit: '件', note: null },
      { week: '2026-11-09', metric: 'D', value: 2, unit: '件', note: null },
      { week: '2026-11-02', metric: 'D', value: 1, unit: '件', note: null },
    ];
    const both = { rows, rowNumbers: rows.map((_, at) => at + 2) };
    const first = analyseRows(both, { week: '2026-11-02' });
    expect(first.previousWeek).toBeNull();
    expect(first.metrics[0]).toMatchObject({
      previous: null,
      change: null,
      changePct: null,
      moved: false,
    });
    const second = analyseRows(both, {});
    expect(second.metrics.map((row) => [row.metric, row.change, row.changePct, row.moved])).toEqual(
      [
        ['A', 3, null, true],
        ['B', 0.04, 1, false],
        ['C', null, null, false],
        ['D', 1, 100, true],
      ],
    );
    // Changed from zero sorts first, then the largest change %.
    expect(second.moved.map((row) => row.metric)).toEqual(['A', 'D']);
    expect(analyseRows({ rows: rows.slice(0, 2), rowNumbers: [2, 3] }, {}).moved).toEqual([]);
  });

  it('rounds the change % half away from zero, the same up and down', () => {
    const row = (week: string, value: number) => ({
      week,
      metric: 'A',
      value,
      unit: '件',
      note: null,
    });
    const pct = (value: number) =>
      analyseRows(
        { rows: [row('2026-11-02', 2000), row('2026-11-09', value)], rowNumbers: [2, 3] },
        {},
      ).metrics[0]?.changePct;
    expect(pct(2001)).toBe(0.1);
    expect(pct(1999)).toBe(-0.1);
  });

  it('prints each value as read to two decimals, so the change is its difference', () => {
    const row = (week: string, value: number) => ({
      week,
      metric: 'A',
      value,
      unit: '',
      note: null,
    });
    const rows = [row('2026-11-09', 1.111), row('2026-11-16', 1.236)];
    expect(analyseRows({ rows, rowNumbers: [2, 3] }, {}).metrics[0]).toMatchObject({
      value: 1.24,
      previous: 1.11,
      change: 0.13,
    });
  });

  it('reads --week with slashes or a one-digit month and day as the same week', () => {
    const csv = `${HEADER}2026-11-09,受注件数,90,件,\n2026-11-16,受注件数,93,件,`;
    for (const week of ['2026/11/09', '2026-11-9', '2026/11/9']) {
      const file = exportFile('weeks.csv', csv);
      expect(JSON.parse(run([file, '--week', week]).text)).toMatchObject({ week: '2026-11-09' });
    }
  });

  it('refuses what it cannot compute rather than guessing', () => {
    const row = '2026-11-16,受注件数,93,件,';
    expect(refusalOf(`${HEADER}2026-11-16,受注件数,,件,`)).toMatchObject({
      error: 'empty_cell',
      row: 2,
    });
    expect(refusalOf(`${HEADER}2026-11-16,受注件数,多い,件,`).error).toBe('not_a_decimal');
    for (const week of ['11月16日週', '2026-02-30']) {
      expect(refusalOf(`${HEADER}${week},受注件数,93,件,`)).toMatchObject({
        error: 'not_a_date',
        row: 2,
      });
    }
    expect(refusalOf('週,値\n2026-11-16,1').error).toBe('missing_column');
    for (const threshold of ['high', 'Infinity', '-1']) {
      expect(refusalOf(`${HEADER}${row}`, ['--threshold', threshold])).toMatchObject({
        code: 2,
        error: 'usage',
      });
    }
    expect(refusalOf(`${HEADER}${row}`, ['--week', '2026-11-09'])).toMatchObject({
      code: 1,
      error: 'unknown_week',
    });
    expect(refusalOf(HEADER).error).toBe('no_rows');
    expect(refusalOf(`${HEADER}${row}\n2026/11/16,受注件数,90,件,`)).toMatchObject({
      error: 'duplicate_row',
      row: 3,
    });
  });

  it('refuses an option it does not know, an option with no value and a second file', () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    for (const args of [
      ['--weeks', '2026-11-16'],
      ['2026-11-16'],
      ['--threshold'],
      ['--threshold', ''],
    ]) {
      expect(run([csv, ...args])).toMatchObject({ code: 2, refusal: { error: 'usage' } });
    }
    expect(run([])).toMatchObject({ code: 2, text: '', refusal: { error: 'usage' } });
    expect(run([path.join(ROOT, 'kpi', 'missing.csv')]).refusal).toMatchObject({
      error: 'unreadable_file',
    });
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'kpi', access: 'read' }]);
  });

  it('asks its typed eval runs for the chart rows and the moved metrics the script prints', () => {
    const text = readFileSync(new URL('evals/kpi.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/kpi.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    const declared = surface.resultCharts?.map((chart) => chart.field);
    expect(declared).toEqual(['changes']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of ['week', 'moved', 'commentary', ...(declared ?? [])]) {
      expect(required).toContain(field);
    }
  });
});
