/**
 * The contract, moment and flow tiers of `survey` (archetype AN), and the skill script that
 * computes every number it reports.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>`, here in this
 * process so coverage measures it) on the sample exports placed where the demo puts them
 * (`survey/<file>`), and prove that the typed answer the surface charts carries the script's
 * numbers, the same in Japanese and English, that a channel below the minimum group size has no
 * figure, and that an instruction in a comment changes nothing. The tests below pin that the
 * script prints no response ID, what it refuses, and one evaluates it again as its command line.
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
import agent from './agents/survey.ts';
import { compute, MIN_GROUP, SPEC } from './skills/survey/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

const SCRIPT = 'skills/survey/scripts/analyse.mjs';

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
    await import('./skills/survey/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const EXPORTS = {
  ja: 'ja/アンケート回答_2026年10月-11月.csv',
  en: 'en/survey-responses-2026-10-to-11.csv',
} as const;
const LATE = {
  ja: 'ja/アンケート回答_2026年11月_追加分.csv',
  en: 'en/survey-responses-2026-11-late.csv',
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

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `survey/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'survey-'));
cpSync(DATA, path.join(ROOT, 'survey'), { recursive: true });
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['survey'] }).call,
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

const HEADER = '回答ID,回答日,窓口,総合満足度,対応の速さ,説明のわかりやすさ,推奨度,自由記述\n';
/** `count` responses on the phone in November 2026, each scored `scores`. */
const responses = (count: number, scores = '4,4,4,8,') =>
  Array.from({ length: count }, (_, at) => `S-${String(at)},2026-11-02,電話,${scores}`).join('\n');

/** The refusal the script prints for `content` as an export and these options. */
function refusalOf(content: string, args: readonly string[] = []) {
  const { code, refusal } = run([exportFile('refused.csv', content), ...args]);
  return { code, ...z.object({ error: z.string(), row: z.number().optional() }).parse(refusal) };
}

const Answer = z.object({
  month: z.string(),
  responses: z.number().int(),
  minGroup: z.number().int(),
  questions: z.array(
    z.strictObject({ question: z.string(), mean: z.number(), favourable: z.number() }),
  ),
  nps: z.strictObject({
    promoters: z.number().int(),
    passives: z.number().int(),
    detractors: z.number().int(),
    score: z.number(),
  }),
  channels: z.array(
    z.strictObject({
      channel: z.string(),
      responses: z.number().int(),
      overall: z.number(),
      nps: z.number(),
    }),
  ),
  heldBack: z.array(z.string()),
  commentary: z.string(),
});

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the export, run the script, and answer with its JSON and nothing else. */
async function tallyRun(tools: Tools, file: string, query: string, args: readonly string[] = []) {
  const { aw, agentId } = tools.workspace(
    async ({ builtin }) => {
      const found = await builtin('search_files', { query });
      expect(found.text).toContain(`survey/${file}`);
      const result = await builtin('run_skill_script', {
        skill: 'survey',
        script: 'analyse.mjs',
        args: [`survey/${file}`, ...args],
      });
      expect(result.isError).toBe(false);
      const computed = JSON.parse(result.text) as Record<string, unknown>;
      return {
        text: result.text,
        structured: { ...computed, comments: undefined, commentary: '' },
      };
    },
    {},
    BUILTINS,
  );
  return tools.runAndRead(aw, agentId, { prompt: file }, Answer);
}

/** The channels as `channel responses overall nps`. */
const channelsOf = (output: z.infer<typeof Answer>): string[] =>
  output.channels.map((row) => [row.channel, row.responses, row.overall, row.nps].join(' '));

describeUseCase('survey', {
  definitions: { 'agents/survey.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'tallies a month with the script, the same in Japanese and English, in groups only',
      run: async (tools) => {
        const ja = await tallyRun(tools, EXPORTS.ja, '総合満足度');
        const en = await tallyRun(tools, EXPORTS.en, 'recommend');
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        expect(ja.output).toMatchObject({ month: '2026-11', responses: 17, minGroup: 5 });
        expect(ja.output.questions).toEqual([
          { question: '総合満足度', mean: 3.53, favourable: 58.8 },
          { question: '対応の速さ', mean: 3, favourable: 41.2 },
          { question: '説明のわかりやすさ', mean: 3.82, favourable: 64.7 },
        ]);
        expect(ja.output.nps).toEqual({ promoters: 6, passives: 6, detractors: 5, score: 5.9 });
        expect(channelsOf(ja.output)).toEqual([
          '電話 6 4.17 66.7',
          'チャット 6 2.5 -83.3',
          'メール 5 4 40',
        ]);
        expect(channelsOf(en.output)).toEqual([
          'Phone 6 4.17 66.7',
          'Chat 6 2.5 -83.3',
          'Email 5 4 40',
        ]);
        expect([ja.output.heldBack, en.output.heldBack]).toEqual([['来店'], ['In store']]);
        // Another month, another tally: email is the low channel in October.
        const october = await tallyRun(tools, EXPORTS.ja, '推奨度', ['--month', '2026-10']);
        expect(channelsOf(october.output)).toEqual([
          '電話 5 4 60',
          'メール 6 3.33 -50',
          'チャット 5 4.4 60',
        ]);
      },
    },
    {
      name: 'reads an instruction in a comment as data: the tally is what the answers give',
      run: async (tools) => {
        for (const [lang, query] of [
          ['ja', '自由記述'],
          ['en', 'comment'],
        ] as const) {
          const { output } = await tallyRun(tools, LATE[lang], query);
          expect(output.questions[0]).toMatchObject({ mean: 2.8, favourable: 20 });
          expect(output.nps.score).toBe(-80);
          expect(output).toMatchObject({
            responses: 5,
            heldBack: [lang === 'ja' ? '電話' : 'Phone'],
          });
        }
      },
    },
  ],
});

describe('survey', () => {
  it('runs as a command line on the last month, and prints no response ID or date', async () => {
    const csv = fileURLToPath(new URL(EXPORTS.en, DATA));
    const { printed, code } = await runAsCommand([csv]);
    expect(code).toBe(0);
    const answer = JSON.parse(printed) as { month: string; comments: string[] };
    expect(answer.month).toBe('2026-11');
    expect(answer.comments).toHaveLength(9);
    expect(answer.comments).toContain('I waited a long time for a reply in the chat.');
    // The in-store channel is held back, and its comments with it.
    expect(answer.comments).not.toContain('At the store they showed me on the device itself.');
    expect(printed).not.toMatch(/S-\d|2026-11-\d/u);
  });

  it('holds back a channel below the minimum group size and refuses a month below it', () => {
    const fourOnline = Array.from({ length: MIN_GROUP - 1 }, () => '2026-11-03,チャット,1,1,1,0,');
    const csv = `${HEADER}${responses(MIN_GROUP)}\n${fourOnline.map((row) => `x,${row}`).join('\n')}`;
    const result = z
      .object({ channels: z.array(z.unknown()), heldBack: z.array(z.string()), nps: z.unknown() })
      .parse(JSON.parse(run([exportFile('groups.csv', csv), '--month', '2026-11']).text));
    expect(result.channels).toEqual([{ channel: '電話', responses: 5, overall: 4, nps: 0 }]);
    expect(result.heldBack).toEqual(['チャット']);
    expect(result.nps).toEqual({ promoters: 0, passives: 5, detractors: 0, score: 0 });
    expect(refusalOf(`${HEADER}${responses(MIN_GROUP - 1)}`)).toMatchObject({
      code: 1,
      error: 'too_few_responses',
    });
    // A month the export does not hold is named as such, not as a month with too few responses.
    expect(refusalOf(`${HEADER}${responses(MIN_GROUP)}`, ['--month', '2026-10']).error).toBe(
      'unknown_month',
    );
  });

  it('refuses what it cannot compute rather than guessing', () => {
    expect(
      JSON.parse(run([exportFile('ok.csv', `${HEADER}${responses(5, '5,5,5,10,good')}`)]).text),
    ).toMatchObject({ nps: { score: 100 }, comments: ['good', 'good', 'good', 'good', 'good'] });
    for (const scores of ['0,4,4,8,', '4,6,4,8,', '4,4,4,11,', '4,4,4,-1,']) {
      expect(refusalOf(`${HEADER}${responses(5, scores)}`)).toMatchObject({
        code: 1,
        error: 'out_of_range',
        row: 2,
      });
    }
    expect(refusalOf(HEADER).error).toBe('no_rows');
    expect(refusalOf(`${HEADER}${responses(5, '4,4,4,8.5,')}`).error).toBe('not_a_whole_number');
    expect(refusalOf(`${HEADER}x,11月2日,電話,4,4,4,8,`).error).toBe('not_a_date');
    expect(refusalOf('回答ID,窓口\nx,電話').error).toBe('missing_column');
    for (const month of ['2026-13', '2026-1', 'November']) {
      expect(refusalOf(`${HEADER}${responses(5)}`, ['--month', month])).toMatchObject({
        code: 2,
        error: 'usage',
      });
    }
  });

  it('refuses an option it does not know, a missing file and a file it cannot read', () => {
    const csv = fileURLToPath(new URL(EXPORTS.ja, DATA));
    expect(run([])).toMatchObject({ code: 2, refusal: { error: 'usage' } });
    expect(run([csv, '--channel', 'チャット'])).toMatchObject({ code: 2 });
    expect(run([path.join(ROOT, 'missing.csv')]).refusal).toMatchObject({
      error: 'unreadable_file',
    });
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'survey', access: 'read' }]);
  });

  it('asks its typed eval runs for the chart rows the script prints, and no comment', () => {
    const text = readFileSync(new URL('evals/survey.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/survey.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    const declared = surface.resultCharts?.map((chart) => chart.field);
    expect(declared).toEqual(['questions', 'channels']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of [
      'month',
      'minGroup',
      'nps',
      'heldBack',
      'commentary',
      ...(declared ?? []),
    ]) {
      expect(required).toContain(field);
    }
    expect(required).not.toContain('comments');
  });
});
