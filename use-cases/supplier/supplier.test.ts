/**
 * The contract, moment and flow tiers of `supplier` (a scheduled report, archetype RP). The flow
 * proves what the entry claims: the monthly schedule starts a run that answers in the trigger's
 * output schema, the report is saved only once the owner approves that one save, and the
 * continuation may make no other write. The typed report is what the surface charts (each
 * supplier's rate, and the all-supplier trend), and the suggested eval case asks for exactly the
 * trigger's schema.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/supplier.ts';
import surface from './surfaces/main.ts';

// The trigger file as `aw triggers create --file triggers/supplier.json --agent <id>` reads it.
const TRIGGER = JSON.parse(
  readFileSync(new URL('triggers/supplier.json', import.meta.url), 'utf8'),
) as { outputSchema: { properties: Record<string, unknown> } };

const SAVE = {
  file_path: '/workspace/supplier-reports/2026-11_supplier.md',
  content: '# 仕入先品質レポート 2026年11月',
};
const ANSWER = {
  month: '2026-11',
  suppliers: [
    {
      supplier: '株式会社ヒサメ樹脂',
      defectPpm: 610,
      status: 'watch',
      reasons: ['610 ppm（上限 500 ppm 超え）', '420 → 610', 'CL-031 対応中'],
      sources: ['受入検査_仕入先別_2026-06_2026-11.csv#2026-11 S-02', 'クレーム_2026.csv#CL-031'],
    },
  ],
  trend: [
    { month: '2026-10', defectPpm: 330 },
    { month: '2026-11', defectPpm: 366 },
  ],
  savedTo: SAVE.file_path,
};
// The gates are the agent definition's own, as the engine applies them.
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('supplier', {
  definitions: { 'agents/supplier.ts': agent, 'surfaces/main.ts': surface },
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
              (await native('Write', { ...SAVE, file_path: '/workspace/shared/supplier.md' })).text,
            );
            return { text: '11月の仕入先品質レポートを保存しました。', structured: ANSWER };
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
          required: ['month', 'suppliers', 'trend', 'savedTo'],
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

describe('supplier: the typed report', () => {
  it('asks its first suggested eval case for the trigger’s own schema, which holds the chart rows', () => {
    const text = readFileSync(new URL('evals/supplier.yaml', import.meta.url), 'utf8');
    const suggested = readEvalCaseFile(text, 'evals/supplier.yaml').cases.find((evalCase) =>
      evalCase.tags?.includes('suggested'),
    );
    expect(suggested?.outputSchema).toEqual(TRIGGER.outputSchema);
    const charted = surface.resultCharts?.map((chart) => chart.field);
    expect(charted).toEqual(['suppliers', 'trend']);
    for (const field of charted ?? [])
      expect(TRIGGER.outputSchema.properties).toHaveProperty(field);
  });
});
