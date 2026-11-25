/**
 * The contract, moment and flow tiers of `close` (a scheduled report, archetype RP). The flow
 * proves what the entry claims: the weekday schedule starts a run that answers in the trigger's
 * output schema, the progress report is saved only once the owner approves that one
 * save, and the continuation may make no other write. No entry is posted: the agent has no ledger tool.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { expect } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/close.ts';
import surface from './surfaces/main.ts';

// The trigger file as `aw triggers create --file triggers/close.json --agent <id>` reads it.
const TRIGGER = JSON.parse(
  readFileSync(new URL('triggers/close.json', import.meta.url), 'utf8'),
) as object;

const SAVE = {
  file_path: '/workspace/close-reports/2026-12-03.md',
  content: '# 2026-11 月次決算 2026-12-03 時点',
};
const ANSWER = {
  date: '2026-12-03',
  period: '2026-11',
  progress: { scope: '全体', total: 10, done: 3, blocked: 2, overdue: 2 },
  stuck: [
    {
      task: 'CL-03',
      name: '銀行勘定の照合',
      owner: '杉森 蓮',
      dueDate: '2026-12-02',
      kind: 'blocked',
      reason: 'ユキヤナギ信用金庫の11月分の入出金明細が届いていない',
      nextStep: '明細の再送の状況を信用金庫に確認する',
      sources: ['close-tasks.csv#CL-03'],
    },
  ],
  savedTo: SAVE.file_path,
};
// The gates are the agent definition's own, as the engine applies them.
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('close', {
  definitions: { 'agents/close.ts': agent, 'surfaces/main.ts': surface },
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
            return { text: '進捗レポートを保存しました。', structured: ANSWER };
          },
          {},
          {},
          { requireApproval: gated },
        );
        const request = CreateTriggerRequestSchema.parse({ ...TRIGGER, agentId });
        const { outputSchema } = request;
        if (outputSchema === undefined) throw new Error('the trigger asks for no typed output');
        const { trigger: created } = await aw.triggers.create({ ...request, outputSchema });
        // 09:00 in Tokyo is 00:00 UTC: from then on today's date agrees in Japan and on the runtime.
        expect(created).toMatchObject({
          kind: 'schedule',
          cron: '0 9 * * 1-5',
          timezone: 'Asia/Tokyo',
        });

        const paused = await aw.runs.waitForOutcome((await fireSchedule(created.id)).id);
        expect(paused.status).toBe('awaiting_approval');
        expect(runs[0]?.prompt).toBe(request.prompt);
        expect(runs[0]?.outputSchema).toMatchObject({
          required: ['date', 'period', 'progress', 'stuck', 'savedTo'],
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
