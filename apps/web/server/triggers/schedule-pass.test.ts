/**
 * The schedule pass (issue #1294, ADR-0144 D5): a due trigger starts one run; a trigger that is not
 * due, disabled or a webhook starts none; a backlog is one run; two concurrent passes are one run.
 * The repository is in memory and its claim is atomic like the unique index it stands for.
 */
import { FEATURE_IDS } from '@indx-workspace/contracts/features';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearFeatureSwitches, configureFeatureSwitches } from '../features/runtime';
import { runSchedulePass, startSchedulePassScheduler } from './schedule-pass';
import {
  add,
  env,
  log,
  NOW,
  pass,
  resetWorld,
  root,
  runtime,
  schedule,
  SLOT,
  world,
} from './schedule-pass.test-support';

beforeEach(resetWorld);

afterEach(() => {
  clearFeatureSwitches();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('runSchedulePass: firing', () => {
  it('fires a due trigger once, claims its slot and records the firing', async () => {
    const trigger = add(schedule());

    const result = await pass();

    expect(result).toEqual({ leaseHeld: false, workspaces: 1, fired: 1, skipped: 0, failed: 0 });
    expect(world.launches).toHaveLength(1);
    expect([...world.deliveries.keys()]).toEqual([`schedule:${SLOT}`]);
    expect(world.triggers.get(trigger.id)?.lastFiredAt).toEqual(NOW);
    expect(world.released).toBe(1);

    expect(await pass()).toMatchObject({ fired: 0, skipped: 0 });
    expect(world.launches).toHaveLength(1);
  });

  it('holds the maintenance lease for one pass of the one-minute interval', async () => {
    const leases: [string, number][] = [];
    const base = root();
    await runSchedulePass({
      root: {
        ...base,
        tryAcquireMaintenanceLease: (name, ttlMs) => {
          leases.push([name, ttlMs]);
          return base.tryAcquireMaintenanceLease(name, ttlMs);
        },
      },
      runtime: runtime(),
      runs: env,
      log,
    });
    expect(leases).toEqual([['trigger-schedule', 60_000]]);
  });

  it('prunes the lapsed deliveries of each workspace it sweeps', async () => {
    await pass();
    expect(world.pruned).toEqual([NOW]);
  });
});

describe('runSchedulePass: what the started run carries', () => {
  it('starts the run with the output schema the trigger carries, and none otherwise (ADR-0154)', async () => {
    const sheet = { type: 'object', properties: { plan: { type: 'string' } } };
    add(schedule({ name: 'typed', outputSchema: sheet }));
    expect(await pass()).toMatchObject({ fired: 1 });
    expect(world.launches[0]?.outputSchema).toEqual(sheet);

    world.launches = [];
    world.deliveries.clear();
    world.triggers.clear();
    add(schedule({ name: 'untyped' }));
    expect(await pass()).toMatchObject({ fired: 1 });
    expect(world.launches[0]).not.toHaveProperty('outputSchema');
  });

  it('starts the run with the subject the trigger carries, and none otherwise (ADR-0156)', async () => {
    add(schedule({ name: 'planned', subject: 'planner' }));
    expect(await pass()).toMatchObject({ fired: 1 });
    expect(world.launches[0]?.subject).toBe('planner');

    world.launches = [];
    world.deliveries.clear();
    world.triggers.clear();
    add(schedule({ name: 'anonymous' }));
    expect(await pass()).toMatchObject({ fired: 1 });
    expect(world.launches[0]).not.toHaveProperty('subject');
  });
});

describe('runSchedulePass: which triggers fire', () => {
  it('starts nothing for a trigger that is not due, disabled, or a webhook', async () => {
    add(schedule({ name: 'not-due', createdAt: new Date('2026-10-18T00:01:00Z') }));
    add(schedule({ name: 'off', enabled: false }));
    add(schedule({ name: 'hook', kind: 'webhook', cron: null, timezone: null, hasSecret: true }));

    expect(await pass()).toMatchObject({ workspaces: 1, fired: 0, skipped: 0, failed: 0 });
    expect(world.launches).toHaveLength(0);
    expect(world.deliveries.size).toBe(0);
  });

  it('fires a backlog of missed windows once and counts from the firing, not the slot', async () => {
    const trigger = add(schedule({ createdAt: new Date('2026-09-01T00:00:00Z') }));

    expect(await pass()).toMatchObject({ fired: 1 });
    expect(await pass()).toMatchObject({ fired: 0 });

    expect(world.launches).toHaveLength(1);
    expect(world.triggers.get(trigger.id)?.lastFiredAt).toEqual(NOW);
    world.clock = new Date('2026-10-19T00:00:30Z');
    expect(await pass()).toMatchObject({ fired: 1 });
    expect(world.launches).toHaveLength(2);
  });

  it('starts exactly one run when two passes run at the same time', async () => {
    add(schedule());

    const results = await Promise.all([pass(), pass()]);

    expect(world.launches).toHaveLength(1);
    expect(results.map((result) => result.fired).sort()).toEqual([0, 1]);
    expect(results.map((result) => result.skipped).sort()).toEqual([0, 1]);
    expect(world.deliveries.size).toBe(1);
  });
});

describe('runSchedulePass: a slot whose firing was not recorded', () => {
  it('moves past a slot whose run started but whose firing was not recorded', async () => {
    const trigger = add(schedule());
    world.markFiredFails = 1;

    expect(await pass()).toMatchObject({ fired: 0, failed: 1 });
    expect(world.launches).toHaveLength(1);
    expect(world.triggers.get(trigger.id)?.lastFiredAt).toBeNull();

    expect(await pass()).toMatchObject({ fired: 0, skipped: 1 });
    expect(world.triggers.get(trigger.id)?.lastFiredAt).toEqual(NOW);

    // The claim window has lapsed: the slot is not owed again.
    world.deliveries.clear();
    world.clock = new Date('2026-10-18T01:05:00Z');
    expect(await pass()).toMatchObject({ fired: 0, skipped: 0 });
    expect(world.launches).toHaveLength(1);

    world.clock = new Date('2026-10-19T00:00:30Z');
    expect(await pass()).toMatchObject({ fired: 1 });
    expect([...world.deliveries.keys()]).toEqual(['schedule:2026-10-19T00:00:00.000Z']);
  });

  it('does not mark a slot fired while its claim has no run, so a stuck claim is not skipped for good', async () => {
    const trigger = add(schedule());
    world.deliveries.set('schedule:2026-10-18T00:00:00.000Z', null);

    expect(await pass()).toMatchObject({ fired: 0, skipped: 1 });
    expect(world.launches).toHaveLength(0);
    expect(world.triggers.get(trigger.id)?.lastFiredAt).toBeNull();
  });
});

describe('runSchedulePass: refusals and failures', () => {
  it('does nothing while another replica holds the lease', async () => {
    add(schedule());
    world.leaseFree = false;

    expect(await pass()).toEqual({
      leaseHeld: true,
      workspaces: 0,
      fired: 0,
      skipped: 0,
      failed: 0,
    });
    expect(world.launches).toHaveLength(0);
  });

  it('starts nothing and holds no claim when the owner may no longer run the agent', async () => {
    const trigger = add(schedule());
    world.ownerGone = true;

    expect(await pass()).toMatchObject({ fired: 0, skipped: 1 });

    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      `[trigger-schedule] ${trigger.id} skipped: trigger_owner_not_allowed`,
    );
    expect(world.launches).toHaveLength(0);
    expect(world.deliveries.size).toBe(0);
    expect(world.triggers.get(trigger.id)?.lastFiredAt).toBeNull();
  });

  it('releases the claim at the concurrency limit so the next pass retries the slot', async () => {
    const trigger = add(schedule());
    world.unfinished = 3;

    expect(await pass()).toMatchObject({ fired: 0, skipped: 1 });
    expect(world.deliveries.size).toBe(0);
    expect(world.triggers.get(trigger.id)?.lastFiredAt).toBeNull();

    world.unfinished = 0;
    expect(await pass()).toMatchObject({ fired: 1, skipped: 0 });
    expect(world.launches).toHaveLength(1);
  });

  it('counts a trigger whose firing throws and still fires the others', async () => {
    add(schedule({ name: 'broken', cron: '61 * * * *' }));
    add(schedule({ name: 'fine' }));

    expect(await pass()).toMatchObject({ fired: 1, failed: 1 });
    expect(world.launches).toHaveLength(1);
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error.mock.calls[0]?.[0]).toMatch(/^\[trigger-schedule\] .+ failed$/);
  });

  it('releases the lease when the run API is not installed', async () => {
    await expect(
      runSchedulePass({ root: root(), runtime: runtime(), runs: () => null, log }),
    ).rejects.toThrow('run API');
    expect(world.released).toBe(1);
  });
});

describe('runSchedulePass and a workspace with triggers switched off (ADR-0160 D7)', () => {
  it('skips the workspace without reading its triggers, and is not refused', async () => {
    const trigger = add(schedule());
    configureFeatureSwitches({
      enabledFor: () => Promise.resolve(FEATURE_IDS.filter((id) => id !== 'triggers')),
    });

    const result = await pass();

    expect(result).toEqual({ leaseHeld: false, workspaces: 1, fired: 0, skipped: 0, failed: 0 });
    expect(world.launches).toHaveLength(0);
    expect(world.deliveries.size).toBe(0);
    expect(world.pruned).toEqual([]);
    expect(world.triggers.get(trigger.id)?.lastFiredAt).toBeNull();
    expect(world.released).toBe(1);
  });

  it('fires again once the switch is back on', async () => {
    add(schedule());
    configureFeatureSwitches({
      enabledFor: () => Promise.resolve(FEATURE_IDS.filter((id) => id !== 'triggers')),
    });
    await pass();
    clearFeatureSwitches();
    expect(await pass()).toMatchObject({ fired: 1 });
  });
});

describe('startSchedulePassScheduler', () => {
  it('passes on every interval and reports a failed pass', async () => {
    vi.useFakeTimers();
    add(schedule());
    const onError = vi.fn();

    const stop = startSchedulePassScheduler({
      root: root(),
      runtime: runtime(),
      runs: () => null,
      log,
      intervalMs: 60_000,
      onError,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onError).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onError).toHaveBeenCalledTimes(2);

    // A stopped scheduler passes no more (a failed boot stops it before closing the database).
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
