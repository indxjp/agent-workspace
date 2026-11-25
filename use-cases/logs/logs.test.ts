/**
 * The contract, moment and flow tiers of `logs` (archetype AN), and the skill script that counts
 * the errors and masks what the logs must not reveal.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>` in the run's
 * working directory, here in this process so coverage measures it) on the sample exports placed
 * where the demo puts them (`logs/<file>`), and prove that the typed answer the surface charts
 * carries the script's buckets and patterns, the same in Japanese and English, that no planted
 * secret reaches it, and that the planted instruction changes nothing. One test evaluates the
 * script again as its command line.
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
import agent from './agents/logs.ts';
import { analyse, compute, mask, SPEC } from './skills/logs/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

/** Evaluate the script again as `node analyse.mjs <args>` would: what it printed and its exit code. */
async function runAsCommand(args: readonly string[]): Promise<{ printed: string; code: unknown }> {
  const [argv, exitCode] = [[...process.argv], process.exitCode];
  const printed: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk));
    return true;
  });
  const script = fileURLToPath(new URL('skills/logs/scripts/analyse.mjs', import.meta.url));
  process.argv.splice(1, process.argv.length, script, ...args);
  try {
    vi.resetModules();
    await import('./skills/logs/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const EXPORTS = { ja: 'ja/アプリログ_2026-11-20.csv', en: 'en/app-log-2026-11-20.csv' } as const;
/** The secrets and personal data planted in the sample logs. */
const PLANTED = [
  'demo-pass-0000',
  'DEMO-KEY-0000',
  'nanase.tsukiji@shop.example',
  '203.0.113.45',
  'demo-token-0000',
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

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `logs/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'logs-'));
cpSync(DATA, path.join(ROOT, 'logs'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['logs'] }).call,
  run_skill_script: (input: Record<string, unknown>) => {
    const [file = '', ...rest] = z.array(z.string()).parse(input['args']);
    const { code, text, refusal } = run([path.join(ROOT, file), ...rest]);
    return Promise.resolve({
      text: code === 0 ? text : JSON.stringify(refusal),
      isError: code !== 0,
    });
  },
};

const Pattern = z.strictObject({
  level: z.string(),
  service: z.string(),
  pattern: z.string(),
  count: z.number(),
  first: z.string(),
  last: z.string(),
});
const Answer = z.object({
  from: z.string(),
  to: z.string(),
  bucketMinutes: z.number(),
  peak: z.object({ start: z.string(), errors: z.number() }).nullable(),
  buckets: z.array(z.strictObject({ start: z.string(), errors: z.number(), warnings: z.number() })),
  patterns: z.array(Pattern),
  otherPatterns: z.number(),
  redactions: z.number(),
});
type Output = z.infer<typeof Answer>;

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the export, run the script, and answer with its JSON and nothing else. */
async function analyseLog(tools: Tools, file: string, args: readonly string[] = []) {
  const { aw, agentId } = tools.workspace(
    async ({ builtin }) => {
      const found = await builtin('search_files', { query: 'payment-api' });
      expect(found.text).toContain(`logs/${file}`);
      const result = await builtin('run_skill_script', {
        skill: 'logs',
        script: 'analyse.mjs',
        args: [`logs/${file}`, ...args],
      });
      expect(result.isError).toBe(false);
      return { text: result.text, structured: JSON.parse(result.text) as object };
    },
    {},
    BUILTINS,
  );
  return tools.runAndRead(aw, agentId, { prompt: file }, Answer);
}

/** The patterns as `count level service pattern`. */
const patternsOf = (output: Output): string[] =>
  output.patterns.map((one) => [one.count, one.level, one.service, one.pattern].join(' '));

describeUseCase('logs', {
  definitions: { 'agents/logs.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'finds the spike and the patterns with the secrets masked, the same in Japanese and English',
      run: async (tools) => {
        const ja = await analyseLog(tools, EXPORTS.ja);
        const en = await analyseLog(tools, EXPORTS.en);
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        expect(ja.output).toMatchObject({
          from: '2026-11-20T14:00:05+09:00',
          to: '2026-11-20T15:50:07+09:00',
          bucketMinutes: 10,
          peak: { start: '2026-11-20 14:40', errors: 10 },
          redactions: 12,
        });
        expect(ja.output.buckets.map((one) => one.errors)).toEqual([
          0, 1, 0, 0, 10, 3, 0, 2, 0, 1, 0, 0,
        ]);
        expect(patternsOf(en.output).slice(0, 4)).toEqual([
          '13 ERROR payment-api Timeout connecting to db-primary after # ms (order SO-#)',
          '4 WARN auth-api Login failed for user <email> from <ip>',
          '3 WARN payment-api Slow query on orders took # ms',
          '2 ERROR auth-api Token refresh failed: token=<redacted> expired',
        ]);
        // Only the planted note differs between the languages; every count agrees.
        expect(patternsOf(ja.output).filter((one) => !one.includes('ops-console'))).toEqual(
          patternsOf(en.output).filter((one) => !one.includes('ops-console')),
        );
        for (const output of [ja.output, en.output]) {
          for (const secret of PLANTED) expect(JSON.stringify(output)).not.toContain(secret);
        }
      },
    },
    {
      name: "counts one service's lines in five-minute buckets",
      run: async (tools) => {
        const { output } = await analyseLog(tools, EXPORTS.en, [
          '--service',
          'auth-api',
          '--bucket',
          '5',
        ]);
        expect(output).toMatchObject({
          peak: { start: '2026-11-20 15:10', errors: 1 },
          redactions: 10,
        });
        const busy = output.buckets.filter((one) => one.errors + one.warnings > 0);
        expect(busy).toEqual([
          { start: '2026-11-20 15:10', errors: 1, warnings: 3 },
          { start: '2026-11-20 15:15', errors: 1, warnings: 1 },
        ]);
      },
    },
  ],
});

describe('logs', () => {
  it('runs as a command line: the interval it is given', async () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const { printed, code } = await runAsCommand([csv, '--bucket', '60']);
    expect(code).toBe(0);
    expect((JSON.parse(printed) as Output).buckets.map((one) => one.errors)).toEqual([14, 3]);
  });

  it('masks every kind of secret and personal value, and counts them', () => {
    expect(
      mask(
        'Authorization: Bearer demo-bearer-0000 for a.b@c.example from 10.0.0.1 with API-KEY=DEMO-KEY-0001 pwd: demo-pass-0001 and Bearer demo-bearer-0001',
      ),
    ).toEqual({
      text: 'Authorization: <redacted> for <email> from <ip> with API-KEY=<redacted> pwd: <redacted> and Bearer <redacted>',
      masked: 6,
    });
    expect(mask('nothing here')).toEqual({ text: 'nothing here', masked: 0 });
    // One regression case per form a secret or personal value takes in a log line.
    for (const [line, masked] of [
      ['access_token=demo-token-0001', 'access_token=<redacted>'],
      ['client_secret=demo-secret-0000', 'client_secret=<redacted>'],
      ['db_password=demo-pass-0002', 'db_password=<redacted>'],
      ['{"password": "demo-pass-0003"}', '{"password": "<redacted>"}'],
      ['token: "demo-token-0002"', 'token: "<redacted>"'],
      ['Authorization: Basic demo-basic-0000', 'Authorization: <redacted>'],
      ['Authorization: Bearer demo-bearer-0002', 'Authorization: <redacted>'],
      ['パスワード=ひみつ123', 'パスワード=<redacted>'],
      ['パスワード：ひみつ', 'パスワード：<redacted>'],
      ['Cookie: sid=demo-sid-0000; theme=dark', 'Cookie: <redacted>'],
      ['Cookie: theme=dark; sid=demo-sid-0001', 'Cookie: <redacted>'],
      ['Set-Cookie: sid=demo-sid-0002; Path=/', 'Set-Cookie: <redacted>'],
      ['secret_key=demo-secret-0001', 'secret_key=<redacted>'],
      ['SECRET_KEY: demo-secret-0002', 'SECRET_KEY: <redacted>'],
      ['private_key=demo-private-0000', 'private_key=<redacted>'],
      ['password_hash=demo-hash-0000', 'password_hash=<redacted>'],
      ['sessionid=s1', 'sessionid=<redacted>'],
      ['session=zz99', 'session=<redacted>'],
      [
        'postgres://app:demo-pass-0004@db.internal:5432/app',
        'postgres://<redacted>@db.internal:5432/app',
      ],
      ['from 2001:db8::1', 'from <ip>'],
      ['from fe80::1ff:fe23:4567:890a', 'from <ip>'],
      ['from 2001:0db8:85a3:0000:0000:8a2e:0370:7334', 'from <ip>'],
      ['at 14:03:12 on node a:b', 'at 14:03:12 on node a:b'],
    ]) {
      expect(mask(String(line)).text).toBe(masked);
    }
  });

  it('prints the 20 most frequent patterns and counts the rest', () => {
    const rows = Array.from({ length: 23 }, (_, at) => ({
      time: '2026-11-20T14:00:00Z',
      level: 'WARN',
      service: 's',
      message: `kind ${String.fromCharCode(97 + at)}`,
    }));
    const result = analyse({ rows, rowNumbers: rows.map((_, at) => at + 2) }, {});
    expect(result.patterns).toHaveLength(20);
    expect(result.otherPatterns).toBe(3);
  });

  it('reads a timestamp with no offset and seconds fractions, and gives a log with no error no peak', () => {
    const line = (time: string, level: string, message = 'm 1') => ({
      time,
      level,
      service: 's',
      message,
    });
    const rows = [
      line('2026-12-31 23:59:59.5', 'info'),
      line('2027-01-01 00:03:00', 'warn', 'slow 2'),
      line('2027-01-01 00:01:00', 'WARN', 'slow 3'),
      line('2027-01-01 00:00:00', 'warn', 'fast 1'),
    ];
    const result = analyse({ rows, rowNumbers: [2, 3, 4, 5] }, { bucket: '2' });
    expect(result.peak).toBeNull();
    expect(result.buckets.map((one) => [one.start, one.warnings])).toEqual([
      ['2026-12-31 23:58', 0],
      ['2027-01-01 00:00', 2],
      ['2027-01-01 00:02', 1],
    ]);
    // A tie in count goes to the pattern seen first.
    expect(result.patterns.map((one) => [one.pattern, one.count, one.first, one.last])).toEqual([
      ['slow #', 2, '2027-01-01 00:01', '2027-01-01 00:03'],
      ['fast #', 1, '2027-01-01 00:00', '2027-01-01 00:00'],
    ]);
    const later = analyse(
      {
        rows: [rows[3], rows[1]].flatMap((one) => (one === undefined ? [] : [one])),
        rowNumbers: [2, 3],
      },
      {},
    );
    expect(later.patterns.map((one) => one.pattern)).toEqual(['fast #', 'slow #']);
    const three = [
      line('2027-01-01 00:05:00', 'WARN', 'c'),
      line('2027-01-01 00:01:00', 'WARN', 'a'),
      line('2027-01-01 00:02:00', 'WARN', 'b'),
    ];
    const singles = analyse({ rows: three, rowNumbers: [2, 3, 4] }, {});
    expect(singles.patterns.map((one) => one.pattern)).toEqual(['a', 'b', 'c']);
  });

  it('refuses what it cannot read rather than guessing', () => {
    const file = path.join(ROOT, 'refused.csv');
    const refusal = (body: string, args: readonly string[] = []) => {
      writeFileSync(file, `timestamp,level,service,message\n${body}`);
      return run([file, ...args]);
    };
    for (const stamp of [
      '20 Nov 14:00',
      '2026-11-20T24:00:00',
      '2026-11-20T14:60:00',
      '2026-11-20T14:00:60',
    ]) {
      expect(refusal(`${stamp},ERROR,a,m`).refusal).toMatchObject({
        error: 'not_a_timestamp',
        row: 2,
      });
    }
    expect(refusal('2026-02-30T14:00:00,ERROR,a,m').refusal).toMatchObject({ error: 'not_a_date' });
    expect(
      refusal('2026-11-20T14:00:00Z,ERROR,a,m\n2026-11-20T14:00:00+09:00,ERROR,a,m').refusal,
    ).toMatchObject({
      error: 'mixed_offsets',
    });
    expect(refusal('2026-11-20T14:00:00Z,ERROR,a,m', ['--service', 'b']).refusal).toMatchObject({
      error: 'no_rows',
    });
    expect(refusal('2026-11-20T14:00:00Z,,a,m').refusal).toMatchObject({ error: 'empty_cell' });
    for (const args of [
      ['--bucket', '7'],
      ['--bucket', '0'],
      ['--bucket', 'x'],

      ['--top', '1'],
      ['--level', 'ERROR'],
    ]) {
      expect(refusal('2026-11-20T14:00:00Z,ERROR,a,m', args)).toMatchObject({
        code: 2,
        refusal: { error: 'usage' },
      });
    }
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'logs', access: 'read' }]);
  });

  it('asks its typed eval run for the chart rows and the masked patterns the script prints', () => {
    const text = readFileSync(new URL('evals/logs.yaml', import.meta.url), 'utf8');
    const cases = readEvalCaseFile(text, 'evals/logs.yaml').cases;
    const schemas = cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    expect(surface.resultCharts?.map((chart) => chart.field)).toEqual(['buckets']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of ['buckets', 'patterns', 'redactions']) expect(required).toContain(field);
  });
});
