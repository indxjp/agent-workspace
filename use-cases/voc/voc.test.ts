/**
 * The contract, moment and flow tiers of `voc` (a scheduled report, archetype RP). The flow proves
 * what the entry claims: the monthly schedule starts a run that answers in the trigger's output
 * schema, the report is saved only once the owner approves that one save, and the continuation may
 * make no other write. The rule that customers' contact details stay out: the trigger's schema has
 * no field for a name, an email address or a phone number, and items are named by id.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/voc.ts';
import surface from './surfaces/main.ts';

// The trigger file as `aw triggers create --file triggers/voc.json --agent <id>` reads it.
const TRIGGER = JSON.parse(readFileSync(new URL('triggers/voc.json', import.meta.url), 'utf8')) as {
  outputSchema: object;
};

const SAVE = {
  file_path: '/workspace/voc-reports/2026-10_voc.md',
  content: '# お客様の声 2026年10月',
};
const ANSWER = {
  month: '2026-10',
  themes: [
    {
      theme: '電気ケトル KT-20 の注ぎ口からの水漏れ',
      kind: 'issue',
      summary: '注ぐときや満水時に注ぎ口から水が垂れる・にじむ。',
      improvement: '注ぎ口のパッキンと形状を確認する。',
      items: ['Q-1002', 'Q-1007', 'R-2001', 'R-2005'],
    },
  ],
  other: ['Q-1004', 'R-2007'],
  savedTo: SAVE.file_path,
};
// The gates are the agent definition's own, as the engine applies them.
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('voc', {
  definitions: { 'agents/voc.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the monthly schedule starts a typed run, and its one save waits for approval',
      run: async ({ workspace }) => {
        const extra: string[] = [];
        const { aw, agentId, runs, fireSchedule } = workspace(
          async ({ native }) => {
            await native('Write', SAVE);
            // Any other write after the approved one is refused, never paused or made.
            extra.push(
              (await native('Write', { ...SAVE, file_path: '/workspace/shared/voc.md' })).text,
            );
            return { text: '10月のお客様の声レポートを保存しました。', structured: ANSWER };
          },
          {},
          {},
          { requireApproval: gated },
        );
        const request = CreateTriggerRequestSchema.parse({ ...TRIGGER, agentId });
        const { outputSchema } = request;
        if (outputSchema === undefined) throw new Error('the trigger asks for no typed output');
        const { trigger: created } = await aw.triggers.create({ ...request, outputSchema });
        // The first of each month at 09:00 in Tokyo, 00:00 UTC: the date agrees on the runtime.
        expect(created).toMatchObject({
          kind: 'schedule',
          cron: '0 9 1 * *',
          timezone: 'Asia/Tokyo',
        });

        const paused = await aw.runs.waitForOutcome((await fireSchedule(created.id)).id);
        expect(paused.status).toBe('awaiting_approval');
        expect(runs[0]?.prompt).toBe(request.prompt);
        expect(runs[0]?.outputSchema).toMatchObject({
          required: ['month', 'themes', 'other', 'savedTo'],
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

describe('voc: contact details stay out', () => {
  it('asks for typed output with no field for a name, an email address or a phone number', () => {
    const fields = [...JSON.stringify(TRIGGER.outputSchema).matchAll(/"([A-Za-z]+)":/g)].map(
      ([, name]) => name,
    );
    expect(fields).toContain('items');
    for (const field of fields) {
      expect(field).not.toMatch(/name|mail|phone|customer|reviewer|contact/i);
    }
  });
});
