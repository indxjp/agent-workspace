/**
 * The contract, moment and flow tiers of `project-status` (a scheduled report, archetype RP). The flow
 * proves what the entry claims: the weekly schedule starts a run that answers in the trigger's
 * output schema, the report is saved only once the owner approves that one save, and the
 * continuation may make no other write.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { expect } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/project-status.ts';
import surface from './surfaces/main.ts';

// The trigger file as `aw triggers create --file triggers/project-status.json --agent <id>` reads it.
const TRIGGER = JSON.parse(
  readFileSync(new URL('triggers/project-status.json', import.meta.url), 'utf8'),
) as object;

const SAVE = {
  file_path: '/workspace/project-status-reports/2026-11-27.md',
  content: '# 2026-11-27 プロジェクト週報',
};
const ANSWER = {
  date: '2026-11-27',
  workstreams: [
    {
      name: 'データ移行',
      rag: 'red',
      evidence: ['MS-01 の見込み 2026-12-18 が期日 2026-12-11 より遅い'],
      openRisks: ['R-01 商品コードの重複（影響：高、対策なし）'],
      sources: ['milestones.csv#MS-01', 'risks.csv#R-01'],
    },
  ],
  savedTo: SAVE.file_path,
};
// The gates are the agent definition's own, as the engine applies them.
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('project-status', {
  definitions: { 'agents/project-status.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the weekly schedule starts a typed run, and its one save waits for approval',
      run: async ({ workspace }) => {
        const extra: string[] = [];
        const { aw, agentId, runs, fireSchedule } = workspace(
          async ({ native }) => {
            await native('Write', SAVE);
            // Any other write after the approved one is refused, never paused or made.
            extra.push(
              (await native('Write', { ...SAVE, file_path: '/workspace/shared/other.md' })).text,
            );
            return { text: '三つの作業の流れの週報を保存しました。', structured: ANSWER };
          },
          {},
          {},
          { requireApproval: gated },
        );
        const request = CreateTriggerRequestSchema.parse({ ...TRIGGER, agentId });
        const { outputSchema } = request;
        if (outputSchema === undefined) throw new Error('the trigger asks for no typed output');
        const { trigger: created } = await aw.triggers.create({ ...request, outputSchema });
        // Fridays at 09:00 in Tokyo, 00:00 UTC: today's date agrees in Japan and on the runtime.
        expect(created).toMatchObject({
          kind: 'schedule',
          cron: '0 9 * * 5',
          timezone: 'Asia/Tokyo',
        });

        const paused = await aw.runs.waitForOutcome((await fireSchedule(created.id)).id);
        expect(paused.status).toBe('awaiting_approval');
        expect(runs[0]?.prompt).toBe(request.prompt);
        expect(runs[0]?.outputSchema).toMatchObject({
          required: ['date', 'workstreams', 'savedTo'],
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
