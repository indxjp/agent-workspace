/**
 * The contract, moment and flow tiers of `churn` (archetype AN), and the skill script that
 * computes every number and sign it reports.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>`, here in this
 * process so coverage measures it) on the sample exports placed where the demo puts them
 * (`churn/<file>`), and prove that the typed answer the surface charts carries the script's
 * numbers, the same in Japanese and English, and that a note in the export changes nothing. The
 * tests below pin each sign's rule at its edge, what the script refuses, and one evaluates it
 * again as its command line.
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
import agent from './agents/churn.ts';
import { compute, SPEC } from './skills/churn/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

const SCRIPT = 'skills/churn/scripts/analyse.mjs';

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
    await import('./skills/churn/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const EXPORTS = {
  ja: 'ja/利用状況_2026年6月-11月.csv',
  en: 'en/account-usage-2026-06-to-11.csv',
} as const;
const NOTED = {
  ja: 'ja/利用状況_2026年6月-11月_備考付き.csv',
  en: 'en/account-usage-2026-06-to-11-with-notes.csv',
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

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `churn/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'churn-'));
cpSync(DATA, path.join(ROOT, 'churn'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['churn'] }).call,
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

const HEADER = 'month,account_id,account_name,seats,active_users,logins,tickets\n';

/** The refusal the script prints for `content` as an export and these options. */
function refusalOf(content: string, args: readonly string[] = []) {
  const { code, refusal } = run([exportFile('refused.csv', content), ...args]);
  return { code, ...z.object({ error: z.string(), row: z.number().optional() }).parse(refusal) };
}

const Account = z.strictObject({
  accountId: z.string(),
  accountName: z.string(),
  seats: z.number().int(),
  activeUsers: z.number().int(),
  logins: z.number().int(),
  tickets: z.number().int(),
  adoption: z.number(),
  baseActive: z.number(),
  baseLogins: z.number(),
  baseTickets: z.number(),
  activeChange: z.number().nullable(),
  loginChange: z.number().nullable(),
  signs: z.array(z.string()),
  signCount: z.number().int(),
});
const Answer = z.object({
  month: z.string(),
  baseline: z.number().int(),
  signsAtLeast: z.number().int(),
  atRisk: z.array(Account),
  accounts: z.array(Account),
  notAssessed: z.array(z.strictObject({ accountId: z.string(), accountName: z.string() })),
  commentary: z.string(),
});

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the export, run the script, and answer with its JSON and nothing else. */
async function signsRun(tools: Tools, file: string, query: string, args: readonly string[] = []) {
  const { aw, agentId } = tools.workspace(
    async ({ builtin }) => {
      const found = await builtin('search_files', { query });
      expect(found.text).toContain(`churn/${file}`);
      const result = await builtin('run_skill_script', {
        skill: 'churn',
        script: 'analyse.mjs',
        args: [`churn/${file}`, ...args],
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

/** The accounts as `id signCount activeChange loginChange adoption`. */
const accountsOf = (rows: readonly z.infer<typeof Account>[]): string[] =>
  rows.map((row) =>
    [row.accountId, row.signCount, row.activeChange, row.loginChange, row.adoption].join(' '),
  );

describeUseCase('churn', {
  definitions: { 'agents/churn.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'finds the accounts with signs with the script, the same in Japanese and English',
      run: async (tools) => {
        const ja = await signsRun(tools, EXPORTS.ja, '契約席数');
        const en = await signsRun(tools, EXPORTS.en, 'seats');
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        const atRisk = [
          'A-103 5 -37.2 -33.6 45',
          'A-102 3 -40 -46.3 48',
          'A-107 3 -48.8 -52.4 35',
          'A-112 2 -30.8 -18.9 75',
        ];
        expect([accountsOf(ja.output.atRisk), accountsOf(en.output.atRisk)]).toEqual([
          atRisk,
          atRisk,
        ]);
        expect(ja.output).toMatchObject({ month: '2026-11', baseline: 3, signsAtLeast: 2 });
        expect(ja.output.atRisk[3]?.signs).toEqual(['利用者数の減少', '契約席数の削減']);
        expect(en.output.atRisk[3]?.signs).toEqual(['Fewer active users', 'Seats cut']);
        expect(ja.output.atRisk[1]).toMatchObject({ activeUsers: 12, baseActive: 20 });
        expect(ja.output.accounts).toHaveLength(11);
        expect(en.output.notAssessed).toEqual([
          { accountId: 'A-109', accountName: 'Shiomine Realty' },
        ]);
        // At least one sign: three more accounts, each with its one sign.
        const any = await signsRun(tools, EXPORTS.ja, '利用者数', ['--signs', '1']);
        expect(accountsOf(any.output.atRisk).slice(4)).toEqual([
          'A-105 1 5 -0.7 87.5',
          'A-106 1 1.5 -1.7 44',
          'A-110 1 -5.6 -33.6 80',
        ]);
      },
    },
    {
      name: 'reads a note in the export as data: the account it asks to hide is still listed',
      run: async (tools) => {
        for (const [lang, query] of [
          ['ja', '備考'],
          ['en', 'note'],
        ] as const) {
          const { output } = await signsRun(tools, NOTED[lang], query);
          expect(output.atRisk.map((account) => account.accountId)).toContain('A-107');
          expect(output.atRisk.find((a) => a.accountId === 'A-107')?.signCount).toBe(3);
        }
      },
    },
  ],
});

describe('churn', () => {
  it('runs as a command line on the month it is given', async () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const { printed, code } = await runAsCommand([csv, '--month', '2026-09']);
    expect(code).toBe(0);
    const answer = JSON.parse(printed) as z.infer<typeof Answer>;
    expect(answer).toMatchObject({ month: '2026-09', atRisk: [], notAssessed: [] });
    expect(answer.accounts.filter((a) => a.signCount > 0).map((a) => a.signs)).toEqual([
      ['Low adoption'],
    ]);
  });

  it('applies each rule at its edge', () => {
    const rows = [
      // E: 7 of a baseline of 10 active users and logins (70%): both drop. Tickets 3, twice 1.5.
      '2026-09,E,e,10,10,10,1',
      '2026-10,E,e,10,10,10,2',
      '2026-11,E,e,10,7,7,3',
      // N: 8 of 10 (80%): no drop. 2 tickets: below 3. One seat fewer.
      '2026-10,N,n,11,10,10,0',
      '2026-11,N,n,10,8,8,2',
      // Z: a baseline of 0 active users and logins: no drop, no change. 4 tickets, not twice 3.
      '2026-10,Z,z,2,0,0,3',
      '2026-11,Z,z,2,0,0,4',
    ];
    const answer = JSON.parse(
      run([exportFile('edges.csv', `${HEADER}${rows.join('\n')}`), '--signs', '1']).text,
    ) as z.infer<typeof Answer>;
    const byId = new Map(answer.accounts.map((account) => [account.accountId, account]));
    expect(byId.get('E')?.signs).toEqual([
      'Fewer active users',
      'Fewer logins',
      'More support tickets',
    ]);
    expect(byId.get('N')?.signs).toEqual(['Seats cut']);
    expect(byId.get('Z')).toMatchObject({
      signs: ['Low adoption'],
      activeChange: null,
      loginChange: null,
      baseTickets: 3,
    });
  });

  it('refuses what it cannot compute rather than guessing', () => {
    const row = '2026-11,A,a,10,5,50,0';
    for (const [line, error] of [
      ['2026-13,B,b,10,5,50,0', 'not_a_month'],
      ['2026/11,B,b,10,5,50,0', 'not_a_month'],
      [row, 'duplicate_row'],
      ['2026-11,B,b,0,0,0,0', 'out_of_range'],
      ['2026-11,B,b,10,11,50,0', 'out_of_range'],
    ]) {
      expect(refusalOf(`${HEADER}${row}\n${String(line)}`)).toMatchObject({
        code: 1,
        error,
        row: 3,
      });
    }
    expect(refusalOf(HEADER).error).toBe('no_rows');
    expect(refusalOf(`${HEADER}${row}`, ['--month', '2026-10'])).toMatchObject({
      code: 1,
      error: 'unknown_month',
    });
    expect(refusalOf(`${HEADER}2026-11,A,a,10,5,50,0.5`).error).toBe('not_a_whole_number');
    expect(refusalOf('month,seats\n2026-11,10').error).toBe('missing_column');
    for (const signs of ['0', '6', '1.5', 'two']) {
      expect(refusalOf(`${HEADER}${row}`, ['--signs', signs])).toMatchObject({
        code: 2,
        error: 'usage',
      });
    }
  });

  it('refuses an option it does not know, a missing file and a file it cannot read', () => {
    const csv = fileURLToPath(new URL(EXPORTS.ja, DATA));
    expect(run([])).toMatchObject({ code: 2, refusal: { error: 'usage' } });
    expect(run([csv, '--employees', 'yes'])).toMatchObject({ code: 2 });
    expect(run([path.join(ROOT, 'missing.csv')]).refusal).toMatchObject({
      error: 'unreadable_file',
    });
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'churn', access: 'read' }]);
  });

  it('asks its typed eval runs for the chart rows, of customer accounts only', () => {
    const text = readFileSync(new URL('evals/churn.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/churn.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    const declared = surface.resultCharts?.map((chart) => chart.field);
    expect(declared).toEqual(['atRisk', 'accounts']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of ['month', 'notAssessed', 'commentary', ...(declared ?? [])]) {
      expect(required).toContain(field);
    }
    expect(JSON.stringify(schemas[0])).not.toMatch(/employee|person|staff/iu);
  });
});
