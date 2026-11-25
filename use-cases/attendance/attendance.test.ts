/**
 * The contract, moment and flow tiers of `attendance` (a scheduled report, archetype RP). The flow
 * proves what the entry claims: the Monday schedule starts a run that answers in the trigger's
 * output schema, the check is saved only once the owner approves that one save, and the
 * continuation may make no other write. The rule that a person decides about people: the trigger's
 * schema has no field that scores, ranks, compares or disciplines anyone, and a safety case asks
 * for a ranking and a disciplinary list.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/attendance.ts';
import surface from './surfaces/main.ts';

// The trigger file as `aw triggers create --file triggers/attendance.json --agent <id>` reads it.
const TRIGGER = JSON.parse(
  readFileSync(new URL('triggers/attendance.json', import.meta.url), 'utf8'),
) as object;

const SAVE = {
  file_path: '/workspace/attendance-reports/2026-11-16_attendance.md',
  content: '# 勤怠チェック 2026-11-16〜2026-11-20（月次集計 2026-11-20 時点）',
};
const ANSWER = {
  week: '2026-11-16/2026-11-20',
  managers: [
    {
      manager: '東雲 誠',
      team: '製造1課',
      gaps: [
        {
          employee: '浅葱 柚月',
          kind: 'missed_clock_out',
          dates: ['2026-11-18'],
          detail: '退勤の打刻が空欄',
          sources: ['打刻データ_2026-11-16_2026-11-20.csv#E1021 2026-11-18'],
        },
      ],
    },
  ],
  savedTo: SAVE.file_path,
};
// The gates are the agent definition's own, as the engine applies them.
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('attendance', {
  definitions: { 'agents/attendance.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the Monday schedule starts a typed run, and its one save waits for approval',
      run: async ({ workspace }) => {
        const extra: string[] = [];
        const { aw, agentId, runs, fireSchedule } = workspace(
          async ({ native }) => {
            await native('Write', SAVE);
            // Any other write after the approved one is refused, never paused or made.
            extra.push(
              (await native('Write', { ...SAVE, file_path: '/workspace/shared/other.md' })).text,
            );
            return { text: '2人の上長あての勤怠チェックを保存しました。', structured: ANSWER };
          },
          {},
          {},
          { requireApproval: gated },
        );
        const request = CreateTriggerRequestSchema.parse({ ...TRIGGER, agentId });
        const { outputSchema } = request;
        if (outputSchema === undefined) throw new Error('the trigger asks for no typed output');
        const { trigger: created } = await aw.triggers.create({ ...request, outputSchema });
        // Mondays at 09:00 in Tokyo, 00:00 UTC: today's date agrees in Japan and on the runtime.
        expect(created).toMatchObject({
          kind: 'schedule',
          cron: '0 9 * * 1',
          timezone: 'Asia/Tokyo',
        });

        const paused = await aw.runs.waitForOutcome((await fireSchedule(created.id)).id);
        expect(paused.status).toBe('awaiting_approval');
        expect(runs[0]?.prompt).toBe(request.prompt);
        expect(runs[0]?.outputSchema).toMatchObject({ required: ['week', 'managers', 'savedTo'] });
        expect(extra).toEqual([]);

        const { run } = await aw.runs.approve(paused.id);
        const { output } = await aw.runs.result(run.id);
        expect(output).toEqual(ANSWER);
        expect(runs[1]?.approvedToolCalls).toHaveLength(1);
        expect(extra).toEqual([expect.stringContaining('approval_call_mismatch')]);
      },
    },
  ],
});

describe('attendance: a person decides about people', () => {
  it('asks for typed output with no field that scores, ranks, compares or disciplines', () => {
    const fields = [...JSON.stringify(TRIGGER).matchAll(/"([A-Za-z]+)":/g)].map(([, name]) => name);
    expect(fields).toContain('gaps');
    for (const field of fields) {
      expect(field).not.toMatch(
        /^(score|rank|ranking|rating|grade|evaluation|discipline|penalty|warning|worst)$|(Score|Rank|Rating|Grade|Discipline|Penalty)$/,
      );
    }
    expect(TRIGGER).toMatchObject({
      outputSchema: {
        additionalProperties: false,
        properties: {
          managers: {
            items: {
              additionalProperties: false,
              properties: { gaps: { items: { additionalProperties: false } } },
            },
          },
        },
      },
    });
  });

  it('evaluates the typed answer in the trigger’s own output schema', () => {
    const text = readFileSync(new URL('evals/attendance.yaml', import.meta.url), 'utf8');
    const typed = readEvalCaseFile(text, 'evals/attendance.yaml').cases.filter(
      (evalCase) => evalCase.outputSchema !== undefined,
    );
    expect(typed.map((evalCase) => evalCase.outputSchema)).toEqual([
      (TRIGGER as { outputSchema: unknown }).outputSchema,
    ]);
  });

  it('has a safety case that asks for a ranking, scores and a disciplinary list', () => {
    const text = readFileSync(new URL('evals/attendance.yaml', import.meta.url), 'utf8');
    const asks = readEvalCaseFile(text, 'evals/attendance.yaml').cases.filter(
      (evalCase) => evalCase.tags?.includes('safety') && /順位|懲戒/.test(evalCase.input),
    );
    expect(asks).not.toHaveLength(0);
  });
});
