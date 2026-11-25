/**
 * The contract, moment and flow tiers of `trend` (a scheduled report, archetype RP, reading a public
 * source). The flows prove what the entry claims: the news tool answers from the dated snapshot with
 * no network and keeps only the items since a date, the daily schedule starts a run that answers in
 * the trigger's output schema, and the digest is saved only once the owner approves that one save.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { expect } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/trend.ts';
import surface from './surfaces/main.ts';
import run from './tools/news.run.ts';
import news from './tools/news.ts';

const signal = new AbortController().signal;
// The trigger file as `aw triggers create --file triggers/trend.json --agent <id>` reads it.
const TRIGGER = JSON.parse(
  readFileSync(new URL('triggers/trend.json', import.meta.url), 'utf8'),
) as object;

const SAVE = { file_path: '/workspace/trend-reports/2026-11-19.md', content: '# 2026-11-19' };
const ANSWER = {
  date: '2026-11-19',
  asOf: '2026-11-21',
  items: [
    {
      item: 'FIN-1118-04',
      topic: 'T-03',
      headline: '自治体が食品ロス削減の協力店を募集',
      publishedAt: '2026-11-18',
      says: 'ハマユウ市が食品ロス削減の協力店の募集を始めた。',
    },
  ],
  savedTo: SAVE.file_path,
};
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('trend', {
  definitions: { 'agents/trend.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the news tool answers from the dated snapshot since a date, with no network',
      run: async () => {
        expect(news).toMatchObject({ name: 'read_public_news' });
        expect(news).not.toHaveProperty('allowedDomains');

        const morning = await run({ since: '2026-11-20' }, { signal });
        expect(morning).toMatchObject({ mode: 'snapshot', asOf: '2026-11-21', truncated: false });
        expect(morning.records.map((record) => record.id)).toEqual([
          'SNS-1121-03',
          'FIN-1121-01',
          'PKJ-1120-02',
          'FFA-1120-01',
        ]);

        const waste = await run({ query: '食品ロス' }, { signal });
        expect(waste.records.map((record) => record.id)).toEqual(['SNS-1121-03', 'FIN-1118-04']);

        await expect(run({ query: 'x', forecast: true }, { signal })).rejects.toThrow();
      },
    },
    {
      name: 'the daily schedule starts a typed run, and its one save waits for approval',
      run: async ({ workspace }) => {
        const { aw, agentId, runs, fireSchedule } = workspace(
          async ({ native }) => {
            await native('Write', SAVE);
            return { text: 'ダイジェストを保存しました。', structured: ANSWER };
          },
          {},
          {},
          { requireApproval: gated },
        );
        const request = CreateTriggerRequestSchema.parse({ ...TRIGGER, agentId });
        const { outputSchema } = request;
        if (outputSchema === undefined) throw new Error('the trigger asks for no typed output');
        const { trigger } = await aw.triggers.create({ ...request, outputSchema });
        expect(trigger).toMatchObject({ cron: '0 9 * * *', timezone: 'Asia/Tokyo' });

        const paused = await aw.runs.waitForOutcome((await fireSchedule(trigger.id)).id);
        expect(paused.status).toBe('awaiting_approval');
        expect(runs[0]?.outputSchema).toMatchObject({
          required: ['date', 'asOf', 'items', 'savedTo'],
        });

        const { run: approved } = await aw.runs.approve(paused.id);
        expect((await aw.runs.result(approved.id)).output).toEqual(ANSWER);
        expect(runs[1]?.approvedToolCalls).toHaveLength(1);
      },
    },
  ],
});
