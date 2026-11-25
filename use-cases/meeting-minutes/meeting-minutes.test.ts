/**
 * The meeting-minutes use case (archetype RP, the rebuild of the gallery's minutes agent): the
 * contract, moment and flow tiers of the kit. The flows run the save script the way
 * `run_skill_script` does, so every deadline the saved minutes state comes from tested code: the
 * deadlines said in the two sample meetings (Friday 2026-10-02 and Monday 2026-10-05) in Japanese
 * and English, the phrases it leaves undated, and the refusals of a meeting date that is not a date
 * and a file that exists already. Its schedule trigger is one the platform accepts, and the save is
 * the one call that waits for a person.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runScript } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/meeting-minutes.ts';
import { compute, resolve, SPEC } from './skills/meeting-minutes/scripts/minutes.mjs';
import surface from './surfaces/main.ts';

const OUT = mkdtempSync(path.join(tmpdir(), 'meeting-minutes-'));

/** What `minutes.mjs <out> <options>` prints, and its exit code. */
function save(file: string, options: Record<string, string>) {
  const args = [
    path.join(OUT, file),
    ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v]),
  ];
  const out: string[] = [];
  const err: string[] = [];
  const code = runScript(args, SPEC, compute, {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
  });
  return { code, printed: JSON.parse(code === 0 ? out.join('') : err.join('')) as unknown };
}

describeUseCase('meeting-minutes', {
  definitions: { 'agents/meeting-minutes.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'dates the deadlines said in the two sample meetings, the same in Japanese and English',
      run: () => {
        // The production meeting, Friday 2026-10-02.
        expect(
          ['来週金曜', '月末', '3営業日後', '週明け', '来月10日'].map((said) =>
            resolve('2026-10-02', said),
          ),
        ).toEqual(['2026-10-09', '2026-10-31', '2026-10-07', '2026-10-05', '2026-11-10']);
        expect(
          [
            'next friday',
            'end of the month',
            'in 3 business days',
            'early next week',
            'the 10th of next month',
          ].map((said) => resolve('2026-10-02', said)),
        ).toEqual(['2026-10-09', '2026-10-31', '2026-10-07', '2026-10-05', '2026-11-10']);
        // The new product review, Monday 2026-10-05.
        expect(
          ['明日', '今週金曜', 'Tomorrow', 'this Friday'].map((said) =>
            resolve('2026-10-05', said),
          ),
        ).toEqual(['2026-10-06', '2026-10-09', '2026-10-06', '2026-10-09']);
        expect(resolve('2026-10-05', '再来週月曜')).toBe('2026-10-19');
        expect(resolve('2026-10-05', '来週金曜日')).toBe('2026-10-16');
        expect(resolve('2026-10-05', 'next tue')).toBe('2026-10-13');
        expect(resolve('2026-10-05', '10日後')).toBe('2026-10-15');
        expect(resolve('2026-10-05', 'in 1 day')).toBe('2026-10-06');
        expect(resolve('2026-10-05', '2026-12-01')).toBe('2026-12-01');
        // A business day count skips the weekend: from Friday, 1 is Monday; from Thursday, 2 is Monday.
        expect(resolve('2026-10-02', '1営業日後')).toBe('2026-10-05');
        expect(resolve('2026-10-01', 'in 2 business days')).toBe('2026-10-05');
        // The end of December rolls into the next year.
        expect(resolve('2026-12-14', '来月10日')).toBe('2027-01-10');
        for (const vague of [
          'なるべく早く',
          'as soon as possible',
          'なし',
          'next weekend',
          'next month',
          'this month',
          '来週中',
        ]) {
          expect(resolve('2026-10-02', vague)).toBeNull();
        }
      },
    },
    {
      name: 'saves the minutes with the dates, undated phrases labelled, and never over a file',
      run: () => {
        const text =
          '| 1 | 試行計画 | 楠瀬 一郎 | {{due:来週金曜}} |\n| 2 | パネル原稿 | 担当未定 | {{due:なるべく早く}} |\n';
        expect(save('2026-10-02_生産会議.md', { date: '2026-10-02', text })).toEqual({
          code: 0,
          printed: {
            written: path.join(OUT, '2026-10-02_生産会議.md'),
            date: '2026-10-02',
            deadlines: [
              { said: '来週金曜', due: '2026-10-09' },
              { said: 'なるべく早く', due: null },
            ],
          },
        });
        expect(readFileSync(path.join(OUT, '2026-10-02_生産会議.md'), 'utf8')).toBe(
          '| 1 | 試行計画 | 楠瀬 一郎 | 2026-10-09 |\n| 2 | パネル原稿 | 担当未定 | 期限未定 (なるべく早く) |\n',
        );
        save('en.md', {
          date: '2026-10-05',
          text: 'Due {{due:as soon as possible}}',
          undated: 'No date',
        });
        expect(readFileSync(path.join(OUT, 'en.md'), 'utf8')).toBe(
          'Due No date (as soon as possible)\n',
        );
        expect(save('2026-10-02_生産会議.md', { date: '2026-10-02', text }).printed).toEqual({
          error: 'output_exists',
          message: `${path.join(OUT, '2026-10-02_生産会議.md')} exists already`,
        });
        const usage = { error: 'usage', message: '--date YYYY-MM-DD, --text' };
        for (const date of ['2026-02-30', '2026/10/02', 'last Friday']) {
          expect(save('bad.md', { date, text })).toEqual({ code: 2, printed: usage });
        }
        expect(save('bad.md', { date: '2026-10-02' }).printed).toEqual(usage);
      },
    },
  ],
});

describe('meeting-minutes schedule and approval', () => {
  it('declares a schedule trigger the platform accepts, at 09:00 Tokyo or later, with a typed report', () => {
    const file = new URL('triggers/meeting-minutes.json', import.meta.url);
    const trigger = CreateTriggerRequestSchema.parse({
      ...(JSON.parse(readFileSync(file, 'utf8')) as object),
      agentId: '00000000-0000-4000-8000-000000000000',
    });
    expect(trigger).toMatchObject({
      kind: 'schedule',
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Tokyo',
    });
    expect(trigger.outputSchema).toMatchObject({ required: ['title', 'items', 'savedTo'] });
  });

  it('saves only through the script a person approves, and only under its reports folder', () => {
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([
      expect.objectContaining({ path: 'meeting-minutes', access: 'read' }),
      expect.objectContaining({ path: 'meeting-minutes-reports', access: 'read-write' }),
    ]);
  });
});
