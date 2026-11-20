/**
 * Write-back (US-STO-12): the deadline, an interrupt and a cancelled run stop the save between files.
 */
// @story US-STO-12
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixedClock, type Clock } from '../clock';
import { STORAGE_WRITEBACK_STATUS_INTERVAL_MS } from './storage-writeback';
import { NOTHING, writeBack } from './storage-writeback.test-support';

afterEach(() => vi.restoreAllMocks());

/** The reason `AbortSignal.timeout` aborts with: what the launcher's deadline signal carries. */
const timedOut = () => new DOMException('the write-back deadline passed', 'TimeoutError');

describe('the write-back deadline', () => {
  it('[US-STO-12][unit][run] stops at the deadline on a store that never answers, counting the rest failed', async () => {
    // The deadline passes inside the first, hung write: no assertion depends on the clock.
    const deadline = new AbortController();
    const result = await writeBack({
      files: { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' },
      seams: { hangWrite: true, beforeWrite: () => deadline.abort(timedOut()) },
      signal: deadline.signal,
    });

    expect(result.attempts).toEqual(['reports/a.md']);
    expect(result.objects.size).toBe(0);
    expect(result.counts).toEqual({ ...NOTHING, failed: 3 });
    expect(result.labels()).toEqual([
      'run run-1 · 0 written · 0 unchanged · 0 conflicted · 0 refused · 3 failed · 0 bytes · refused: deadline',
    ]);
  });

  // #1835 (STO-509): a hung store SDK call is stopped by the store itself, not only abandoned.
  it('[US-STO-12][unit][run] passes its signal to the open, every read and every write', async () => {
    const deadline = new AbortController();
    const result = await writeBack({
      delivered: { 'a.md': 'old' },
      bucket: { 'reports/a.md': 'old' },
      files: { 'a.md': 'new', 'b.md': 'b' },
      signal: deadline.signal,
    });

    expect(result.counts).toMatchObject({ written: 2 });
    // One signal for the save: the run's deadline, or a cancel the stored status shows.
    const [saving] = result.openSignals;
    expect(saving).toBeInstanceOf(AbortSignal);
    expect(result.signals).toHaveLength(3);
    expect(result.signals.every((signal) => signal === saving)).toBe(true);
    deadline.abort(timedOut());
    expect(saving?.aborted).toBe(true);
  });

  it('[US-STO-12][unit][run] starts no grant once the deadline has passed', async () => {
    const controller = new AbortController();
    controller.abort(timedOut());
    const result = await writeBack({ files: { 'a.md': 'a' }, signal: controller.signal });

    expect(result.reads).toEqual([]);
    expect(result.labels()[0]).toContain('1 refused · 0 failed · 0 bytes · refused: deadline');
  });
});

describe('a run stopped while it is being saved', () => {
  it('[US-STO-12][unit][run] names an interrupt apart from the deadline', async () => {
    const interrupt = new AbortController();
    const result = await writeBack({
      files: { 'a.md': 'a', 'b.md': 'b' },
      seams: { hangWrite: true, beforeWrite: () => interrupt.abort() },
      signal: interrupt.signal,
    });

    expect(result.counts).toEqual({ ...NOTHING, failed: 2 });
    expect(result.labels()).toEqual([
      'run run-1 · 0 written · 0 unchanged · 0 conflicted · 0 refused · 2 failed · 0 bytes · refused: interrupted',
    ]);
  });

  it('[US-STO-12][unit][run] stops between files once the stored run is no longer running', async () => {
    // Another replica cancelled the run: only the stored status says so, not this signal. Each
    // file comes a status interval after the last, so each one asks the store again.
    let time = 0;
    const clock: Clock = { now: () => new Date((time += STORAGE_WRITEBACK_STATUS_INTERVAL_MS)) };
    let checks = 0;
    const result = await writeBack({
      clock,
      files: { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' },
      stillRunning: () => Promise.resolve((checks += 1) === 1),
    });

    expect(result.attempts).toEqual(['reports/a.md']);
    expect(result.counts).toEqual({ ...NOTHING, written: 1, failed: 2, bytes: 1 });
    expect(result.labels()).toEqual([
      'run run-1 · 1 written · 0 unchanged · 0 conflicted · 0 refused · 2 failed · 1 bytes · refused: interrupted',
    ]);
  });
});

describe('the stored status is asked when no clock is given', () => {
  it('[US-STO-12][unit][run] reads the current time for the status interval when no clock is given', async () => {
    // Pinned before the write-back took a Clock (refactoring plan part 07, step 7): a frozen time
    // asks once; a time an interval later asks again.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
      let checks = 0;
      const files = { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' };
      await writeBack({
        files,
        stillRunning: () => {
          checks += 1;
          vi.setSystemTime(Date.now() + STORAGE_WRITEBACK_STATUS_INTERVAL_MS);
          return Promise.resolve(true);
        },
      });
      expect(checks).toBe(3);

      let frozen = 0;
      await writeBack({
        files,
        stillRunning: () => {
          frozen += 1;
          return Promise.resolve(true);
        },
      });
      expect(frozen).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the stored status is asked at most once per interval', () => {
  it('[US-STO-12][unit][run] asks the stored status at most once per interval, first before any write', async () => {
    // A folder of many changed files must not cost one database read per file.
    const clock = fixedClock(new Date(1_000_000));
    let checks = 0;
    const files = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`f${String(index)}.md`, 'x']),
    );
    const result = await writeBack({
      clock,
      files,
      stillRunning: () => {
        checks += 1;
        return Promise.resolve(true);
      },
    });

    expect(result.counts).toMatchObject({ written: 20, failed: 0 });
    expect(checks).toBe(1);

    let stopped = 0;
    const cancelled = await writeBack({
      clock,
      files,
      stillRunning: () => {
        stopped += 1;
        return Promise.resolve(false);
      },
    });
    expect(cancelled.attempts).toEqual([]);
    expect(stopped).toBe(1);
  });
});
