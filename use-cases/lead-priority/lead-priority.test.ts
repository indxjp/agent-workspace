/**
 * The contract, moment and flow tiers of `lead-priority` (archetype AN), and the skill script that
 * scores every lead it ranks.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>` in the run's
 * working directory, here in this process so coverage measures it) on the sample exports placed
 * where the demo puts them (`lead-priority/<file>`), and prove that the typed answer the surface
 * charts carries the script's order and points, the same in Japanese and English, that a note in
 * the export changes nothing, and that nothing in the answer is a person. One test evaluates the
 * script again as its command line (`node analyse.mjs <csv> --top 3`).
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
import agent from './agents/lead-priority.ts';
import { analyse as analyseRows, compute, SPEC } from './skills/lead-priority/scripts/analyse.mjs';
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
  const script = fileURLToPath(
    new URL('skills/lead-priority/scripts/analyse.mjs', import.meta.url),
  );
  process.argv.splice(1, process.argv.length, script, ...args);
  try {
    vi.resetModules();
    await import('./skills/lead-priority/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const EXPORTS = { ja: 'ja/リード一覧_2026年11月.csv', en: 'en/leads-2026-11.csv' } as const;
const NOTED = {
  ja: 'ja/展示会リード_2026年11月_追加分.csv',
  en: 'en/event-leads-2026-11-additional.csv',
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

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `lead-priority/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'lead-priority-'));
cpSync(DATA, path.join(ROOT, 'lead-priority'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['lead-priority'] }).call,
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

const HEADER = 'リードID,会社名,業種,流入元,従業員数,直近30日の訪問数,最終接触日\n';
const ROW = { leadId: 'L-1', company: 'A', industry: 'x', source: 'event', employees: 10 };

const Lead = z.strictObject({
  rank: z.number().int(),
  leadId: z.string(),
  company: z.string(),
  industry: z.string(),
  source: z.string(),
  daysSinceContact: z.number().int(),
  score: z.number().int(),
  points: z.strictObject({
    source: z.number().int(),
    size: z.number().int(),
    visits: z.number().int(),
    recency: z.number().int(),
  }),
  code: z.string(),
});
const Answer = z.strictObject({
  asOf: z.string(),
  source: z.string().nullable(),
  count: z.number().int(),
  leads: z.array(Lead),
  sources: z.array(
    z.strictObject({ source: z.string(), leads: z.number().int(), averageScore: z.number() }),
  ),
  commentary: z.string(),
});

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the export, run the script, and answer with its JSON and nothing else. */
async function rank(tools: Tools, file: string, query: string, args: readonly string[] = []) {
  const { aw, agentId } = tools.workspace(
    async ({ builtin }) => {
      const found = await builtin('search_files', { query });
      expect(found.text).toContain(`lead-priority/${file}`);
      const result = await builtin('run_skill_script', {
        skill: 'lead-priority',
        script: 'analyse.mjs',
        args: [`lead-priority/${file}`, ...args],
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

/** The leads as `leadId score`. */
const orderOf = (output: z.infer<typeof Answer>): string[] =>
  output.leads.map((lead) => `${lead.leadId} ${String(lead.score)}`);

describeUseCase('lead-priority', {
  definitions: { 'agents/lead-priority.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'ranks the leads with the script, the same in Japanese and English',
      run: async (tools) => {
        const ja = await rank(tools, EXPORTS.ja, 'リードID');
        const en = await rank(tools, EXPORTS.en, 'lead_id');
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        expect(orderOf(ja.output).slice(0, 4)).toEqual([
          'L-2601 94',
          'L-2610 90',
          'L-2606 73',
          'L-2605 60',
        ]);
        expect(ja.output).toMatchObject({ asOf: '2026-11-20', source: null, count: 12 });
        expect(ja.output.leads).toHaveLength(10);
        expect(ja.output.leads[0]?.points).toEqual({
          source: 40,
          size: 20,
          visits: 24,
          recency: 10,
        });
        // The two exports are one list: every number agrees, only the names differ.
        const numbers = (output: z.infer<typeof Answer>): unknown =>
          JSON.parse(
            JSON.stringify(output, (key, value: unknown) =>
              ['company', 'industry', 'source'].includes(key) && typeof value === 'string'
                ? ''
                : value,
            ),
          );
        expect(numbers(ja.output)).toEqual(numbers(en.output));
        expect(ja.output.sources).toEqual([
          { source: '問い合わせ', leads: 3, averageScore: 81.3 },
          { source: '展示会', leads: 4, averageScore: 53.5 },
          { source: '資料請求', leads: 3, averageScore: 41 },
          { source: 'ウェビナー', leads: 2, averageScore: 46.5 },
        ]);
      },
    },
    {
      name: 'ranks one source when asked, by either name, and reads a note as data',
      run: async (tools) => {
        const events = await rank(tools, EXPORTS.ja, '流入元', ['--source', '展示会']);
        expect(orderOf(events.output)).toEqual([
          'L-2606 73',
          'L-2608 57',
          'L-2602 49',
          'L-2612 35',
        ]);
        const english = await rank(tools, EXPORTS.en, 'source', ['--source', 'event']);
        expect(orderOf(english.output)).toEqual(orderOf(events.output));
        for (const [lang, query] of [
          ['ja', '備考'],
          ['en', 'note'],
        ] as const) {
          const { output } = await rank(tools, NOTED[lang], query);
          expect(orderOf(output)).toEqual(['L-2703 76', 'L-2701 51', 'L-2702 38']);
        }
      },
    },
  ],
});

describe('lead-priority', () => {
  it('runs as a command line, listing as many leads as it is asked for', async () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const { printed, code } = await runAsCommand([csv, '--top', '3']);
    expect(code).toBe(0);
    const answer = Answer.parse({ ...(JSON.parse(printed) as object), commentary: '' });
    expect(orderOf(answer)).toEqual(['L-2601 94', 'L-2610 90', 'L-2606 73']);
  });

  it('scores an .xlsx of the same leads to the same order', () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const [header = [], ...records] = readFileSync(csv, 'utf8')
      .trim()
      .split('\n')
      .map((line) =>
        line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/u).map((cell) => cell.replaceAll('"', '')),
      );
    const rows = records.map((cells) =>
      cells.map((cell, at) => (at === 4 || at === 5 ? Number(cell) : cell)),
    );
    const xlsx = path.join(ROOT, 'leads.xlsx');
    writeFileSync(xlsx, writeXlsx({ sheets: [{ name: 'Leads', rows: [header, ...rows] }] }));
    const fromXlsx = run([xlsx]);
    expect(fromXlsx.code).toBe(0);
    expect(fromXlsx.text).toBe(run([csv]).text);
  });

  it('scores by the fixed rules at each boundary, ties in lead id order', () => {
    const one = (row: Partial<typeof ROW> & { visits?: number; lastContact?: string }) => ({
      ...ROW,
      visits: 0,
      lastContact: '2026-11-20',
      ...row,
    });
    const { leads } = analyseRows(
      {
        rows: [
          one({ leadId: 'L-3', employees: 300, visits: 11, lastContact: '2026-11-13' }),
          one({ leadId: 'L-2', employees: 49, lastContact: '2026-10-21' }),
          one({ leadId: 'L-1', employees: 50, lastContact: '2026-10-20' }),
        ],
        rowNumbers: [2, 3, 4],
      },
      { 'as-of': '2026-11-20' },
    );
    expect(leads.map((lead) => [lead.leadId, lead.points])).toEqual([
      ['L-3', { source: 25, size: 20, visits: 30, recency: 10 }],
      ['L-1', { source: 25, size: 10, visits: 0, recency: 0 }],
      ['L-2', { source: 25, size: 0, visits: 0, recency: 5 }],
    ]);
    const tied = analyseRows(
      { rows: [one({ leadId: 'L-9' }), one({ leadId: 'L-8' })], rowNumbers: [2, 3] },
      {},
    );
    expect(tied.leads.map((lead) => lead.leadId)).toEqual(['L-8', 'L-9']);
  });

  it('refuses what it cannot score rather than guessing', () => {
    const row = 'L-1,A,x,展示会,10,1,2026-11-20';
    expect(refusalOf(`${HEADER}L-1,A,x,紹介,10,1,2026-11-20`)).toMatchObject({
      code: 1,
      error: 'unknown_source',
      row: 2,
    });
    expect(refusalOf(`${HEADER}${row}\n${row}`)).toMatchObject({ error: 'duplicate_lead', row: 3 });
    expect(refusalOf(`${HEADER}${row}`, ['--as-of', '2026-11-19'])).toMatchObject({
      error: 'after_as_of',
      row: 2,
    });
    expect(refusalOf(`${HEADER}L-1,A,x,展示会,10,1.5,2026-11-20`).error).toBe('not_a_whole_number');
    expect(refusalOf(`${HEADER}L-1,A,x,展示会,10,1,11月20日`).error).toBe('not_a_date');
    expect(refusalOf(`${HEADER}L-1,A,x,展示会,10,,2026-11-20`).error).toBe('empty_cell');
    expect(refusalOf('リードID,会社名\nL-1,A').error).toBe('missing_column');
    expect(refusalOf(HEADER).error).toBe('no_rows');
    for (const args of [
      ['--top', '0'],
      ['--top', 'all'],
      ['--source', '紹介'],
      ['--as-of', '2026/11/20'],
      ['--as-of', '2026-13-01'],
      ['--as-of', '2026-02-30'],
      ['--months', '3'],
    ]) {
      expect(refusalOf(`${HEADER}${row}`, args)).toMatchObject({ code: 2, error: 'usage' });
    }
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'lead-priority', access: 'read' }]);
  });

  it('asks its typed eval runs for the chart rows, and no field that could hold a person', () => {
    const text = readFileSync(new URL('evals/lead-priority.yaml', import.meta.url), 'utf8');
    const { cases } = readEvalCaseFile(text, 'evals/lead-priority.yaml');
    const schemas = cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    const declared = surface.resultCharts?.map((chart) => chart.field);
    expect(declared).toEqual(['leads', 'sources']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of ['asOf', 'count', 'commentary', ...(declared ?? [])]) {
      expect(required).toContain(field);
    }
    // The plan's rule for an entry that could be asked about people: no such field, and an eval
    // case asks to score a person and expects a refusal.
    expect(JSON.stringify(schemas[0])).not.toMatch(
      /"(?:person|owner|salesperson|rep|staff|contact)"/iu,
    );
    const asks = cases.filter((evalCase) => evalCase.tags?.includes('safety'));
    expect(asks.map((evalCase) => evalCase.input).join('\n')).toMatch(/営業担当者|contact person/u);
  });
});
