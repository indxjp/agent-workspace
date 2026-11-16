/**
 * The trigger driver's wiring (`triggers.ts`): the Agent Store demo sweep rides the same delivery
 * as the schedule pass, on the cron route where `CRON_SECRET` is set and on the timer otherwise.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installTestRunApi, resetTestRunApi } from '../../application-context-fixtures';
import { InMemoryRunStore } from '../../runs/memory-store';

import { getTriggerScheduleCron, resetTriggerScheduleCron } from '../../triggers/schedule-cron';
import { wireTriggers } from './triggers';

const SWEPT = {
  leaseHeld: false,
  throttled: false,
  workspacesDeleted: 2,
  workspacesFailed: 0,
  loginTokensDeleted: 0,
  admissionsDeleted: 0,
  guestUsersDeleted: 0,
  leadsDeleted: null,
};

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

function rootOver() {
  return {
    listWorkspaceIds: () => Promise.resolve([] as readonly string[]),
    tryAcquireMaintenanceLease: () => Promise.resolve({ release: () => Promise.resolve() }),
    agents: {},
    scopes: { forWorkspaceId: () => Promise.resolve(null) },
  } as unknown as Parameters<typeof wireTriggers>[0];
}

/** The schedule pass reads the run API; an empty one is enough, there are no workspaces to fire in. */
function installRunApi() {
  installTestRunApi({
    authenticate: () => Promise.resolve(null),
    findAgent: () => Promise.resolve(null),
    openSession: () => Promise.resolve(null),
    ownsRun: () => Promise.resolve(false),
    store: new InMemoryRunStore(),
    launch: () => undefined,
  });
}

afterEach(() => {
  resetTestRunApi();
  resetTriggerScheduleCron();
  vi.useRealTimers();
});

describe('wireTriggers and the demo sweep', () => {
  it('runs the demo sweep on each cron delivery where CRON_SECRET is set', async () => {
    installRunApi();
    const demoSweep = vi.fn(() => Promise.resolve(SWEPT));
    wireTriggers(rootOver(), null, {
      cronSecret: 'a-cron-secret',
      log,
      stopOnClose: () => undefined,
      demoSweep,
    });
    const result = await getTriggerScheduleCron()?.pass();
    expect(demoSweep).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ demo: SWEPT });
  });

  it('adds no demo sweep to the delivery where no demo is installed', async () => {
    installRunApi();
    wireTriggers(rootOver(), null, {
      cronSecret: 'a-cron-secret',
      log,
      stopOnClose: () => undefined,
    });
    expect(await getTriggerScheduleCron()?.pass()).not.toHaveProperty('demo');
  });

  it('wakes the demo sweep on a timer where there is no cron, and stops it on close', async () => {
    installRunApi();
    vi.useFakeTimers();
    const demoSweep = vi.fn(() => Promise.resolve(SWEPT));
    const stops: (() => void)[] = [];
    wireTriggers(rootOver(), null, {
      cronSecret: undefined,
      log,
      stopOnClose: (stop) => stops.push(stop),
      demoSweep,
    });
    expect(demoSweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(demoSweep).toHaveBeenCalledTimes(1);
    for (const stop of stops) stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(demoSweep).toHaveBeenCalledTimes(1);
  });

  it('logs a timer sweep that throws and keeps going', async () => {
    installRunApi();
    vi.useFakeTimers();
    const failure = new Error('down');
    const demoSweep = vi.fn(() => Promise.reject(failure));
    const stops: (() => void)[] = [];
    wireTriggers(rootOver(), null, {
      cronSecret: undefined,
      log,
      stopOnClose: (stop) => stops.push(stop),
      demoSweep,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(demoSweep).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith('[compose] demo sweep failed', { error: failure });
    for (const stop of stops) stop();
  });
});
