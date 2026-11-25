/**
 * The contract, moment and flow tiers of `spare-parts` (archetype AN), and the skill script that
 * computes every number it reports.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>`, here in this
 * process so coverage measures it) on the sample exports placed where the demo puts them
 * (`spare-parts/<file>`), and prove that the typed answer the surface charts carries the script's
 * numbers, the same in Japanese and English, and that a note in the stock list changes nothing.
 * The tests below pin what the script refuses, and one evaluates it again as its command line.
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
import agent from './agents/spare-parts.ts';
import { analyse as analyseRows, compute, SPEC } from './skills/spare-parts/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

const SCRIPT = 'skills/spare-parts/scripts/analyse.mjs';

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
    await import('./skills/spare-parts/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const FILES = {
  ja: { stock: 'ja/部品在庫_2026年10月末.csv', usage: 'ja/部品使用実績_2026年5月-10月.csv' },
  en: { stock: 'en/spare-parts-stock-2026-10-end.csv', usage: 'en/parts-usage-2026-05-to-10.csv' },
} as const;
const NOTED = {
  ja: 'ja/部品在庫_2026年10月末_再提出.csv',
  en: 'en/spare-parts-stock-2026-10-end-resubmitted.csv',
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

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `spare-parts/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'spare-parts-'));
cpSync(DATA, path.join(ROOT, 'spare-parts'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['spare-parts'] }).call,
  run_skill_script: (input: Record<string, unknown>) => {
    const [stock = '', usage = '', ...rest] = z.array(z.string()).parse(input['args']);
    const { code, text, refusal } = run([path.join(ROOT, stock), path.join(ROOT, usage), ...rest]);
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

const STOCK = '部品番号,部品名,設備,在庫数,発注残,調達日数,発注単位\n';
const PART = 'SP-1,ベルト,C-1,2,0,30,1';
const USAGE = '年月,部品番号,使用数\n';

/** The refusal the script prints for these exports (stock list, usage log) and options. */
function refusalOf(stock: string, usage: string, args: readonly string[] = []) {
  const { code, refusal } = run([exportFile('s.csv', stock), exportFile('u.csv', usage), ...args]);
  const shape = z.object({
    error: z.string(),
    row: z.number().optional(),
    column: z.string().optional(),
  });
  return { code, ...shape.parse(refusal) };
}

const Part = z.strictObject({
  partNo: z.string(),
  partName: z.string(),
  equipment: z.string(),
  used: z.number().int(),
  avgMonthly: z.number(),
  reorderPoint: z.number().int(),
  onHand: z.number().int(),
  onOrder: z.number().int(),
  available: z.number().int(),
  coveredByOrder: z.boolean(),
  order: z.number().int(),
  rising: z.boolean(),
});
const Answer = z.object({
  from: z.string(),
  to: z.string(),
  months: z.number().int(),
  toOrder: z.array(Part),
  trend: z.array(z.strictObject({ month: z.string(), used: z.number().int() })),
  commentary: z.string(),
});

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find both exports, run the script, and answer with its JSON and nothing else. */
async function suggest(tools: Tools, stock: string, usage: string, args: readonly string[] = []) {
  const { aw, agentId } = tools.workspace(
    async ({ builtin }) => {
      for (const [file, query] of [
        [stock, stock.startsWith('ja/') ? '発注単位' : 'lot'],
        [usage, usage.startsWith('ja/') ? '使用数' : 'used'],
      ]) {
        const found = await builtin('search_files', { query });
        expect(found.text).toContain(`spare-parts/${file}`);
      }
      const result = await builtin('run_skill_script', {
        skill: 'spare-parts',
        script: 'analyse.mjs',
        args: [`spare-parts/${stock}`, `spare-parts/${usage}`, ...args],
      });
      expect(result.isError).toBe(false);
      const computed = JSON.parse(result.text) as Record<string, unknown>;
      return { text: result.text, structured: { ...computed, parts: undefined, commentary: '' } };
    },
    {},
    BUILTINS,
  );
  return tools.runAndRead(aw, agentId, { prompt: stock }, Answer);
}

/** The parts to order as `partNo order`. */
const ordersOf = (output: { toOrder: readonly { partNo: string; order: number }[] }): string[] =>
  output.toOrder.map((part) => `${part.partNo} ${String(part.order)}`);

describeUseCase('spare-parts', {
  definitions: { 'agents/spare-parts.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'suggests the parts to order with the script, the same in Japanese and English',
      run: async (tools) => {
        const ja = await suggest(tools, FILES.ja.stock, FILES.ja.usage);
        const en = await suggest(tools, FILES.en.stock, FILES.en.usage);
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        const all = ['SP-101 2', 'SP-103 1', 'SP-106 10', 'SP-107 1', 'SP-110 4'];
        expect(ordersOf(ja.output)).toEqual(all);
        expect(ordersOf(en.output)).toEqual(all);
        expect(ja.output.toOrder[2]).toMatchObject({
          used: 24,
          avgMonthly: 4,
          reorderPoint: 6,
          available: 5,
        });
        expect(ja.output.trend.map((row) => row.used)).toEqual([12, 11, 12, 14, 14, 20]);
        // The last three months only: a different window, a different suggestion.
        const recent = await suggest(tools, FILES.ja.stock, FILES.ja.usage, ['--months', '3']);
        expect(recent.output).toMatchObject({ from: '2026-08', to: '2026-10', months: 3 });
        expect(ordersOf(recent.output)).toEqual(['SP-101 4', 'SP-106 10', 'SP-107 2', 'SP-110 4']);
      },
    },
    {
      name: 'reads a note in the stock list as data: the part it asks to order is not ordered',
      run: async (tools) => {
        for (const lang of ['ja', 'en'] as const) {
          const { output } = await suggest(tools, NOTED[lang], FILES[lang].usage);
          expect(ordersOf(output)).not.toContain('SP-102');
          expect(output.toOrder.map((part) => part.partNo)).not.toContain('SP-102');
        }
      },
    },
  ],
});

describe('spare-parts', () => {
  it('runs as a command line over every month of the log by default', async () => {
    const [stock, usage] = [FILES.en.stock, FILES.en.usage].map((file) =>
      fileURLToPath(new URL(file, DATA)),
    );
    const { printed, code } = await runAsCommand([String(stock), String(usage)]);
    expect(code).toBe(0);
    const answer = JSON.parse(printed) as { parts: z.infer<typeof Part>[] } & z.infer<
      typeof Answer
    >;
    expect(answer).toMatchObject({ from: '2026-05', to: '2026-10', months: 6 });
    // On order covers the V-belt; the limit switch was never used; the thermocouple has stock.
    const byPart = new Map(answer.parts.map((part) => [part.partNo, part]));
    expect(byPart.get('SP-104')).toMatchObject({
      reorderPoint: 5,
      onHand: 2,
      onOrder: 6,
      available: 8,
      coveredByOrder: true,
      order: 0,
      rising: true,
    });
    expect(byPart.get('SP-109')).toMatchObject({
      used: 0,
      avgMonthly: 0,
      reorderPoint: 0,
      order: 0,
    });
    expect(byPart.get('SP-102')).toMatchObject({
      avgMonthly: 0.67,
      order: 0,
      coveredByOrder: false,
      rising: false,
    });
    expect([...byPart.values()].filter((part) => part.coveredByOrder).map((p) => p.partNo)).toEqual(
      ['SP-104'],
    );
  });

  it('splits an odd window around its middle month and rounds up to a whole lot', () => {
    const stock = {
      rows: [
        {
          partNo: 'P',
          partName: 'n',
          equipment: 'e',
          onHand: 0,
          onOrder: 1,
          leadDays: 30,
          lot: 4,
        },
      ],
      rowNumbers: [2],
    };
    const usage = {
      rows: [
        { month: '2026-01', partNo: 'P', used: 1 },
        { month: '2026-02', partNo: 'P', used: 9 },
        { month: '2026-03', partNo: 'P', used: 1 },
      ],
      rowNumbers: [2, 3, 4],
    };
    const { parts } = analyseRows(stock, usage, {});
    // 11 used over 3 months: 3.67 a month, ceil(11 × 60 / 90) = 8, short by 7, so two lots of 4.
    expect(parts[0]).toMatchObject({
      avgMonthly: 3.67,
      reorderPoint: 8,
      available: 1,
      order: 8,
      rising: false,
    });
  });

  it('refuses what it cannot compute rather than guessing', () => {
    const use = `${USAGE}2026-10,SP-1,1`;
    expect(
      JSON.parse(run([exportFile('s.csv', `${STOCK}${PART}`), exportFile('u.csv', use)]).text),
    ).toMatchObject({
      toOrder: [],
    });
    expect(refusalOf(`${STOCK}${PART}`, `${USAGE}2026-10,SP-9,1`)).toMatchObject({
      code: 1,
      error: 'unknown_part',
      row: 2,
    });
    for (const month of ['10月', '2026-13', '2026-00']) {
      expect(refusalOf(`${STOCK}${PART}`, `${USAGE}${month},SP-1,1`)).toMatchObject({
        error: 'not_a_month',
        row: 2,
        column: 'month',
      });
    }
    expect(refusalOf(`${STOCK}${PART}\n${PART}`, use)).toMatchObject({
      error: 'duplicate_row',
      row: 3,
      column: 'part_no',
    });
    expect(refusalOf(`${STOCK}${PART}`, `${use}\n2026-10,SP-1,2`)).toMatchObject({
      error: 'duplicate_row',
      row: 3,
    });
    expect(refusalOf(`${STOCK}SP-1,ベルト,C-1,2,0,30,0`, use)).toMatchObject({
      error: 'out_of_range',
      row: 2,
      column: 'lot',
    });
    expect(refusalOf(`${STOCK}SP-1,ベルト,C-1,-2,0,30,1`, use).column).toBe('on_hand');
    expect(refusalOf(`${STOCK}${PART}`, `${USAGE}2026-10,SP-1,-1`).error).toBe('out_of_range');
    expect(refusalOf(`${STOCK}${PART}`, USAGE).error).toBe('no_rows');
    expect(refusalOf(`${STOCK}${PART}`, `${USAGE}2026-10,SP-1,1.5`).error).toBe(
      'not_a_whole_number',
    );
    expect(refusalOf('部品番号\nSP-1', use).error).toBe('missing_column');
    for (const months of ['0', '2', 'all']) {
      expect(refusalOf(`${STOCK}${PART}`, use, ['--months', months])).toMatchObject({
        code: 2,
        error: 'usage',
      });
    }
  });

  it('refuses an option it does not know, a missing file and a file it cannot read', () => {
    const [stock, usage] = [FILES.ja.stock, FILES.ja.usage].map((file) =>
      fileURLToPath(new URL(file, DATA)),
    );
    expect(run([String(stock)])).toMatchObject({ code: 2, refusal: { error: 'usage' } });
    expect(run([String(stock), String(usage), '--month', '3'])).toMatchObject({ code: 2 });
    expect(run([String(stock), path.join(ROOT, 'missing.csv')]).refusal).toMatchObject({
      error: 'unreadable_file',
    });
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'spare-parts', access: 'read' }]);
  });

  it('asks its typed eval runs for the chart rows the script prints', () => {
    const text = readFileSync(new URL('evals/spare-parts.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/spare-parts.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    const declared = surface.resultCharts?.map((chart) => chart.field);
    expect(declared).toEqual(['toOrder', 'trend']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of ['from', 'to', 'months', 'commentary', ...(declared ?? [])]) {
      expect(required).toContain(field);
    }
  });
});
