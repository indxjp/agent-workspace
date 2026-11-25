/**
 * The contract, moment and flow tiers of `pricing` (archetype AN), and the skill script that
 * computes every number it reports.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>`, here in this
 * process so coverage measures it) on the sample exports placed where the demo puts them
 * (`pricing/<file>`), and prove that the typed answer the surface charts carries the script's
 * numbers, the same in Japanese and English, and that a note in the export changes nothing. The
 * tests below pin the arithmetic, what the script refuses, and one evaluates it again as its
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
import agent from './agents/pricing.ts';
import { compute, SPEC } from './skills/pricing/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

const SCRIPT = 'skills/pricing/scripts/analyse.mjs';

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
    await import('./skills/pricing/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const EXPORTS = {
  ja: 'ja/商品別売上_2025年12月-2026年11月.csv',
  en: 'en/sales-by-product-2025-12-to-2026-11.csv',
} as const;
const NOTED = {
  ja: 'ja/商品別売上_2025年12月-2026年11月_備考付き.csv',
  en: 'en/sales-by-product-2025-12-to-2026-11-with-notes.csv',
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

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `pricing/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'pricing-'));
cpSync(DATA, path.join(ROOT, 'pricing'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['pricing'] }).call,
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

const HEADER = 'month,product_code,product_name,price,quantity\n';

/** The refusal the script prints for `content` as an export and these options. */
function refusalOf(content: string, args: readonly string[] = ['--change', '5']) {
  const { code, refusal } = run([exportFile('refused.csv', content), ...args]);
  return { code, ...z.object({ error: z.string(), row: z.number().optional() }).parse(refusal) };
}

const Product = z.strictObject({
  productCode: z.string(),
  productName: z.string(),
  price: z.number().int(),
  quantity: z.number().int(),
  revenue: z.number().int(),
  elasticity: z.number(),
  newPrice: z.number().int(),
  estQuantity: z.number().int(),
  estRevenue: z.number().int(),
  revenueChange: z.number().int(),
  revenueChangePct: z.number().nullable(),
});
const Answer = z.object({
  change: z.number(),
  from: z.string(),
  to: z.string(),
  products: z.array(Product),
  total: z.strictObject({
    revenue: z.number().int(),
    estRevenue: z.number().int(),
    revenueChange: z.number().int(),
  }),
  noHistory: z.array(z.strictObject({ productCode: z.string(), productName: z.string() })),
  trend: z.array(z.strictObject({ month: z.string(), revenue: z.number().int() })),
  commentary: z.string(),
});

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the export, run the script, and answer with its JSON and nothing else. */
async function estimate(tools: Tools, file: string, query: string, change: string) {
  const { aw, agentId } = tools.workspace(
    async ({ builtin }) => {
      const found = await builtin('search_files', { query });
      expect(found.text).toContain(`pricing/${file}`);
      const result = await builtin('run_skill_script', {
        skill: 'pricing',
        script: 'analyse.mjs',
        args: [`pricing/${file}`, '--change', change],
      });
      expect(result.isError).toBe(false);
      const computed = z
        .looseObject({ products: z.array(z.looseObject({})) })
        .parse(JSON.parse(result.text));
      // The typed answer leaves each product's past changes out.
      const products = computed.products.map((product) => ({ ...product, changes: undefined }));
      return { text: result.text, structured: { ...computed, products, commentary: '' } };
    },
    {},
    BUILTINS,
  );
  return tools.runAndRead(aw, agentId, { prompt: file }, Answer);
}

/** The products as `code elasticity revenueChange revenueChangePct`. */
const estimatesOf = (output: { products: readonly z.infer<typeof Product>[] }): string[] =>
  output.products.map((row) =>
    [row.productCode, row.elasticity, row.revenueChange, row.revenueChangePct].join(' '),
  );

describeUseCase('pricing', {
  definitions: { 'agents/pricing.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'estimates a price change with the script, the same in Japanese and English',
      run: async (tools) => {
        const ja = await estimate(tools, EXPORTS.ja, '単価', '5');
        const en = await estimate(tools, EXPORTS.en, 'price', '5');
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        const up = [
          'P-01 -1.29 -10005 -1.9',
          'P-02 -1.5 -9546 -3.1',
          'P-03 -2.73 -42228 -9.4',
          'P-04 -1.81 -8800 -4.5',
          'P-06 -0.26 15330 3.9',
        ];
        expect([estimatesOf(ja.output), estimatesOf(en.output)]).toEqual([up, up]);
        expect(ja.output.products[2]).toMatchObject({
          price: 1080,
          quantity: 415,
          newPrice: 1134,
          estQuantity: 358,
        });
        expect(ja.output.total).toEqual({
          revenue: 1_867_360,
          estRevenue: 1_812_111,
          revenueChange: -55_249,
        });
        expect([ja.output.noHistory, en.output.noHistory]).toEqual([
          [{ productCode: 'P-05', productName: 'マグカップ' }],
          [{ productCode: 'P-05', productName: 'Mug' }],
        ]);
        expect(ja.output.trend).toHaveLength(12);
        // A cut instead: the elastic products gain, the gift set loses.
        const cut = await estimate(tools, EXPORTS.ja, '数量', '-10');
        expect(estimatesOf(cut.output)).toContain('P-03 -2.73 65016 14.5');
        expect(estimatesOf(cut.output)).toContain('P-06 -0.26 -31920 -8.1');
        expect(cut.output.total.revenueChange).toBe(64_490);
      },
    },
    {
      name: 'reads a note in the export as data: the estimate is what the history gives',
      run: async (tools) => {
        for (const [lang, query] of [
          ['ja', '備考'],
          ['en', 'note'],
        ] as const) {
          const { output } = await estimate(tools, NOTED[lang], query, '5');
          expect(estimatesOf(output)).toContain('P-03 -2.73 -42228 -9.4');
          expect(output.total.revenueChange).toBe(-55_249);
        }
      },
    },
  ],
});

describe('pricing', () => {
  it('runs as a command line, and prints each past price change', async () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const { printed, code } = await runAsCommand([csv, '--change', '+2.5']);
    expect(code).toBe(0);
    const answer = JSON.parse(printed) as { change: number; products: { changes: unknown[] }[] };
    expect(answer.change).toBe(2.5);
    expect(answer.products[0]?.changes).toEqual([
      { month: '2026-04', fromPrice: 1280, toPrice: 1380, elasticity: -1.29 },
    ]);
  });

  it('averages several changes, reads no sales as no change, and never estimates below 0', () => {
    const rows = [
      '2026-01,A,a,100,10',
      '2026-02,A,a,120,8',
      '2026-03,A,a,100,12',
      '2026-01,Z,z,100,0',
      '2026-02,Z,z,200,0',
    ];
    const answer = JSON.parse(
      run([exportFile('calc.csv', `${HEADER}${rows.join('\n')}`), '--change', '-50']).text,
    ) as z.infer<typeof Answer>;
    // A: -1.22 when 100 → 120 (8 from 10), -2.2 when 120 → 100 (12 from 8): -1.71 on average.
    expect(answer.products[0]).toMatchObject({ elasticity: -1.71, newPrice: 50, estQuantity: 22 });
    // Z sold nothing either side: elasticity 0, and nothing to compare revenue with.
    expect(answer.products[1]).toMatchObject({
      elasticity: 0,
      estQuantity: 0,
      revenueChange: 0,
      revenueChangePct: null,
    });
    const steep = JSON.parse(
      run([
        exportFile('steep.csv', `${HEADER}2026-01,B,b,100,100\n2026-02,B,b,101,1`),
        '--change',
        '50',
      ]).text,
    ) as z.infer<typeof Answer>;
    expect(steep.products[0]).toMatchObject({ estQuantity: 0, revenueChangePct: -100 });
  });

  it('refuses what it cannot compute rather than guessing', () => {
    const row = '2026-01,A,a,100,10';
    for (const [line, error] of [
      ['2026-13,A,a,100,10', 'not_a_month'],
      ['2026/02,A,a,100,10', 'not_a_month'],
      [row, 'duplicate_row'],
      ['2026-02,A,a,0,10', 'out_of_range'],
      ['2026-02,A,a,100,-1', 'out_of_range'],
    ]) {
      expect(refusalOf(`${HEADER}${row}\n${String(line)}`)).toMatchObject({
        code: 1,
        error,
        row: 3,
      });
    }
    expect(refusalOf(HEADER).error).toBe('no_rows');
    expect(refusalOf(`${HEADER}2026-01,A,a,99.5,10`).error).toBe('not_a_whole_number');
    expect(refusalOf('month,price\n2026-01,100').error).toBe('missing_column');
    for (const args of [[], ['--change', '60'], ['--change', 'ten'], ['--change', '5.25']]) {
      expect(refusalOf(`${HEADER}${row}`, args)).toMatchObject({ code: 2, error: 'usage' });
    }
  });

  it('refuses an option it does not know, a missing file and a file it cannot read', () => {
    const csv = fileURLToPath(new URL(EXPORTS.ja, DATA));
    expect(run([])).toMatchObject({ code: 2, refusal: { error: 'usage' } });
    expect(run([csv, '--change', '5', '--product', 'P-01'])).toMatchObject({ code: 2 });
    expect(run([path.join(ROOT, 'missing.csv'), '--change', '5']).refusal).toMatchObject({
      error: 'unreadable_file',
    });
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'pricing', access: 'read' }]);
  });

  it('asks its typed eval runs for the chart rows the script prints', () => {
    const text = readFileSync(new URL('evals/pricing.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/pricing.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    const declared = surface.resultCharts?.map((chart) => chart.field);
    expect(declared).toEqual(['products', 'trend']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of ['change', 'total', 'noHistory', 'commentary', ...(declared ?? [])]) {
      expect(required).toContain(field);
    }
  });
});
