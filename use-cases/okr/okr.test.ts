/**
 * The contract, moment and flow tiers of `okr` (a scheduled report, archetype RP). The flow proves
 * what the entry claims: the Monday schedule starts a run that answers in the trigger's output
 * schema, the report is saved only once the owner approves that one save, and the continuation may
 * make no other write. The typed report is what the surface charts (each key result's progress),
 * and the suggested eval case asks for exactly the trigger's schema.
 */
import { readFileSync } from 'node:fs';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/okr.ts';
import surface from './surfaces/main.ts';

// The trigger file as `aw triggers create --file triggers/okr.json --agent <id>` reads it.
const TRIGGER = JSON.parse(readFileSync(new URL('triggers/okr.json', import.meta.url), 'utf8')) as {
  outputSchema: { properties: Record<string, unknown> };
};

const SAVE = {
  file_path: '/workspace/okr-reports/2026-11-20_okr.md',
  content: '# OKR進捗レポート（2026-11-20 のチェックイン）',
};
const ANSWER = {
  asOf: '2026-11-20',
  keyResults: [
    {
      kr: 'KR-102',
      objective: '新しいお客様にすぐ価値を届ける',
      team: 'カスタマーサクセス',
      progress: 32,
      expected: 55,
      status: 'behind',
      note: '大口の2社の完了が12月にずれ込む見込み',
      sources: ['チェックイン_2026-11-20.csv#KR-102'],
    },
  ],
  savedTo: SAVE.file_path,
};
// The gates are the agent definition's own, as the engine applies them.
const gated =
  typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;

describeUseCase('okr', {
  definitions: { 'agents/okr.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the Monday schedule starts a typed run, and its one save waits for approval',
      run: async ({ workspace }) => {
        const extra: string[] = [];
        const { aw, agentId, runs, fireSchedule } = workspace(
          async ({ native }) => {
            await native('Write', SAVE);
            // Any other write after the approved one is refused, never paused or made.
            extra.push(
              (await native('Write', { ...SAVE, file_path: '/workspace/shared/okr.md' })).text,
            );
            return { text: 'OKR進捗レポートを保存しました。', structured: ANSWER };
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
          required: ['asOf', 'keyResults', 'savedTo'],
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

describe('okr: the typed report', () => {
  it('asks its first suggested eval case for the trigger’s own schema, which holds the chart rows', () => {
    const text = readFileSync(new URL('evals/okr.yaml', import.meta.url), 'utf8');
    const suggested = readEvalCaseFile(text, 'evals/okr.yaml').cases.find((evalCase) =>
      evalCase.tags?.includes('suggested'),
    );
    expect(suggested?.outputSchema).toEqual(TRIGGER.outputSchema);
    expect(surface.resultCharts?.map((chart) => chart.field)).toEqual(['keyResults']);
    expect(Object.keys(TRIGGER.outputSchema.properties)).toContain('keyResults');
  });

  it('has no field that rates, ranks or compares a person', () => {
    const fields = [...JSON.stringify(TRIGGER).matchAll(/"([A-Za-z]+)":/g)].map(([, name]) => name);
    for (const field of fields) expect(field).not.toMatch(/score|rank|rating|grade|evaluation/i);
  });
});
