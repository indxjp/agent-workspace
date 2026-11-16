import { EvaluationResourceSchema } from '@indx-workspace/contracts/evaluations';
import { describe, expect, it, vi } from 'vitest';

import type { InMemoryRunStore } from '../runs/memory-store';
import { DRAFT_CASE, failuresOf, judgeSays, ORDER_CASE, setUp } from './handlers.test-support';

/** `runId` is cancelled in `store`, and it is the only run interrupted. */
async function expectCancelled(
  store: InMemoryRunStore,
  interrupted: readonly string[],
  runId: string,
) {
  await vi.waitFor(async () => {
    expect((await store.get(runId))?.status).toBe('cancelled');
  });
  expect(interrupted).toEqual([runId]);
}

describe('evaluateAgentVersion (issue #618)', () => {
  describe('a case that expects the approval pause (issue #1569)', () => {
    const PLAN_CASE = {
      name: 'stops at the plan write',
      input: 'Plan the consolidation',
      expect: {
        awaitsApproval: true,
        tool: 'Write',
        toolInput: { file_path: 'outputs/plan.json' },
        contains: ['Plan ready'],
      },
    };

    it('passes when the run pauses on the expected call, and the run is cancelled', async () => {
      const { evaluate, interrupted, store } = setUp();
      const result = await evaluate({ version: 7, cases: [PLAN_CASE] });
      const evaluation = EvaluationResourceSchema.parse(result.body);
      expect(evaluation.results.map((r) => [r.name, r.passed, r.failures])).toEqual([
        [PLAN_CASE.name, true, []],
      ]);
      const runId = evaluation.results[0]?.runId ?? '';
      expect(runId).not.toBe('');
      await expectCancelled(store, interrupted, runId);
    });

    it('scores the paused call: a different tool or input fails its case, and the run is still cancelled', async () => {
      const { evaluate, interrupted } = setUp();
      const result = await evaluate({
        version: 7,
        cases: [
          { ...PLAN_CASE, name: 'other tool', expect: { awaitsApproval: true, tool: 'Edit' } },
          {
            ...PLAN_CASE,
            name: 'other path',
            expect: {
              awaitsApproval: true,
              tool: 'Write',
              toolInput: { file_path: 'outputs/other.json' },
            },
          },
          { ...PLAN_CASE, name: 'wrong text', expect: { awaitsApproval: true, contains: ['zzz'] } },
        ],
      });
      expect(failuresOf(result)).toEqual([
        ['tool: Edit was not called'],
        ['toolInput: no call of Write had {"file_path":"outputs/other.json"}'],
        ['contains: "zzz" is not in the answer'],
      ]);
      await vi.waitFor(() => {
        expect(interrupted).toHaveLength(3);
      });
    });

    it('reads the answer so far for the judge', async () => {
      const prompts: string[] = [];
      const { evaluate } = setUp({
        judge: (_principal, _agent, _version, prompt) => {
          prompts.push(prompt);
          return judgeSays('{"pass": true, "reason": "ok"}');
        },
      });
      const result = await evaluate({
        version: 7,
        cases: [
          {
            ...PLAN_CASE,
            expect: { awaitsApproval: true, judge: 'Stops before writing anything' },
          },
        ],
      });
      expect(failuresOf(result)[0]).toEqual([]);
      expect(prompts[0]).toContain('Plan ready for approval.');
    });

    it('fails with run_not_awaiting_approval when the run completes', async () => {
      const { evaluate, interrupted } = setUp();
      const result = await evaluate({
        version: 7,
        cases: [{ ...ORDER_CASE, expect: { ...ORDER_CASE.expect, awaitsApproval: true } }],
      });
      const evaluation = EvaluationResourceSchema.parse(result.body);
      expect(evaluation.results.map((r) => [r.passed, r.failures])).toEqual([
        [false, ['run_not_awaiting_approval']],
      ]);
      expect(interrupted).toEqual([]);
    });

    it('fails with run_awaiting_approval without the flag, and still interrupts the run', async () => {
      const { evaluate, interrupted, store } = setUp();
      const result = await evaluate({
        version: 7,
        cases: [{ ...PLAN_CASE, expect: { tool: 'Write' } }],
      });
      const evaluation = EvaluationResourceSchema.parse(result.body);
      expect(evaluation.results.map((r) => [r.passed, r.failures])).toEqual([
        [false, ['run_awaiting_approval']],
      ]);
      await expectCancelled(store, interrupted, evaluation.results[0]?.runId ?? '');
    });

    it('refuses awaitsApproval together with output as invalid_body', async () => {
      const { evaluate, recorded } = setUp();
      const result = await evaluate({
        version: 7,
        cases: [{ ...DRAFT_CASE, expect: { awaitsApproval: true, output: { width: 140 } } }],
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: 'invalid_body' } });
      expect(recorded).toEqual([]);
    });
  });
});
