import { fetchDouble, jsonResponse } from '@indx-workspace/sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DashboardSnapshot } from '../dashboard-wire.js';
import { ResourceProblemError } from './client.js';
import { dashboardClient, pollWhileVisible, type VisibilitySource } from './dashboard-client.js';

const snapshot: DashboardSnapshot = {
  running: [],
  waiting: [],
  failed: [],
  spendToday: [],
  asOf: '2026-11-01T12:00:00.000Z',
  truncated: { running: false, waiting: false, failed: false, spend: false },
};

/** A page whose visibility a test turns. */
function page(): VisibilitySource & { show(): void; hide(): void } {
  let state: DocumentVisibilityState = 'visible';
  const listeners = new Set<() => void>();
  return {
    get visibilityState() {
      return state;
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    show() {
      state = 'visible';
      for (const listener of listeners) listener();
    },
    hide() {
      state = 'hidden';
      for (const listener of listeners) listener();
    },
  };
}

describe('dashboardClient', () => {
  it('reads the snapshot from /api/dashboard on the page’s origin', async () => {
    const double = fetchDouble(() => jsonResponse(200, snapshot));
    await expect(
      dashboardClient({ fetch: double.fetch, baseUrl: 'https://app.test/' }).get(),
    ).resolves.toEqual(snapshot);
    expect(double.calls[0]?.url.href).toBe('https://app.test/api/dashboard');
  });

  it('fails with the route’s code, or says why the answer is not one', async () => {
    const refused = fetchDouble(() =>
      jsonResponse(401, { error: { code: 'unauthenticated', message: 'Sign in.' } }),
    );
    const error = await dashboardClient({ fetch: refused.fetch, baseUrl: 'https://app.test' })
      .get()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResourceProblemError);
    expect(error).toMatchObject({ code: 'unauthenticated', status: 401 });

    const wrong = fetchDouble(() => jsonResponse(200, { running: 'nope' }));
    await expect(
      dashboardClient({ fetch: wrong.fetch, baseUrl: 'https://app.test' }).get(),
    ).rejects.toMatchObject({ code: 'contract_violation' });

    const down = dashboardClient({
      fetch: () => Promise.reject(new TypeError('offline')),
      baseUrl: 'https://app.test',
    });
    await expect(down.get()).rejects.toMatchObject({ code: 'transport_failed', status: 0 });
  });
});

describe('pollWhileVisible', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks every interval after the last tick settled, never two at once', async () => {
    const visibility = page();
    const settle: (() => void)[] = [];
    const signals: AbortSignal[] = [];
    const tick = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signals.push(signal);
          settle.push(resolve);
        }),
    );
    const stop = pollWhileVisible({ tick, intervalMs: 1000, visibility });

    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(1); // the first tick has not settled
    settle[0]?.();
    await vi.advanceTimersByTimeAsync(999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(signals[1]).not.toBe(signals[0]);

    stop();
    expect(signals[1]?.aborted).toBe(true);
    settle[1]?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('pauses while hidden, aborting the tick in flight, and ticks at once when shown', async () => {
    const visibility = page();
    const signals: AbortSignal[] = [];
    const tick = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve();
        });
      });
    });
    const stop = pollWhileVisible({ tick, intervalMs: 1000, visibility });
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    visibility.hide();
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);

    visibility.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it('keeps ticking after a tick fails, and waits for the first delay', async () => {
    const visibility = page();
    const tick = vi.fn(() => Promise.reject(new Error('down')));
    const stop = pollWhileVisible({ tick, intervalMs: 1000, firstDelayMs: 1000, visibility });
    await vi.advanceTimersByTimeAsync(999);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });
});
