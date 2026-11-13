/**
 * The launcher reads the time and the backoff jitter through its options (refactoring plan part 09,
 * step 4), so a test can decide a run's capacity wait and deadlines without waiting for them.
 */
import { parseRunFailure, RUNTIME_CAPACITY_EXHAUSTED } from '@indx-workspace/contracts/runs';
import { describe, expect, it } from 'vitest';

import { fixedClock } from '../clock';
import { createRunnerLauncher } from './launcher';
import { hostBudgetLeft, writeBackDeadlineMs } from './launcher-deadlines';
import { InMemoryRunStore } from './memory-store';
import {
  buildRunRequest,
  context,
  newRun,
  RUN_DONE,
  settle,
  silenceErrorLog,
  sse,
} from './launcher.test-support';

const CAPACITY_BODY = {
  error: 'runner_capacity_exhausted',
  message: 'the runner is already serving 8 runs; retry when capacity is available.',
};
const START = '2026-11-13T00:00:00.000Z';

describe('the launcher on an injected clock (part 09 step 4)', () => {
  it('gives up the capacity wait when the clock passes maxWaitMs, however fast the posts are', async () => {
    const log = silenceErrorLog();
    const clock = fixedClock(START);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    let posts = 0;
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      clock,
      // Zero jitter: no real time passes between posts, only the injected clock moves.
      random: () => 0,
      capacityRetry: { initialDelayMs: 1, maxDelayMs: 1, maxWaitMs: 60_000 },
      fetch: () => {
        posts += 1;
        clock.advance(25_000);
        return Promise.resolve(Response.json(CAPACITY_BODY, { status: 429 }));
      },
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(parseRunFailure(settled.error)?.code).toBe(RUNTIME_CAPACITY_EXHAUSTED);
    // 25 s, 50 s and 75 s on the injected clock: the third refusal is past the 60 s budget.
    expect(posts).toBe(3);
    log.mockRestore();
  });

  it('keeps waiting while the injected clock is inside maxWaitMs', async () => {
    const clock = fixedClock(START);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    let posts = 0;
    let jitters = 0;
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      clock,
      random: () => {
        jitters += 1;
        return 0;
      },
      capacityRetry: { initialDelayMs: 1, maxDelayMs: 1, maxWaitMs: 60_000 },
      fetch: () => {
        posts += 1;
        clock.advance(10_000);
        return Promise.resolve(
          posts <= 4
            ? Response.json(CAPACITY_BODY, { status: 429 })
            : sse(`event: assistant\ndata: {"text":"hi"}\n\n${RUN_DONE}`),
        );
      },
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('completed');
    expect(posts).toBe(5);
    // Each of the 4 refusals drew its backoff jitter from the injected source.
    expect(jitters).toBe(4);
  });

  it('measures the host limit and the reported duration on the same clock as the start', async () => {
    // Far from the real time: a start read from the real clock would look years old.
    const clock = fixedClock('2030-01-01T00:00:00.000Z');
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const durations: number[] = [];
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      clock,
      hostMaxRunDurationMs: 60_000,
      onRunFinished: (finished) => durations.push(finished.durationMs),
      fetch: () => {
        clock.advance(5_000);
        return Promise.resolve(sse(`event: assistant\ndata: {"text":"hi"}\n\n${RUN_DONE}`));
      },
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('completed');
    expect(durations).toEqual([5_000]);
  });
});

describe('the host limit on an injected clock', () => {
  it('refuses a run whose preparation used the host limit on the injected clock', async () => {
    const log = silenceErrorLog();
    const clock = fixedClock('2030-01-01T00:00:00.000Z');
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    let posts = 0;
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      clock,
      hostMaxRunDurationMs: 60_000,
      // Preparation takes 61 s on the injected clock and no real time at all.
      buildRunRequest: () => {
        clock.advance(61_000);
        return buildRunRequest();
      },
      fetch: () => {
        posts += 1;
        return Promise.resolve(sse(RUN_DONE));
      },
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(parseRunFailure(settled.error)?.code).toBe('run_deadline_exceeds_host');
    expect(posts).toBe(0);
    log.mockRestore();
  });
});

describe('the run deadlines read the time they are given', () => {
  it('hostBudgetLeft is what the host limit leaves at `now`, and refuses when nothing is left', () => {
    expect(hostBudgetLeft(null, 0, 10_000)).toBeNull();
    expect(hostBudgetLeft(60_000, 1_000, 21_000)).toBe(40_000);
    expect(() => hostBudgetLeft(60_000, 1_000, 61_000)).toThrow(/used the whole 60s/);
  });

  it('writeBackDeadlineMs cuts the write-back to the host and stale-run limits left at `now`', () => {
    // No host or stale limit: the write-back's own deadline.
    expect(writeBackDeadlineMs(30_000, null, 0, null, null, 999_999)).toBe(30_000);
    // The host limit leaves 100 s at `now`, less the 10 s margin.
    expect(writeBackDeadlineMs(300_000, 600_000, 0, null, null, 500_000)).toBe(90_000);
    // The stale-run threshold, measured from the stored start, leaves less.
    expect(writeBackDeadlineMs(300_000, null, 0, 600_000, new Date(100_000), 650_000)).toBe(40_000);
    // Never negative.
    expect(writeBackDeadlineMs(300_000, 600_000, 0, null, null, 700_000)).toBe(0);
  });
});
