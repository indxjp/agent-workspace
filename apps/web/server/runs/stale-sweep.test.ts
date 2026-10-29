import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../clock';
import { startStaleRunSweeper, type StaleRunSweepDependencies } from './stale-sweep';

const NOW = '2026-10-27T09:00:00.000Z';
const STALE_AFTER_MS = 60 * 60_000;
const INTERVAL_MS = 60_000;

type Lease = StaleRunSweepDependencies['lease'];

function sweeper({
  leaseHeld = true,
  finish = vi.fn<StaleRunSweepDependencies['finish']>(() => Promise.resolve()),
}: {
  readonly leaseHeld?: boolean;
  readonly finish?: ReturnType<typeof vi.fn<StaleRunSweepDependencies['finish']>>;
} = {}) {
  const release = vi.fn(() => Promise.resolve());
  const tryAcquire = vi.fn<Lease['tryAcquire']>(() =>
    Promise.resolve(leaseHeld ? { release } : null),
  );
  const listStaleRunIds = vi.fn<StaleRunSweepDependencies['listStaleRunIds']>(() =>
    Promise.resolve(['run-1', 'run-2']),
  );
  const onError = vi.fn<(error: unknown) => void>();
  const stop = startStaleRunSweeper({
    lease: { tryAcquire },
    listStaleRunIds,
    finish,
    staleAfterMs: STALE_AFTER_MS,
    clock: fixedClock(NOW),
    intervalMs: INTERVAL_MS,
    onError,
  });
  return { tryAcquire, release, listStaleRunIds, finish, onError, stop };
}

describe('startStaleRunSweeper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails every run older than the threshold, measured from the clock', async () => {
    const sweep = sweeper();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    sweep.stop();

    expect(sweep.listStaleRunIds).toHaveBeenCalledTimes(1);
    expect(sweep.listStaleRunIds.mock.calls[0]?.[0].toISOString()).toBe('2026-10-27T08:00:00.000Z');
    expect(sweep.finish).toHaveBeenCalledTimes(2);
    expect(sweep.finish).toHaveBeenCalledWith('run-1', 'failed', expect.any(String), true);
    expect(sweep.finish).toHaveBeenCalledWith('run-2', 'failed', expect.any(String), true);
    expect(sweep.release).toHaveBeenCalledTimes(1);
    expect(sweep.onError).not.toHaveBeenCalled();
  });

  it('does nothing when another replica holds the lease', async () => {
    const sweep = sweeper({ leaseHeld: false });
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    sweep.stop();

    expect(sweep.listStaleRunIds).not.toHaveBeenCalled();
    expect(sweep.finish).not.toHaveBeenCalled();
  });

  it('releases the lease and reports the error when finishing a run fails', async () => {
    const failure = new Error('database down');
    const sweep = sweeper({
      finish: vi.fn<StaleRunSweepDependencies['finish']>(() => Promise.reject(failure)),
    });
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    sweep.stop();

    expect(sweep.release).toHaveBeenCalledTimes(1);
    expect(sweep.onError).toHaveBeenCalledWith(failure);
  });

  it('stops sweeping once stopped', async () => {
    const sweep = sweeper();
    sweep.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(sweep.tryAcquire).not.toHaveBeenCalled();
  });
});
