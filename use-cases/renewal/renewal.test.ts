/**
 * The contract, moment and flow tiers of `renewal` (a scheduled report, archetype RP). The flow
 * proves what the entry claims: the weekday schedule starts a run that answers in the trigger's
 * output schema, the reminder with its draft emails is saved only once the owner approves that one
 * save, and the continuation may make no other write. Nothing is sent: the agent has no send tool.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { expect } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/renewal.ts';
import surface from './surfaces/main.ts';

// The trigger file as `aw triggers create --file triggers/renewal.json --agent <id>` reads it.
const TRIGGER = JSON.parse(
  readFileSync(new URL('triggers/renewal.json', import.meta.url), 'utf8'),
) as object;

const SAVE = {
  file_path: '/workspace/renewal-reports/2026-11-24.md',
  content: '# 2026-11-24 契約更新リマインド',
};
const ANSWER = {
  date: '2026-11-24',
  contracts: [
    {
      contract: 'C-2406',
      account: '株式会社ヒバリ薬品',
      endDate: '2026-12-05',
      daysToEnd: 11,
      urgent: true,
      owner: '檜山 拓海',
      draft: {
        to: 'kusunoki@hibari-pharma.example',
        subject: '品質記録クラウドのご契約更新について',
        body: '2026-12-05 に満了を迎えます。更新についてお打ち合わせのお時間をいただけますか。',
      },
      sources: ['contracts.csv#C-2406'],
    },
  ],
  savedTo: SAVE.file_path,
};
// The gates are the agent definition's own, as the engine applies them.
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('renewal', {
  definitions: { 'agents/renewal.ts': agent, 'surfaces/main.ts': surface },
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
            return { text: '更新リマインドを保存しました。', structured: ANSWER };
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
        expect(runs[0]?.outputSchema).toMatchObject({ required: ['date', 'contracts', 'savedTo'] });
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
