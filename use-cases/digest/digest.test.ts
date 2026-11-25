/**
 * The contract, moment and flow tiers of `digest` (a scheduled report, archetype RP). The flows
 * prove what the entry claims: the public-source tool (ADR-0170) answers from the shipped dated
 * snapshot with no network, newest first and from a given day; and the Monday schedule starts a run
 * that answers in the trigger's output schema, whose one save waits for the owner's approval and
 * whose continuation may make no other write.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { expect } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/digest.ts';
import surface from './surfaces/main.ts';
import run from './tools/sources.run.ts';
import publicSources from './tools/sources.ts';

// The trigger file as `aw triggers create --file triggers/digest.json --agent <id>` reads it.
const TRIGGER = JSON.parse(
  readFileSync(new URL('triggers/digest.json', import.meta.url), 'utf8'),
) as object;
const signal = new AbortController().signal;

const SAVE = {
  file_path: '/workspace/digest-reports/2026-11-24.md',
  content: '# 物流倉庫の自動化 2026-11-18〜2026-11-24',
};
const ANSWER = {
  weekEnding: '2026-11-24',
  asOf: '2026-11-24',
  items: [
    {
      date: '2026-11-19',
      kind: 'public',
      title: '自動搬送ロボット 国内出荷実績 2026年度上期',
      summary: '2026年度上期の国内出荷は2,150台（前年同期比 22% 増）。',
      citation:
        '〔Fictional Logistics Equipment Association, 自動搬送ロボット 国内出荷実績, 2026-11-19〕',
    },
  ],
  savedTo: SAVE.file_path,
};
// The gates are the agent definition's own, as the engine applies them.
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('digest', {
  definitions: { 'agents/digest.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the public-source tool answers from the dated snapshot, from a given day, with no network',
      run: async () => {
        expect(publicSources).toMatchObject({ name: 'read_digest_sources' });
        expect(publicSources).not.toHaveProperty('allowedDomains');

        const week = await run({ since: '2026-11-18' }, { signal });
        expect(week).toMatchObject({ mode: 'snapshot', asOf: '2026-11-24', truncated: false });
        expect(week.records.map((record) => record.id)).toEqual([
          'TOBI-2026-11-21',
          'FSB-2026-11-20',
          'FLEA-2026-11-19',
          'FTPI-2026-11-18',
        ]);

        const warehouse = await run({ query: 'warehouse', since: '2026-11-11' }, { signal });
        expect(warehouse.records.map((record) => record.id)).not.toContain('FSB-2026-11-20');

        await expect(run({ since: '2026-11-18', forecast: true }, { signal })).rejects.toThrow();
      },
    },
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
            return { text: '調査ダイジェストを保存しました。', structured: ANSWER };
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
        expect(runs[0]?.outputSchema).toMatchObject({
          required: ['weekEnding', 'asOf', 'items', 'savedTo'],
        });
        expect(extra).toEqual([]);

        const { run: resumed } = await aw.runs.approve(paused.id);
        const { output } = await aw.runs.result(resumed.id);
        expect(output).toEqual(ANSWER);
        expect(runs[1]?.approvedToolCalls).toHaveLength(1);
        expect(extra).toEqual([expect.stringContaining('approval_call_mismatch')]);
      },
    },
  ],
});
