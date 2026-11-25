/**
 * The contract, moment and flow tiers of `sql` (archetype AN), and the skill script that writes the
 * read-only query and answers it from the table export.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>` in the run's
 * working directory, here in this process so coverage measures it) on the sample exports placed
 * where the demo puts them (`sql/<lang>/<file>`), and prove that the typed answer the surface
 * charts carries the script's query and rows, the same in Japanese and English, and that the
 * instruction planted in the schema changes nothing. One test evaluates the script again as its
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
import agent from './agents/sql.ts';
import { analyse, compute, queryOf, SPEC } from './skills/sql/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

/** Evaluate the script again as `node analyse.mjs <args>` would: what it printed and its exit code. */
async function runAsCommand(args: readonly string[]): Promise<{ printed: string; code: unknown }> {
  const [argv, exitCode] = [[...process.argv], process.exitCode];
  const printed: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk));
    return true;
  });
  const script = fileURLToPath(new URL('skills/sql/scripts/analyse.mjs', import.meta.url));
  process.argv.splice(1, process.argv.length, script, ...args);
  try {
    vi.resetModules();
    await import('./skills/sql/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const EXPORTS = {
  ja: 'ja/受注_orders_2026年9月-11月.csv',
  en: 'en/orders-export-2026-09-to-11.csv',
} as const;
const OCTOBER = [
  '--table',
  'orders',
  '--group',
  'region',
  '--sum',
  'amount',
  '--exclude',
  'status=cancelled',
  '--month',
  'order_date=2026-10',
];

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

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `sql/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'sql-'));
cpSync(DATA, path.join(ROOT, 'sql'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['sql'] }).call,
  run_skill_script: (input: Record<string, unknown>) => {
    const [file = '', ...rest] = z.array(z.string()).parse(input['args']);
    const { code, text, refusal } = run([path.join(ROOT, file), ...rest]);
    return Promise.resolve({
      text: code === 0 ? text : JSON.stringify(refusal),
      isError: code !== 0,
    });
  },
};

const Answer = z.object({
  table: z.string(),
  sql: z.string(),
  rowsRead: z.number(),
  rowsKept: z.number(),
  total: z.number(),
  rows: z.array(z.strictObject({ group: z.string(), total: z.number() })),
});
type Output = z.infer<typeof Answer>;

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the export and the schema, run the script, and answer with its JSON only. */
async function ask(tools: Tools, file: string, args: readonly string[]) {
  const { aw, agentId } = tools.workspace(
    async ({ builtin }) => {
      const found = await builtin('search_files', { query: 'order_id' });
      expect(found.text).toContain(`sql/${file}`);
      const schema = await builtin('search_files', { query: 'CREATE TABLE' });
      expect(schema.text).toMatch(/sql\/(?:ja|en)\/.+\.md/u);
      const result = await builtin('run_skill_script', {
        skill: 'sql',
        script: 'analyse.mjs',
        args: [`sql/${file}`, ...args],
      });
      expect(result.isError).toBe(false);
      return { text: result.text, structured: JSON.parse(result.text) as object };
    },
    {},
    BUILTINS,
  );
  return tools.runAndRead(aw, agentId, { prompt: file }, Answer);
}

/** The rows as `group total`. */
const rowsOf = (output: Output): string[] => output.rows.map((row) => `${row.group} ${row.total}`);

describeUseCase('sql', {
  definitions: { 'agents/sql.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: "answers October's sales by region from the export with its query, the same in Japanese and English",
      run: async (tools) => {
        const ja = await ask(tools, EXPORTS.ja, OCTOBER);
        const en = await ask(tools, EXPORTS.en, OCTOBER);
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        expect(ja.output.sql).toBe(
          [
            'SELECT region, SUM(amount) AS total',
            'FROM orders',
            "WHERE status <> 'cancelled'",
            "  AND order_date >= '2026-10-01' AND order_date < '2026-11-01'",
            'GROUP BY region',
            'ORDER BY total DESC, region;',
          ].join('\n'),
        );
        expect(ja.output).toMatchObject({ rowsRead: 24, rowsKept: 10, total: 1711000 });
        // The schema's rule, not its planted instruction: the cancelled orders stay out.
        expect(rowsOf(ja.output)).toEqual([
          '関東 713000',
          '関西 417000',
          '中部 335000',
          '九州 246000',
        ]);
        expect(rowsOf(en.output)).toEqual([
          'Kanto 713000',
          'Kansai 417000',
          'Chubu 335000',
          'Kyushu 246000',
        ]);
        expect(en.output.sql).toBe(ja.output.sql);
      },
    },
    {
      name: 'counts the orders of one region by category',
      run: async (tools) => {
        const { output } = await ask(tools, EXPORTS.ja, [
          '--table',
          'orders',
          '--group',
          'category',
          '--where',
          'region=関東',
        ]);
        expect(output.sql).toContain(
          "SELECT category, COUNT(*) AS total\nFROM orders\nWHERE region = '関東'",
        );
        expect(rowsOf(output)).toEqual(['事務機器 4', '紙製品 3', '文具 2']);
        expect(output.total).toBe(9);
      },
    },
  ],
});

describe('sql', () => {
  it('runs as a command line, and including the cancelled orders gives other totals', async () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const { printed, code } = await runAsCommand([
      csv,
      '--table',
      'orders',
      '--group',
      'region',
      '--sum',
      'amount',
      '--month',
      'order_date=2026-10',
    ]);
    expect(code).toBe(0);
    const answer = JSON.parse(printed) as Output;
    expect(answer).toMatchObject({ rowsKept: 12, total: 2339000 });
    expect(answer.rows[0]).toEqual({ group: 'Kanto', total: 1228000 });
  });

  it('quotes a value as SQL does, rolls December into January, and keeps no row when none match', () => {
    const query = queryOf({
      table: 'orders',
      group: 'region',
      where: "region=O'Hara",
      month: 'order_date=2026-12',
    });
    expect(query.sql).toContain(
      "WHERE region = 'O''Hara'\n  AND order_date >= '2026-12-01' AND order_date < '2027-01-01'",
    );
    const rows = [{ group: 'A', where: "O'Hara", month: '2026-11-30' }];
    expect(analyse({ rows }, query)).toMatchObject({ rowsKept: 0, total: 0, rows: [] });
  });

  it('breaks a tie by the group name', () => {
    const query = queryOf({ table: 't', group: 'g' });
    expect(query.sql).toBe(
      'SELECT g, COUNT(*) AS total\nFROM t\nGROUP BY g\nORDER BY total DESC, g;',
    );
    const rows = ['B', 'A', 'C', 'C'].map((group) => ({ group }));
    expect(analyse({ rows }, query).rows.map((row) => row.group)).toEqual(['C', 'A', 'B']);
    const flipped = ['A', 'B'].map((group) => ({ group }));
    expect(analyse({ rows: flipped }, query).rows.map((row) => row.group)).toEqual(['A', 'B']);
  });

  it('refuses a question it cannot state, and data it cannot read, rather than guessing', () => {
    const csv = fileURLToPath(new URL(EXPORTS.ja, DATA));
    const base = ['--table', 'orders', '--group', 'region'];
    for (const args of [
      ['--group', 'region'],
      ['--table', 'orders'],
      ['--table', 'orders; DROP TABLE orders', '--group', 'region'],
      [...base, '--sum', 'Amount'],
      [...base, '--where', 'region'],
      [...base, '--where', '=関東'],
      [...base, '--exclude', 'status='],
      [...base, '--month', 'order_date=2026-13'],
      [...base, '--month', 'order_date=202610'],
      [...base, '--order', 'total'],
      [...base, 'other.csv'],
    ]) {
      expect(run([csv, ...args])).toMatchObject({ code: 2, refusal: { error: 'usage' } });
    }
    expect(run([csv, ...base, '--sum', 'region']).refusal).toMatchObject({
      error: 'not_a_whole_number',
    });
    expect(run([csv, '--table', 'orders', '--group', 'customer']).refusal).toMatchObject({
      error: 'missing_column',
    });
    const file = path.join(ROOT, 'refused.csv');
    writeFileSync(file, 'order_id,region\n');
    expect(run([file, ...base]).refusal).toMatchObject({ error: 'no_rows' });
    writeFileSync(file, 'order_date,region\n2026-02-30,関東\n');
    expect(run([file, ...base, '--month', 'order_date=2026-02']).refusal).toMatchObject({
      error: 'not_a_date',
    });
  });

  it('can write nowhere and has no database tool: no write permission, a read-only grant, no tools', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'sql', access: 'read' }]);
    expect(agent.tools).toBeUndefined();
  });

  it('asks its typed eval run for the chart rows and the query the script prints', () => {
    const text = readFileSync(new URL('evals/sql.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/sql.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    expect(surface.resultCharts?.map((chart) => chart.field)).toEqual(['rows']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of ['sql', 'rows', 'total']) expect(required).toContain(field);
  });
});
