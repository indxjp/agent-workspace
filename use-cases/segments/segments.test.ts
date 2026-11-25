/**
 * The contract, moment and flow tiers of `segments` (archetype AN), and the skill script that
 * computes every number and segment it reports.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>`, here in this
 * process so coverage measures it) on the sample exports placed where the demo puts them
 * (`segments/<file>`), and prove that the typed answer the surface charts carries the script's
 * numbers, the same in Japanese and English, and that a note in the export changes nothing. The
 * tests below pin the segment rules, what the script refuses, and one evaluates it again as its
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
import agent from './agents/segments.ts';
import { compute, SPEC } from './skills/segments/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

const SCRIPT = 'skills/segments/scripts/analyse.mjs';

/** Evaluate the script again as `node analyse.mjs <args>` would: what it printed and its exit code. */
async function runAsCommand(args: readonly string[]): Promise<{ printed: string; code: unknown }> {
  const [argv, exitCode] = [[...process.argv], process.exitCode];
  const printed: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk));
    return true;
  });
  const script = fileURLToPath(new URL(SCRIPT, import.meta.url));
  process.argv.splice(1, process.argv.length, script, ...args);
  try {
    vi.resetModules();
    await import('./skills/segments/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const EXPORTS = {
  ja: 'ja/注文明細_2025年12月-2026年11月.csv',
  en: 'en/orders-2025-12-to-2026-11.csv',
} as const;
const NOTED = {
  ja: 'ja/注文明細_2025年12月-2026年11月_備考付き.csv',
  en: 'en/orders-2025-12-to-2026-11-with-notes.csv',
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

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `segments/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'segments-'));
cpSync(DATA, path.join(ROOT, 'segments'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['segments'] }).call,
  run_skill_script: (input: Record<string, unknown>) => {
    const [file = '', ...rest] = z.array(z.string()).parse(input['args']);
    const { code, text, refusal } = run([path.join(ROOT, file), ...rest]);
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

const HEADER = 'order_no,order_date,customer_id,category,amount\n';

/** The refusal the script prints for `content` as an export and these options. */
function refusalOf(content: string, args: readonly string[] = []) {
  const { code, refusal } = run([exportFile('refused.csv', content), ...args]);
  return { code, ...z.object({ error: z.string(), row: z.number().optional() }).parse(refusal) };
}

const Segment = z.strictObject({
  segment: z.string(),
  customers: z.number().int(),
  orders: z.number().int(),
  revenue: z.number().int(),
  share: z.number(),
  avgOrders: z.number(),
  avgDays: z.number().int(),
  topCategory: z.string(),
});
const Answer = z.object({
  asOf: z.string(),
  from: z.string(),
  recentDays: z.number().int(),
  lapsedDays: z.number().int(),
  total: z.strictObject({
    customers: z.number().int(),
    orders: z.number().int(),
    revenue: z.number().int(),
  }),
  segments: z.array(Segment),
  commentary: z.string(),
});

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the export, run the script, and answer with its JSON and nothing else. */
async function segment(tools: Tools, file: string, query: string, args: readonly string[] = []) {
  const { aw, agentId } = tools.workspace(
    async ({ builtin }) => {
      const found = await builtin('search_files', { query });
      expect(found.text).toContain(`segments/${file}`);
      const result = await builtin('run_skill_script', {
        skill: 'segments',
        script: 'analyse.mjs',
        args: [`segments/${file}`, ...args],
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

/** The segments as `segment customers revenue share avgOrders avgDays topCategory`. */
const segmentsOf = (output: { segments: readonly z.infer<typeof Segment>[] }): string[] =>
  output.segments.map((row) =>
    [
      row.segment,
      row.customers,
      row.revenue,
      row.share,
      row.avgOrders,
      row.avgDays,
      row.topCategory,
    ].join(' '),
  );

describeUseCase('segments', {
  definitions: { 'agents/segments.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'segments the customers with the script, the same in Japanese and English',
      run: async (tools) => {
        const ja = await segment(tools, EXPORTS.ja, '顧客ID');
        const en = await segment(tools, EXPORTS.en, 'customer_id');
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        expect(ja.output).toMatchObject({
          asOf: '2026-11-18',
          from: '2025-12-15',
          total: { customers: 24, orders: 61, revenue: 556_400 },
        });
        expect(segmentsOf(ja.output)).toEqual([
          '優良 5 244700 44 5.2 9 家電',
          '一般 6 106900 19.2 2.33 37 衣料',
          '新規 4 51100 9.2 1 38 家電',
          '離反懸念 5 95400 17.1 2.2 134 家電',
          '休眠 4 58300 10.5 1.5 251 衣料',
        ]);
        expect(segmentsOf(en.output)).toEqual([
          'Loyal 5 244700 44 5.2 9 Appliances',
          'Regular 6 106900 19.2 2.33 37 Clothing',
          'New 4 51100 9.2 1 38 Appliances',
          'At risk 5 95400 17.1 2.2 134 Appliances',
          'Lapsed 4 58300 10.5 1.5 251 Clothing',
        ]);
        // As of another day: the orders after it are left out, and the customers move.
        const august = await segment(tools, EXPORTS.ja, '注文日', ['--as-of', '2026-08-31']);
        expect(august.output.total).toEqual({ customers: 20, orders: 37, revenue: 336_100 });
        expect(
          august.output.segments.map((row) => `${row.segment} ${String(row.customers)}`),
        ).toEqual(['優良 1', '一般 8', '新規 4', '離反懸念 4', '休眠 3']);
      },
    },
    {
      name: 'reads a note in the export as data: the segments are what the rules give',
      run: async (tools) => {
        for (const [lang, query] of [
          ['ja', '備考'],
          ['en', 'note'],
        ] as const) {
          const noted = await segment(tools, NOTED[lang], query);
          const plain = await segment(
            tools,
            EXPORTS[lang],
            query === '備考' ? '顧客ID' : 'customer_id',
          );
          expect(noted.output.segments).toEqual(plain.output.segments);
          expect(noted.output.segments[0]?.customers).toBe(5);
        }
      },
    },
  ],
});

describe('segments', () => {
  it('runs as a command line as of the last order date, and prints no customer ID', async () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const { printed, code } = await runAsCommand([csv]);
    expect(code).toBe(0);
    expect(JSON.parse(printed)).toMatchObject({
      asOf: '2026-11-18',
      recentDays: 90,
      lapsedDays: 180,
    });
    expect(printed).not.toMatch(/C-\d|A-\d/u);
  });

  it('applies each rule at its edge, and names the category with the most revenue', () => {
    const rows = [
      // L: 4 orders, the last 48 days before: loyal, and Beauty sells most. E: 90 days: still new.
      'a,2026-08-20,L,Food,100',
      'b,2026-09-01,L,Food,100',
      'c,2026-10-01,L,Beauty,350',
      'd,2026-08-25,L,Food,100',
      'e,2026-11-18,R,Food,100',
      'f,2026-11-01,R,Food,100',
      'k,2026-10-01,R,Beauty,50',
      'j,2026-08-20,E,Food,0',
      // K: 91 days, P: 180 days: at risk. Z: 181 days: lapsed.
      'g,2026-08-19,K,Food,0',
      'h,2026-05-22,P,Food,0',
      'i,2026-05-21,Z,Food,50',
    ];
    const answer = JSON.parse(
      run([exportFile('edges.csv', `${HEADER}${rows.join('\n')}`)]).text,
    ) as z.infer<typeof Answer>;
    expect(
      answer.segments.map((row) => `${row.segment} ${String(row.customers)} ${row.topCategory}`),
    ).toEqual([
      'Loyal 1 Beauty',
      'Regular 1 Food',
      'New 1 Food',
      'At risk 2 Food',
      'Lapsed 1 Food',
    ]);
    expect(answer.segments[0]).toMatchObject({ avgDays: 48, share: 68.4 });
    // Nothing sold: every share is 0, not a division by zero.
    const free = JSON.parse(
      run([exportFile('free.csv', `${HEADER}x,2026-11-18,N,Food,0`)]).text,
    ) as z.infer<typeof Answer>;
    expect(segmentsOf(free)).toEqual(['New 1 0 0 1 0 Food']);
  });

  it('refuses what it cannot compute rather than guessing', () => {
    const row = 'x,2026-11-18,N,Food,100';
    expect(refusalOf(`${HEADER}${row}\ny,2026-11-18,N,Food,-5`)).toMatchObject({
      code: 1,
      error: 'out_of_range',
      row: 3,
    });
    expect(refusalOf(HEADER).error).toBe('no_rows');
    expect(refusalOf(`${HEADER}${row}`, ['--as-of', '2026-01-01'])).toMatchObject({
      code: 1,
      error: 'no_orders',
    });
    for (const asOf of ['2026-02-30', '2026-13-01', '2026/11/18', 'today']) {
      expect(refusalOf(`${HEADER}${row}`, ['--as-of', asOf])).toMatchObject({
        code: 2,
        error: 'usage',
      });
    }
    expect(refusalOf(`${HEADER}x,11月18日,N,Food,100`).error).toBe('not_a_date');
    expect(refusalOf(`${HEADER}x,2026-11-18,N,Food,1.5`).error).toBe('not_a_whole_number');
    expect(refusalOf('order_no,customer_id\nx,N').error).toBe('missing_column');
  });

  it('refuses an option it does not know, a missing file and a file it cannot read', () => {
    const csv = fileURLToPath(new URL(EXPORTS.ja, DATA));
    expect(run([])).toMatchObject({ code: 2, refusal: { error: 'usage' } });
    expect(run([csv, '--segment', 'loyal'])).toMatchObject({ code: 2 });
    expect(run([path.join(ROOT, 'missing.csv')]).refusal).toMatchObject({
      error: 'unreadable_file',
    });
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'segments', access: 'read' }]);
  });

  it('asks its typed eval runs for the chart rows the script prints, and no customer', () => {
    const text = readFileSync(new URL('evals/segments.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/segments.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    const declared = surface.resultCharts?.map((chart) => chart.field);
    expect(declared).toEqual(['segments', 'segments']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of ['asOf', 'total', 'commentary', ...(declared ?? [])]) {
      expect(required).toContain(field);
    }
    expect(JSON.stringify(schemas[0])).not.toContain('customerId');
  });
});
