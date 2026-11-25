/**
 * The contract, moment and flow tiers of `competitor` (a scheduled report, archetype RP, reading a
 * public source). The flows prove what the entry claims: the releases tool answers from the dated
 * snapshot with no network, the weekly schedule starts a run that answers in the trigger's output
 * schema, and the report is saved only once the owner approves that one save.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { expect } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/competitor.ts';
import surface from './surfaces/main.ts';
import run from './tools/releases.run.ts';
import releases from './tools/releases.ts';

const signal = new AbortController().signal;
// The trigger file as `aw triggers create --file triggers/competitor.json --agent <id>` reads it.
const TRIGGER = JSON.parse(
  readFileSync(new URL('triggers/competitor.json', import.meta.url), 'utf8'),
) as object;

const SAVE = { file_path: '/workspace/competitor-reports/2026-11-23.md', content: '# 2026-11-23' };
const ANSWER = {
  date: '2026-11-23',
  asOf: '2026-11-20',
  changes: [
    {
      row: 'C-05',
      release: 'TSU-004',
      item: 'オフライン対応',
      before: 'なし',
      after: 'あり',
      from: null,
    },
  ],
  savedTo: SAVE.file_path,
};
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('competitor', {
  definitions: { 'agents/competitor.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the releases tool answers from the dated snapshot, newest first, with no network',
      run: async () => {
        expect(releases).toMatchObject({ name: 'read_competitor_news' });
        expect(releases).not.toHaveProperty('allowedDomains');

        const all = await run({}, { signal });
        expect(all).toMatchObject({ mode: 'snapshot', asOf: '2026-11-20', truncated: false });
        expect(all.records.map((record) => record.id)).toEqual([
          'NNK-002',
          'UKG-003',
          'TSU-004',
          'UKG-002',
        ]);

        const ukigumo = await run({ query: 'UKG' }, { signal });
        expect(ukigumo.records.map((record) => record.id)).toEqual(['UKG-003', 'UKG-002']);

        await expect(run({ query: 'x', share: true }, { signal })).rejects.toThrow();
      },
    },
    {
      name: 'the weekly schedule starts a typed run, and its one save waits for approval',
      run: async ({ workspace }) => {
        const { aw, agentId, runs, fireSchedule } = workspace(
          async ({ native }) => {
            await native('Write', SAVE);
            return { text: '変更のある行を挙げたレポートを保存しました。', structured: ANSWER };
          },
          {},
          {},
          { requireApproval: gated },
        );
        const request = CreateTriggerRequestSchema.parse({ ...TRIGGER, agentId });
        const { outputSchema } = request;
        if (outputSchema === undefined) throw new Error('the trigger asks for no typed output');
        const { trigger } = await aw.triggers.create({ ...request, outputSchema });
        expect(trigger).toMatchObject({ cron: '0 9 * * 1', timezone: 'Asia/Tokyo' });

        const paused = await aw.runs.waitForOutcome((await fireSchedule(trigger.id)).id);
        expect(paused.status).toBe('awaiting_approval');
        expect(runs[0]?.outputSchema).toMatchObject({
          required: ['date', 'asOf', 'changes', 'savedTo'],
        });

        const { run: approved } = await aw.runs.approve(paused.id);
        expect((await aw.runs.result(approved.id)).output).toEqual(ANSWER);
        expect(runs[1]?.approvedToolCalls).toHaveLength(1);
      },
    },
  ],
});
