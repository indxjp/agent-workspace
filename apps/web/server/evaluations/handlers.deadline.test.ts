import { EvaluationResourceSchema } from '@indx-workspace/contracts/evaluations';
import { describe, expect, it, vi } from 'vitest';

import {
  failuresOf,
  ORDER_CASE,
  ORDER_CASE_AGAIN,
  REFUND_CASE,
  settledAfter,
  setUp,
} from './handlers.test-support';

/** Runs `fn` with `Date`, `setTimeout` and `clearTimeout` faked, then restores real timers. */
async function withFakeTimers(fn: () => Promise<void>) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  try {
    await fn();
  } finally {
    vi.useRealTimers();
  }
}

describe('evaluateAgentVersion (issue #618)', () => {
  it('fails the running case and every later one at the deadline, and still stores the row', async () => {
    // Fake time: the start always lands before the deadline, so case 1 always reaches the wait.
    await withFakeTimers(async () => {
      const { evaluate, recorded, interrupted, store } = setUp({ deadlineMs: 50 });
      const pending = settledAfter(
        evaluate({
          version: 7,
          cases: [
            { name: 'slow', input: 'Never answers', expect: { contains: ['x'] } },
            ORDER_CASE,
          ],
        }),
      );
      await vi.advanceTimersByTimeAsync(50);
      const evaluation = EvaluationResourceSchema.parse((await pending.settled()).body);
      expect(evaluation.results.map((r) => [r.failures, r.runId === null])).toEqual([
        [['deadline_exceeded'], false],
        [['deadline_exceeded'], true],
      ]);
      expect(evaluation.score).toBe(0);
      expect(recorded).toHaveLength(1);
      // The abandoned run is stopped rather than left spending.
      await vi.waitFor(() => expect(interrupted).toEqual([evaluation.results[0]?.runId]));
      expect((await store.get(interrupted[0] ?? ''))?.status).toBe('cancelled');
    });
  });

  it('counts a slow session open against the deadline and interrupts the run it starts late', async () => {
    await withFakeTimers(async () => {
      const { evaluate, recorded, interrupted, store } = setUp({
        deadlineMs: 50,
        openSessionDelayMs: 150,
      });
      const pending = settledAfter(
        evaluate({
          version: 7,
          cases: [{ name: 'slow', input: 'Never answers', expect: { contains: ['x'] } }],
        }),
      );
      await vi.advanceTimersByTimeAsync(50);
      expect(
        EvaluationResourceSchema.parse((await pending.settled()).body).results[0],
      ).toMatchObject({ runId: null, failures: ['deadline_exceeded'] });
      expect(recorded).toHaveLength(1);
      // The response came before the session opened: nothing to interrupt yet.
      expect(interrupted).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(interrupted).toHaveLength(1));
      expect((await store.get(interrupted[0] ?? ''))?.status).toBe('cancelled');
    });
  });

  it('fails a judge cut off by the deadline with deadline_exceeded and still stores the row', async () => {
    await withFakeTimers(async () => {
      // Fake timers do not reach `AbortSignal.timeout`; route it through the faked `setTimeout`.
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => {
          controller.abort(new DOMException('timed out', 'TimeoutError'));
        }, ms);
        return controller.signal;
      });
      try {
        const { evaluate, recorded } = setUp({
          deadlineMs: 50,
          // The five parameters are `RunApiEnvironment['judgeEvaluationCase']`'s: the port fixes the arity.
          judge: (_principal, _agent, _versionId, _prompt, signal) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => {
                reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
              });
            }),
        });
        const pending = settledAfter(evaluate({ version: 7, cases: [REFUND_CASE] }));
        await vi.advanceTimersByTimeAsync(50);
        expect(failuresOf(await pending.settled())[0]).toEqual(['deadline_exceeded']);
        expect(recorded).toHaveLength(1);
      } finally {
        timeout.mockRestore();
      }
    });
  });

  it('fails only the case whose run stream cannot be read with run_stream_failed', async () => {
    const { evaluate, recorded, store } = setUp();
    let opened = 0;
    const openStream = store.openStream.bind(store);
    store.openStream = async (runId, after) => {
      if (++opened > 1) return openStream(runId, after);
      return {
        reset: null,
        events: {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('the event store read failed')),
          }),
        },
        close: () => undefined,
      };
    };
    const result = await evaluate({ version: 7, cases: [ORDER_CASE, ORDER_CASE_AGAIN] });
    expect(result.status).toBe(201);
    const evaluation = EvaluationResourceSchema.parse(result.body);
    expect(evaluation.results.map((r) => [r.failures, r.runId === null])).toEqual([
      [['run_stream_failed'], false],
      [[], false],
    ]);
    expect(evaluation).toMatchObject({ score: 0.5, passed: 1, total: 2 });
    expect(recorded).toHaveLength(1);
  });
});
