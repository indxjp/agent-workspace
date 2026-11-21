/**
 * The contract, moment and flow tiers of `meeting-prep` (a scheduled report, archetype RP). The flow
 * proves what the entry claims: the morning schedule starts a run that answers in the trigger's
 * output schema, the day's briefs are saved only once the owner approves that one save, and the
 * continuation may make no other write.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { expect } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/meeting-prep.ts';
import surface from './surfaces/main.ts';

// The trigger file as `aw triggers create --file triggers/meeting-prep.json --agent <id>` reads it.
const TRIGGER = JSON.parse(
  readFileSync(new URL('triggers/meeting-prep.json', import.meta.url), 'utf8'),
) as object;

const SAVE = {
  file_path: '/workspace/meeting-prep-reports/2026-11-24.md',
  content: '# 10:00 株式会社ハルカゼ製作所',
};
const ANSWER = {
  date: '2026-11-24',
  briefs: ['ACC-001', 'ACC-002', 'ACC-003'].map((account, index) => ({
    meeting: `MTG-031${String(index + 1)}`,
    account,
    attendees: ['山本 美咲'],
    accountNotes: [`accounts.csv#${account}`],
    openDeals: [{ name: 'OPP', stage: '交渉', nextStep: '提示する' }],
    recentEmails: [],
    talkingPoints: [],
    sources: ['meetings.csv'],
  })),
  savedTo: SAVE.file_path,
};
// The gates are the agent definition's own, as the engine applies them.
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('meeting-prep', {
  definitions: { 'agents/meeting-prep.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the morning schedule starts a typed run, and its one save waits for approval',
      run: async ({ workspace }) => {
        const extra: string[] = [];
        const { aw, agentId, runs, fireSchedule } = workspace(
          async ({ native }) => {
            await native('Write', SAVE);
            // Any other write after the approved one is refused, never paused or made.
            extra.push(
              (await native('Write', { ...SAVE, file_path: '/workspace/shared/other.md' })).text,
            );
            return { text: '3件のブリーフを保存しました。', structured: ANSWER };
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
        expect(runs[0]?.outputSchema).toMatchObject({ required: ['date', 'briefs', 'savedTo'] });
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
