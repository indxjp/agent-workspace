import { EvaluationResourceSchema } from '@indx-workspace/contracts/evaluations';
import { describe, expect, it } from 'vitest';

import type { InMemoryRunStore } from '../runs/memory-store';
import type { RunRecord } from '../runs/store';
import { captureLog } from '../telemetry/capture-log';
import { ORDER_CASE, setUp } from './handlers.test-support';

/** What a failing adapter's message carries: a key, and a URL with a password too short for any redaction pattern. */
const BAIT = 'sk-SENTINEL-bait-9f3c postgres://svc:hunter2@db.internal/aw';

/** Runs `fn` with the log captured, then restores it. */
async function withCapturedLog(fn: (log: ReturnType<typeof captureLog>) => Promise<void>) {
  const log = captureLog();
  try {
    await fn(log);
  } finally {
    log.restore();
  }
}

/** Neither secret in `BAIT` is in `text`. */
function expectNoBait(text: string) {
  expect(text).not.toContain('hunter2');
  expect(text).not.toContain('sk-SENTINEL');
}

describe('an evaluation stops every run it stops waiting for (SPD-05)', () => {
  const PLAN_CASE = {
    name: 'stops at the plan write',
    input: 'Plan the consolidation',
    expect: { tool: 'Write' },
  };
  const LIMITS = { maxBudgetUsd: 0.3 };
  /** An interrupt that takes a moment, so an answer that did not wait for it comes first. */
  const slowCancel = async (run: RunRecord, store: InMemoryRunStore) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await store.finish(run.id, 'cancelled', null, true);
  };
  const body = { version: 7, cases: [PLAN_CASE] };

  it('has stopped a run left at an approval by the time it answers', async () => {
    const { evaluate, interrupted, store } = setUp({ interrupt: slowCancel });
    const result = await evaluate(body);
    const runId = EvaluationResourceSchema.parse(result.body).results[0]?.runId ?? '';
    expect(interrupted).toEqual([runId]);
    expect((await store.get(runId))?.status).toBe('cancelled');
  });

  it('stops the run of a case whose stream cannot be opened, then fails as before', async () => {
    await withCapturedLog(async (log) => {
      const { evaluate, interrupted, store } = setUp({
        interrupt: slowCancel,
        streamError: { failure: new Error(BAIT), when: 'open' },
      });
      await expect(
        evaluate({ version: 7, cases: [{ ...PLAN_CASE, input: 'Never answers' }] }),
      ).rejects.toThrow();
      expect(interrupted).toHaveLength(1);
      expect((await store.get(interrupted[0] ?? ''))?.status).toBe('cancelled');
      expect(log.text()).not.toContain('hunter2');
    });
  });

  it('stops the run of a case whose stream failed while it was read, and logs no cause', async () => {
    await withCapturedLog(async (log) => {
      const { evaluate, interrupted, store } = setUp({
        interrupt: slowCancel,
        streamError: { failure: new Error(BAIT), when: 'read' },
      });
      const result = await evaluate({
        version: 7,
        cases: [{ ...PLAN_CASE, input: 'Never answers' }],
      });
      const evaluation = EvaluationResourceSchema.parse(result.body);
      expect(evaluation.results[0]?.failures).toEqual(['run_stream_failed']);
      expect(interrupted).toEqual([evaluation.results[0]?.runId]);
      expect((await store.get(interrupted[0] ?? ''))?.status).toBe('cancelled');
      expect(log.text()).toContain('reading run');
      expectNoBait(log.text());
    });
  });

  describe('under the Builder’s trial limits', () => {
    it.each([
      ['an interrupt that throws', { interrupt: () => Promise.reject(new Error(BAIT)) }],
      ['an interrupt that leaves the run going', { interrupt: () => Promise.resolve() }],
      ['a run API with no interrupt', { noInterrupt: true }],
    ] as const)('answers a typed refusal and stores nothing after %s', async (_label, stop) => {
      await withCapturedLog(async (log) => {
        const { evaluate, recorded } = setUp({ limits: LIMITS, ...stop });
        const result = await evaluate({
          version: 7,
          cases: [PLAN_CASE, { ...PLAN_CASE, name: 'second' }],
        });
        expect(result.status).toBe(409);
        expect(result.body).toMatchObject({ error: { code: 'trial_not_stopped' } });
        expect(JSON.stringify(result.body)).not.toContain('hunter2');
        expect(recorded).toEqual([]);
        expectNoBait(log.text());
      });
    });

    it('starts no further case once one could not be stopped', async () => {
      const { evaluate, limitsSeen } = setUp({
        limits: LIMITS,
        interrupt: () => Promise.reject(new Error(BAIT)),
      });
      await evaluate({ version: 7, cases: [PLAN_CASE, { ...PLAN_CASE, name: 'second' }] });
      expect(limitsSeen).toHaveLength(1);
    });
  });

  describe('without limits (the console route)', () => {
    it('still stores the row when the interrupt fails, and logs the failure by name only', async () => {
      await withCapturedLog(async (log) => {
        const { evaluate, recorded } = setUp({ interrupt: () => Promise.reject(new Error(BAIT)) });
        const result = await evaluate(body);
        expect(result.status).toBe(201);
        expect(recorded).toHaveLength(1);
        expect(log.text()).toContain('interrupting');
        expectNoBait(log.text());
      });
    });
  });

  it('logs a failing judge by name only', async () => {
    await withCapturedLog(async (log) => {
      const { evaluate } = setUp({ judge: () => Promise.reject(new Error(BAIT)) });
      await evaluate({
        version: 7,
        cases: [{ ...ORDER_CASE, expect: { ...ORDER_CASE.expect, judge: 'Polite' } }],
      });
      expect(log.text()).toContain('the judge call');
      expectNoBait(log.text());
    });
  });
});
