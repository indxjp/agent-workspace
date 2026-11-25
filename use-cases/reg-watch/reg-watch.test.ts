/**
 * The contract, moment and flow tiers of `reg-watch` (a scheduled report, archetype RP, reading a
 * public source). The flows prove what the entry claims: the public-notices tool answers from the
 * dated snapshot with no network, the weekly schedule starts a run that answers in the trigger's
 * output schema, and the report is saved only once the owner approves that one save.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { expect } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/reg-watch.ts';
import surface from './surfaces/main.ts';
import run from './tools/notices.run.ts';
import notices from './tools/notices.ts';

const signal = new AbortController().signal;
// The trigger file as `aw triggers create --file triggers/reg-watch.json --agent <id>` reads it.
const TRIGGER = JSON.parse(
  readFileSync(new URL('triggers/reg-watch.json', import.meta.url), 'utf8'),
) as object;

const SAVE = { file_path: '/workspace/reg-watch-reports/2026-11-23.md', content: '# 2026-11-23' };
const ANSWER = {
  date: '2026-11-23',
  asOf: '2026-11-20',
  notices: [
    {
      notice: 'PIC-2026-031',
      watch: 'W-01',
      effectiveDate: '2027-04-01',
      commentDeadline: null,
      changes: '速報の期限を「把握した日から3日以内」に改める。',
      dept: '法務部（個人情報取扱規程、漏えい対応手順）',
    },
  ],
  savedTo: SAVE.file_path,
};
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('reg-watch', {
  definitions: { 'agents/reg-watch.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the notices tool answers from the dated snapshot, newest first, with no network',
      run: async () => {
        expect(notices).toMatchObject({ name: 'read_reg_notices' });
        expect(notices).not.toHaveProperty('allowedDomains');

        const all = await run({}, { signal });
        expect(all).toMatchObject({ mode: 'snapshot', asOf: '2026-11-20', truncated: false });
        expect(all.records.map((record) => record.id)).toEqual([
          'ENV-2026-012',
          'LAB-2026-118',
          'PIC-2026-031',
          'CON-2026-044',
          'FTO-2026-207',
        ]);

        const labour = await run({ query: '労働時間' }, { signal });
        expect(labour.records.map((record) => record.id)).toEqual(['LAB-2026-118']);

        await expect(run({ query: 'x', advice: true }, { signal })).rejects.toThrow();
      },
    },
    {
      name: 'the weekly schedule starts a typed run, and its one save waits for approval',
      run: async ({ workspace }) => {
        const { aw, agentId, runs, fireSchedule } = workspace(
          async ({ native }) => {
            await native('Write', SAVE);
            return { text: '3件の通知を挙げたレポートを保存しました。', structured: ANSWER };
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
          required: ['date', 'asOf', 'notices', 'savedTo'],
        });

        const { run: approved } = await aw.runs.approve(paused.id);
        expect((await aw.runs.result(approved.id)).output).toEqual(ANSWER);
        expect(runs[1]?.approvedToolCalls).toHaveLength(1);
      },
    },
  ],
});
