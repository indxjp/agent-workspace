/**
 * The contract, moment and flow tiers of `sla-watch` (a scheduled report, archetype RP). The flow
 * proves what the entry claims: the daily schedule starts a run that answers in the trigger's
 * output schema, the report is saved only once the owner approves that one save, and the
 * continuation may make no other write.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { expect } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/sla-watch.ts';
import surface from './surfaces/main.ts';

// The trigger file as `aw triggers create --file triggers/sla-watch.json --agent <id>` reads it.
const TRIGGER = JSON.parse(
  readFileSync(new URL('triggers/sla-watch.json', import.meta.url), 'utf8'),
) as object;

const SAVE = {
  file_path: '/workspace/sla-watch-reports/2026-11-24.md',
  content: '# 2026-11-24 SLA監視',
};
const ANSWER = {
  date: '2026-11-24',
  tickets: [
    {
      ticket: 'T-5203',
      subject: '請求書を再発行してほしい',
      sla: 'near',
      minutesLeftAtExport: 45,
      owner: '未割当',
      nextStep: '担当者を決める',
      sources: ['tickets.csv#T-5203'],
    },
  ],
  savedTo: SAVE.file_path,
};
// The gates are the agent definition's own, as the engine applies them.
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('sla-watch', {
  definitions: { 'agents/sla-watch.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the daily schedule starts a typed run, and its one save waits for approval',
      run: async ({ workspace }) => {
        const extra: string[] = [];
        const { aw, agentId, runs, fireSchedule } = workspace(
          async ({ native }) => {
            await native('Write', SAVE);
            // Any other write after the approved one is refused, never paused or made.
            extra.push(
              (await native('Write', { ...SAVE, file_path: '/workspace/shared/other.md' })).text,
            );
            return { text: '4件のチケットを挙げたレポートを保存しました。', structured: ANSWER };
          },
          {},
          {},
          { requireApproval: gated },
        );
        const request = CreateTriggerRequestSchema.parse({ ...TRIGGER, agentId });
        const { outputSchema } = request;
        if (outputSchema === undefined) throw new Error('the trigger asks for no typed output');
        const { trigger: created } = await aw.triggers.create({ ...request, outputSchema });
        // Every day at 09:00 in Tokyo, 00:00 UTC: today's date agrees in Japan and on the runtime.
        expect(created).toMatchObject({
          kind: 'schedule',
          cron: '0 9 * * *',
          timezone: 'Asia/Tokyo',
        });

        const paused = await aw.runs.waitForOutcome((await fireSchedule(created.id)).id);
        expect(paused.status).toBe('awaiting_approval');
        expect(runs[0]?.prompt).toBe(request.prompt);
        expect(runs[0]?.outputSchema).toMatchObject({ required: ['date', 'tickets', 'savedTo'] });
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
