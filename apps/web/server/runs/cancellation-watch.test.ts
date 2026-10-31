import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log as webLogger } from '../telemetry/logger';
import { CANCELLATION_WATCH_INTERVAL_MS, watchRunForCancellation } from './cancellation-watch';
import type { RunStatus } from './store';

const RUN = '11111111-1111-4111-8111-111111111111';
const INTERVAL = 100;

describe('watchRunForCancellation (ADR-0151-FU-1440 D1, issue #261)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls every 2 s unless a test overrides it, as the ADR fixes', () => {
    expect(CANCELLATION_WATCH_INTERVAL_MS).toBe(2_000);
  });

  it('never calls back while the run reads `running`', async () => {
    const readStatus = vi.fn((): Promise<RunStatus | null> => Promise.resolve('running'));
    const onStopped = vi.fn();
    const stop = watchRunForCancellation({
      runId: RUN,
      readStatus,
      intervalMs: INTERVAL,
      onStopped,
    });
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(readStatus).toHaveBeenCalledTimes(5);
    expect(onStopped).not.toHaveBeenCalled();
    stop();
  });

  it('calls onStopped exactly once, within one interval of the run reading `cancelled`', async () => {
    let status: RunStatus = 'running';
    const readStatus = vi.fn(() => Promise.resolve(status));
    const onStopped = vi.fn();
    watchRunForCancellation({ runId: RUN, readStatus, intervalMs: INTERVAL, onStopped });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    status = 'cancelled';
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(onStopped).toHaveBeenCalledTimes(1);
    // It stopped itself: no further read and no second callback.
    const reads = readStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(readStatus).toHaveBeenCalledTimes(reads);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it.each<RunStatus>(['failed', 'completed', 'awaiting_approval'])(
    'treats `%s` as stopped too',
    async (stopped) => {
      const onStopped = vi.fn();
      watchRunForCancellation({
        runId: RUN,
        readStatus: () => Promise.resolve(stopped),
        intervalMs: INTERVAL,
        onStopped,
      });
      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(onStopped).toHaveBeenCalledTimes(1);
    },
  );

  it('counts a missing run as stopped', async () => {
    const onStopped = vi.fn();
    watchRunForCancellation({
      runId: RUN,
      readStatus: () => Promise.resolve(null),
      intervalMs: INTERVAL,
      onStopped,
    });
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it('reports a read that throws and keeps polling', async () => {
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const readStatus = vi.fn((): Promise<RunStatus | null> => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('the database is unavailable'))
        : Promise.resolve('cancelled');
    });
    const onStopped = vi.fn();
    watchRunForCancellation({ runId: RUN, readStatus, intervalMs: INTERVAL, onStopped });
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(onStopped).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it('never overlaps itself: a tick still waiting on the store skips the next one', async () => {
    let release: (status: RunStatus) => void = () => undefined;
    const readStatus = vi.fn(
      () =>
        new Promise<RunStatus>((resolve) => {
          release = resolve;
        }),
    );
    const onStopped = vi.fn();
    watchRunForCancellation({ runId: RUN, readStatus, intervalMs: INTERVAL, onStopped });
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(readStatus).toHaveBeenCalledTimes(1);
    release('cancelled');
    await vi.advanceTimersByTimeAsync(0);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it('stop() prevents any further read, is idempotent, and drops a read already in flight', async () => {
    let release: (status: RunStatus) => void = () => undefined;
    const readStatus = vi.fn(
      () =>
        new Promise<RunStatus>((resolve) => {
          release = resolve;
        }),
    );
    const onStopped = vi.fn();
    const stop = watchRunForCancellation({
      runId: RUN,
      readStatus,
      intervalMs: INTERVAL,
      onStopped,
    });
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(readStatus).toHaveBeenCalledTimes(1);
    // The launch is about to write its own terminal status: a read that lands after it must not
    // be taken for someone else's stop.
    stop();
    stop();
    release('completed');
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(onStopped).not.toHaveBeenCalled();
  });

  it("runs on an unref'd timer, so a live watch never holds the process open", () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const stop = watchRunForCancellation({
      runId: RUN,
      readStatus: () => Promise.resolve('running'),
      intervalMs: INTERVAL,
      onStopped: () => undefined,
    });
    const timer = setIntervalSpy.mock.results[0]?.value as { hasRef(): boolean };
    expect(timer.hasRef()).toBe(false);
    stop();
  });
});
