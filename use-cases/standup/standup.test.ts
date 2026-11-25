/**
 * The contract, moment and flow tiers of `standup` (a scheduled report, archetype RP). The flow
 * proves what the entry claims: the weekday schedule starts a run that answers in the trigger's
 * output schema, the report is saved only once the owner approves that one save, and the
 * continuation may make no other write.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { expect } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/standup.ts';
import surface from './surfaces/main.ts';

// The trigger file as `aw triggers create --file triggers/standup.json --agent <id>` reads it.
const TRIGGER = JSON.parse(
  readFileSync(new URL('triggers/standup.json', import.meta.url), 'utf8'),
) as object;

const SAVE = {
  file_path: '/workspace/standup-reports/2026-11-25.md',
  content: '# 2026-11-25 朝会まとめ（2026-11-24 分）',
};
const ANSWER = {
  date: '2026-11-25',
  covers: '2026-11-24',
  people: [
    {
      person: '千早 湊',
      yesterday: ['注文一覧の絞り込み機能を完了'],
      today: ['注文詳細画面のクエリを直してレビューに出す'],
      blockers: [],
      sources: ['tasks.csv#TSK-412', 'chat.csv#MSG-801'],
    },
  ],
  savedTo: SAVE.file_path,
};
// The gates are the agent definition's own, as the engine applies them.
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('standup', {
  definitions: { 'agents/standup.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the weekday schedule starts a typed run, and its one save waits for approval',
      run: async ({ workspace }) => {
        const extra: string[] = [];
        const { aw, agentId, runs, fireSchedule } = workspace(
          async ({ native }) => {
            await native('Write', SAVE);
            // Any other write after the approved one is refused, never paused or made.
            extra.push(
              (await native('Write', { ...SAVE, file_path: '/workspace/shared/other.md' })).text,
            );
            return { text: '3人分の朝会まとめを保存しました。', structured: ANSWER };
          },
          {},
          {},
          { requireApproval: gated },
        );
        const request = CreateTriggerRequestSchema.parse({ ...TRIGGER, agentId });
        const { outputSchema } = request;
        if (outputSchema === undefined) throw new Error('the trigger asks for no typed output');
        const { trigger: created } = await aw.triggers.create({ ...request, outputSchema });
        // Weekdays at 09:00 in Tokyo, 00:00 UTC: today's date agrees in Japan and on the runtime.
        expect(created).toMatchObject({
          kind: 'schedule',
          cron: '0 9 * * 1-5',
          timezone: 'Asia/Tokyo',
        });

        const paused = await aw.runs.waitForOutcome((await fireSchedule(created.id)).id);
        expect(paused.status).toBe('awaiting_approval');
        expect(runs[0]?.prompt).toBe(request.prompt);
        expect(runs[0]?.outputSchema).toMatchObject({
          required: ['date', 'covers', 'people', 'savedTo'],
        });
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
