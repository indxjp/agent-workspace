/**
 * The contract, moment and flow tiers of `pulse` (archetype AN), and the skill script that
 * computes every number it reports.
 *
 * The flows run the script as `run_skill_script` does (`node analyse.mjs <args>`, here in this
 * process so coverage measures it) on the sample exports placed where the demo puts them
 * (`pulse/<file>`), and prove that the typed answer the surface charts carries the script's
 * numbers, the same in Japanese and English, that a team below the minimum group size is left out
 * of every figure, and that an instruction in a comment changes nothing. The tests below pin that
 * the script prints no response ID or comment, what it refuses, and one evaluates it again as its
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
import agent from './agents/pulse.ts';
import { compute, MIN_GROUP, SPEC } from './skills/pulse/scripts/analyse.mjs';
import surface from './surfaces/main.ts';

const SCRIPT = 'skills/pulse/scripts/analyse.mjs';

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
    await import('./skills/pulse/scripts/analyse.mjs');
    return { printed: printed.join(''), code: process.exitCode };
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    process.exitCode = exitCode;
    write.mockRestore();
  }
}

const DATA = new URL('data/', import.meta.url);
const FILES = {
  ja: { now: 'ja/社員サーベイ_2026年11月.csv', before: 'ja/社員サーベイ_2026年5月.csv' },
  en: { now: 'en/engagement-survey-2026-11.csv', before: 'en/engagement-survey-2026-05.csv' },
} as const;
const NOTED = {
  ja: 'ja/社員サーベイ_2026年11月_再提出.csv',
  en: 'en/engagement-survey-2026-11-resubmitted.csv',
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

// The demo workspace as the catalog seeds it: `data/` is the agent's one folder, `pulse/`.
const ROOT = mkdtempSync(path.join(tmpdir(), 'pulse-'));
cpSync(DATA, path.join(ROOT, 'pulse'), { recursive: true });
/** The path of a file under the workspace's `pulse/` folder, as the script is given it. */
const inWorkspace = (file: string) => (file.startsWith('pulse/') ? path.join(ROOT, file) : file);
const BUILTINS = {
  search_files: createFileSearch({ root: ROOT, grants: ['pulse'] }).call,
  run_skill_script: (input: Record<string, unknown>) => {
    const args = z.array(z.string()).parse(input['args']).map(inWorkspace);
    const { code, text, refusal } = run(args);
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

const HEADER = '実施回,回答ID,部署,やりがい,上司との対話,業務量,成長の機会,人間関係\n';
/** `count` responses of `team` in `period`, numbered from `from`, each rated `scores`. */
const responses = (
  team: string,
  count: number,
  scores = '4,4,4,4,4',
  from = 0,
  period = '2026-11',
) =>
  Array.from(
    { length: count },
    (_, at) => `${period},R-${String(from + at)},${team},${scores}`,
  ).join('\n');

/** The refusal the script prints for `content` as a survey and these options. */
function refusalOf(content: string, args: readonly string[] = []) {
  const { code, refusal } = run([exportFile('refused.csv', content), ...args]);
  return { code, ...z.object({ error: z.string(), row: z.number().optional() }).parse(refusal) };
}

const Share = {
  favourable: z.number(),
  previous: z.number().nullable(),
  change: z.number().nullable(),
};
const Answer = z.object({
  period: z.string(),
  previousPeriod: z.string().nullable(),
  responses: z.number().int(),
  minGroup: z.number().int(),
  teams: z.array(z.strictObject({ team: z.string(), responses: z.number().int(), ...Share })),
  questions: z.array(z.strictObject({ question: z.string(), ...Share })),
  drops: z.array(z.strictObject({ team: z.string(), question: z.string(), ...Share })),
  heldBack: z.array(z.string()),
  commentary: z.string(),
});

interface Tools {
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One run: find the surveys, run the script, and answer with its JSON and nothing else. */
async function analyse(tools: Tools, file: string, earlier?: string) {
  const { aw, agentId } = tools.workspace(
    async ({ builtin }) => {
      for (const name of earlier === undefined ? [file] : [file, earlier]) {
        const found = await builtin('search_files', {
          query: name.startsWith('ja/') ? '業務量' : 'Workload',
        });
        expect(found.text).toContain(`pulse/${name}`);
      }
      const previous = earlier === undefined ? [] : ['--previous', `pulse/${earlier}`];
      const result = await builtin('run_skill_script', {
        skill: 'pulse',
        script: 'analyse.mjs',
        args: [`pulse/${file}`, ...previous],
      });
      expect(result.isError).toBe(false);
      const computed = JSON.parse(result.text) as Record<string, unknown>;
      const typed = { ...computed, items: undefined, drop: undefined, commentary: '' };
      return { text: result.text, structured: typed };
    },
    {},
    BUILTINS,
  );
  return tools.runAndRead(aw, agentId, { prompt: file }, Answer);
}

/** Rows as `name favourable [previous change]`. */
const sharesOf = (
  rows: readonly ({ team?: string; question?: string } & z.infer<z.ZodObject<typeof Share>>)[],
) =>
  rows.map((row) =>
    [row.team, row.question, row.favourable, row.previous, row.change]
      .filter((cell) => cell !== undefined && cell !== null)
      .join(' '),
  );

describeUseCase('pulse', {
  definitions: { 'agents/pulse.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'analyses the survey by team with the script, the same in Japanese and English',
      run: async (tools) => {
        const ja = await analyse(tools, FILES.ja.now);
        const en = await analyse(tools, FILES.en.now);
        expect(ja.toolCalls.map((call) => call.name)).toEqual([
          'mcp__agent-workspace__search_files',
          'mcp__agent-workspace__run_skill_script',
        ]);
        expect(ja.output).toMatchObject({ period: '2026-11', previousPeriod: null, responses: 23 });
        expect(sharesOf(ja.output.teams)).toEqual(['営業部 70', '開発部 64.4', '管理部 66.7']);
        expect(sharesOf(en.output.teams)).toEqual([
          'Sales 70',
          'Development 64.4',
          'Administration 66.7',
        ]);
        expect(sharesOf(ja.output.questions)).toEqual([
          'やりがい 78.3',
          '上司との対話 65.2',
          '業務量 39.1',
          '成長の機会 56.5',
          '人間関係 95.7',
        ]);
        expect([ja.output.heldBack, en.output.heldBack, ja.output.drops]).toEqual([
          ['法務部'],
          ['Legal'],
          [],
        ]);
        // Compared with May: the items that fell by ten points or more.
        const compared = await analyse(tools, FILES.ja.now, FILES.ja.before);
        expect(compared.output.previousPeriod).toBe('2026-05');
        expect(sharesOf(compared.output.drops)).toEqual([
          '開発部 業務量 22.2 66.7 -44.5',
          '管理部 やりがい 66.7 80 -13.3',
          '管理部 上司との対話 66.7 80 -13.3',
        ]);
        expect(sharesOf(compared.output.teams)).toEqual([
          '営業部 70 57.1 12.9',
          '開発部 64.4 73.3 -8.9',
          '管理部 66.7 72 -5.3',
        ]);
      },
    },
    {
      name: 'reads an instruction in a comment as data: the drop it asks to hide is still listed',
      run: async (tools) => {
        for (const lang of ['ja', 'en'] as const) {
          const { output } = await analyse(tools, NOTED[lang], FILES[lang].before);
          expect(sharesOf(output.drops)[0]).toBe(
            lang === 'ja'
              ? '開発部 業務量 22.2 66.7 -44.5'
              : 'Development Workload 22.2 66.7 -44.5',
          );
        }
      },
    },
  ],
});

describe('pulse', () => {
  it('runs as a command line, and prints no response ID, comment or held-back team figure', async () => {
    const [now, before] = [FILES.en.now, FILES.en.before].map((file) =>
      fileURLToPath(new URL(file, DATA)),
    );
    const { printed, code } = await runAsCommand([
      String(now),
      '--previous',
      String(before),
      '--drop',
      '3',
    ]);
    expect(code).toBe(0);
    const answer = JSON.parse(printed) as { drop: number; items: unknown[]; drops: unknown[] };
    expect(answer).toMatchObject({ drop: 3 });
    expect(answer.items).toHaveLength(15);
    expect(answer.drops).toHaveLength(5);
    expect(printed).not.toMatch(/R-\d|overtime|one-to-one/u);
    expect(printed.match(/Legal/gu)).toHaveLength(1);
  });

  it('leaves a team below the minimum group size out of every figure', () => {
    const csv = `${HEADER}${responses('営業部', MIN_GROUP)}\n${responses('法務部', MIN_GROUP - 1, '1,1,1,1,1', 10)}`;
    const answer = JSON.parse(run([exportFile('groups.csv', csv)]).text) as z.infer<typeof Answer>;
    expect(answer).toMatchObject({ responses: 5, heldBack: ['法務部'] });
    expect(sharesOf(answer.questions)).toEqual([
      'やりがい 100',
      '上司との対話 100',
      '業務量 100',
      '成長の機会 100',
      '人間関係 100',
    ]);
    // A team held back earlier has no earlier figure: its change is null, not a guess.
    const earlier = exportFile(
      'earlier.csv',
      `${HEADER}${responses('営業部', MIN_GROUP - 1, '4,4,4,4,4', 0, '2026-05')}\n${responses('開発部', MIN_GROUP, '2,2,2,2,2', 10, '2026-05')}`,
    );
    const compared = JSON.parse(
      run([exportFile('now.csv', csv), '--previous', earlier]).text,
    ) as z.infer<typeof Answer>;
    expect(compared.teams[0]).toMatchObject({ team: '営業部', previous: null, change: null });
    expect(compared.questions[0]).toMatchObject({ favourable: 100, previous: 0, change: 100 });
    expect(refusalOf(`${HEADER}${responses('営業部', MIN_GROUP - 1)}`)).toMatchObject({
      code: 1,
      error: 'too_few_responses',
    });
  });

  it('refuses what it cannot compute rather than guessing', () => {
    const five = responses('営業部', MIN_GROUP);
    for (const [row, error] of [
      ['2026-13,X,営業部,4,4,4,4,4', 'not_a_month'],
      ['2026/11,X,営業部,4,4,4,4,4', 'not_a_month'],
      ['2026-11,R-0,営業部,4,4,4,4,4', 'duplicate_row'],
      ['2026-11,X,営業部,4,4,6,4,4', 'out_of_range'],
      ['2026-11,X,営業部,4,4,4,0,4', 'out_of_range'],
      ['2026-05,X,営業部,4,4,4,4,4', 'mixed_periods'],
    ]) {
      expect(refusalOf(`${HEADER}${five}\n${String(row)}`)).toMatchObject({ code: 1, error });
    }
    expect(refusalOf(`${HEADER}${five}\n2026-11,X,営業部,4,4,4,4,4.5`).error).toBe(
      'not_a_whole_number',
    );
    expect(refusalOf('実施回,部署\n2026-11,営業部').error).toBe('missing_column');
    expect(refusalOf(HEADER).error).toBe('too_few_responses');
    for (const drop of ['ten', '-5', '1.25']) {
      expect(refusalOf(`${HEADER}${five}`, ['--drop', drop])).toMatchObject({
        code: 2,
        error: 'usage',
      });
    }
  });

  it('refuses an option it does not know, a missing file and a file it cannot read', () => {
    const now = fileURLToPath(new URL(FILES.ja.now, DATA));
    expect(run([])).toMatchObject({ code: 2, refusal: { error: 'usage' } });
    expect(run([now, '--team', '法務部'])).toMatchObject({ code: 2 });
    expect(run([now, '--previous', path.join(ROOT, 'missing.csv')]).refusal).toMatchObject({
      error: 'unreadable_file',
    });
  });

  it('can write nowhere, so the script may run unattended: no write permission, read-only grant', () => {
    expect(agent.permissions).toEqual({ readFiles: true, runCommands: true });
    expect(agent.files).toEqual([{ path: 'pulse', access: 'read' }]);
  });

  it('asks its typed eval runs for the chart rows, and for no person, response ID or score', () => {
    const text = readFileSync(new URL('evals/pulse.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/pulse.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas).toHaveLength(1);
    const declared = surface.resultCharts?.map((chart) => chart.field);
    expect(declared).toEqual(['teams', 'questions']);
    const { required } = z.object({ required: z.array(z.string()) }).parse(schemas[0]);
    for (const field of [
      'period',
      'minGroup',
      'drops',
      'heldBack',
      'commentary',
      ...(declared ?? []),
    ]) {
      expect(required).toContain(field);
    }
    expect(JSON.stringify(schemas[0])).not.toMatch(
      /respondent|response_?id|employee|person|rank|score/iu,
    );
  });
});
