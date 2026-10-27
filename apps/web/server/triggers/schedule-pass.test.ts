/**
 * The schedule pass (issue #1294, ADR-0144 D5): a due trigger starts one run; a trigger that is not
 * due, disabled or a webhook starts none; a backlog is one run; two concurrent passes are one run.
 * The repository is in memory and its claim is atomic like the unique index it stands for.
 */
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Principal } from '../rbac/principal';
import { TEST_WORKSPACE_ID } from '../rbac/testing';
import type { LaunchContext, RunApiEnvironment } from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import type { TriggerRecord, TriggersRuntime } from './runtime';
import { runSchedulePass, startSchedulePassScheduler, type ScheduleRoot } from './schedule-pass';

const AGENT = randomUUID();
const OWNER = randomUUID();
const NOW = new Date('2026-10-18T00:05:00Z');
// 09:00 every day in Tokyo is 00:00Z, so the slot of NOW is 2026-10-18T00:00:00Z.
const SLOT = '2026-10-18T00:00:00.000Z';

let triggers: Map<string, TriggerRecord>;
let deliveries: Map<string, string | null>;
let launches: LaunchContext[];
let ownerGone: boolean;
let unfinished: number;
let leaseFree: boolean;
let released: number;
let markFiredFails: number;
let pruned: Date[];
let clock: Date;

const schedule = (overrides: Partial<TriggerRecord> = {}): TriggerRecord => ({
  id: randomUUID(),
  workspaceId: TEST_WORKSPACE_ID,
  agentId: AGENT,
  name: 'monthly',
  kind: 'schedule',
  promptTemplate: 'consolidate {{body}}',
  cron: '0 9 * * *',
  timezone: 'Asia/Tokyo',
  enabled: true,
  outputSchema: null,
  subject: null,
  ownerPrincipalId: OWNER,
  hasSecret: false,
  lastFiredAt: null,
  scheduleFrom: null,
  createdAt: new Date('2026-10-17T00:00:00Z'),
  updatedAt: new Date('2026-10-17T00:00:00Z'),
  ...overrides,
});

const add = (trigger: TriggerRecord): TriggerRecord => {
  triggers.set(trigger.id, trigger);
  return trigger;
};

const runtime = (): TriggersRuntime => ({
  repository: () =>
    Promise.resolve({
      list: () => Promise.resolve([...triggers.values()]),
      get: (id) => Promise.resolve(triggers.get(id) ?? null),
      create: () => Promise.reject(new Error('not used')),
      update: () => Promise.reject(new Error('not used')),
      setSecretHash: () => Promise.reject(new Error('not used')),
      remove: () => Promise.reject(new Error('not used')),
      countDeliveriesSince: () => Promise.resolve(deliveries.size),
      countUnfinishedRuns: () => Promise.resolve(unfinished),
      markFired: (id, at) => {
        if (markFiredFails > 0) {
          markFiredFails -= 1;
          return Promise.reject(new Error('database unavailable'));
        }
        const row = triggers.get(id);
        if (row === undefined) return Promise.resolve(false);
        triggers.set(id, { ...row, lastFiredAt: at });
        return Promise.resolve(true);
      },
      claimDelivery: (_triggerId, key) => {
        if (deliveries.has(key)) {
          return Promise.resolve({ kind: 'duplicate', runId: deliveries.get(key) ?? null });
        }
        deliveries.set(key, null);
        return Promise.resolve({ kind: 'claimed' });
      },
      recordDeliveryRun: (_triggerId, key, runId) => {
        deliveries.set(key, runId);
        return Promise.resolve(true);
      },
      releaseDelivery: (_triggerId, key) => Promise.resolve(deliveries.delete(key)),
      pruneDeliveries: (now) => {
        pruned.push(now);
        return Promise.resolve(0);
      },
    }),
  findForIngress: () => Promise.resolve(null),
  owner: (workspaceId, principalId) =>
    Promise.resolve(
      ownerGone
        ? null
        : Principal.fromDirectoryRecord({
            principalId,
            kind: 'membership',
            workspaceId,
            role: 'builder',
            label: 'Builder',
            userId: randomUUID(),
            apiKeyId: null,
            actsForPrincipalId: null,
          }),
    ),
  agentOwnership: () => Promise.resolve('own'),
  zoomTokens: null,
  now: () => clock,
});

const root = (): ScheduleRoot => ({
  listWorkspaceIds: () => Promise.resolve([TEST_WORKSPACE_ID]),
  tryAcquireMaintenanceLease: () =>
    Promise.resolve(
      leaseFree
        ? {
            release: () => {
              released += 1;
              return Promise.resolve();
            },
          }
        : null,
    ),
});

const env = (): RunApiEnvironment => ({
  authenticate: () => Promise.reject(new Error('the pass does not authenticate')),
  findAgent: (_principal, agentId) =>
    Promise.resolve({ id: agentId, workspaceId: TEST_WORKSPACE_ID, engine: 'claude-agent-sdk' }),
  openSession: (_principal, agent) =>
    Promise.resolve({ id: randomUUID(), agentId: agent.id, engine: null }),
  discardSession: () => Promise.resolve(),
  ownsRun: () => Promise.resolve(true),
  preflight: () => Promise.resolve(null),
  store: new InMemoryRunStore(),
  launch: (context) => {
    launches.push(context);
  },
});

const log = { error: vi.fn(), warn: vi.fn() };
const pass = () => runSchedulePass({ root: root(), runtime: runtime(), runs: env, log });

beforeEach(() => {
  triggers = new Map();
  deliveries = new Map();
  launches = [];
  ownerGone = false;
  unfinished = 0;
  leaseFree = true;
  released = 0;
  markFiredFails = 0;
  pruned = [];
  clock = NOW;
  log.error.mockClear();
  log.warn.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('runSchedulePass', () => {
  it('fires a due trigger once, claims its slot and records the firing', async () => {
    const trigger = add(schedule());

    const result = await pass();

    expect(result).toEqual({ leaseHeld: false, workspaces: 1, fired: 1, skipped: 0, failed: 0 });
    expect(launches).toHaveLength(1);
    expect([...deliveries.keys()]).toEqual([`schedule:${SLOT}`]);
    expect(triggers.get(trigger.id)?.lastFiredAt).toEqual(NOW);
    expect(released).toBe(1);

    expect(await pass()).toMatchObject({ fired: 0, skipped: 0 });
    expect(launches).toHaveLength(1);
  });

  it('prunes the lapsed deliveries of each workspace it sweeps', async () => {
    await pass();
    expect(pruned).toEqual([NOW]);
  });

  it('starts the run with the output schema the trigger carries, and none otherwise (ADR-0154)', async () => {
    const sheet = { type: 'object', properties: { plan: { type: 'string' } } };
    add(schedule({ name: 'typed', outputSchema: sheet }));
    expect(await pass()).toMatchObject({ fired: 1 });
    expect(launches[0]?.outputSchema).toEqual(sheet);

    launches = [];
    deliveries.clear();
    triggers.clear();
    add(schedule({ name: 'untyped' }));
    expect(await pass()).toMatchObject({ fired: 1 });
    expect(launches[0]).not.toHaveProperty('outputSchema');
  });

  it('starts the run with the subject the trigger carries, and none otherwise (ADR-0156)', async () => {
    add(schedule({ name: 'planned', subject: 'planner' }));
    expect(await pass()).toMatchObject({ fired: 1 });
    expect(launches[0]?.subject).toBe('planner');

    launches = [];
    deliveries.clear();
    triggers.clear();
    add(schedule({ name: 'anonymous' }));
    expect(await pass()).toMatchObject({ fired: 1 });
    expect(launches[0]).not.toHaveProperty('subject');
  });

  it('starts nothing for a trigger that is not due, disabled, or a webhook', async () => {
    add(schedule({ name: 'not-due', createdAt: new Date('2026-10-18T00:01:00Z') }));
    add(schedule({ name: 'off', enabled: false }));
    add(schedule({ name: 'hook', kind: 'webhook', cron: null, timezone: null, hasSecret: true }));

    expect(await pass()).toMatchObject({ workspaces: 1, fired: 0, skipped: 0, failed: 0 });
    expect(launches).toHaveLength(0);
    expect(deliveries.size).toBe(0);
  });

  it('fires a backlog of missed windows once and counts from the firing, not the slot', async () => {
    const trigger = add(schedule({ createdAt: new Date('2026-09-01T00:00:00Z') }));

    expect(await pass()).toMatchObject({ fired: 1 });
    expect(await pass()).toMatchObject({ fired: 0 });

    expect(launches).toHaveLength(1);
    expect(triggers.get(trigger.id)?.lastFiredAt).toEqual(NOW);
    clock = new Date('2026-10-19T00:00:30Z');
    expect(await pass()).toMatchObject({ fired: 1 });
    expect(launches).toHaveLength(2);
  });

  it('starts exactly one run when two passes run at the same time', async () => {
    add(schedule());

    const results = await Promise.all([pass(), pass()]);

    expect(launches).toHaveLength(1);
    expect(results.map((result) => result.fired).sort()).toEqual([0, 1]);
    expect(results.map((result) => result.skipped).sort()).toEqual([0, 1]);
    expect(deliveries.size).toBe(1);
  });

  it('moves past a slot whose run started but whose firing was not recorded', async () => {
    const trigger = add(schedule());
    markFiredFails = 1;

    expect(await pass()).toMatchObject({ fired: 0, failed: 1 });
    expect(launches).toHaveLength(1);
    expect(triggers.get(trigger.id)?.lastFiredAt).toBeNull();

    expect(await pass()).toMatchObject({ fired: 0, skipped: 1 });
    expect(triggers.get(trigger.id)?.lastFiredAt).toEqual(NOW);

    // The claim window has lapsed: the slot is not owed again.
    deliveries.clear();
    clock = new Date('2026-10-18T01:05:00Z');
    expect(await pass()).toMatchObject({ fired: 0, skipped: 0 });
    expect(launches).toHaveLength(1);

    clock = new Date('2026-10-19T00:00:30Z');
    expect(await pass()).toMatchObject({ fired: 1 });
    expect([...deliveries.keys()]).toEqual(['schedule:2026-10-19T00:00:00.000Z']);
  });

  it('does nothing while another replica holds the lease', async () => {
    add(schedule());
    leaseFree = false;

    expect(await pass()).toEqual({
      leaseHeld: true,
      workspaces: 0,
      fired: 0,
      skipped: 0,
      failed: 0,
    });
    expect(launches).toHaveLength(0);
  });

  it('starts nothing and holds no claim when the owner may no longer run the agent', async () => {
    const trigger = add(schedule());
    ownerGone = true;

    expect(await pass()).toMatchObject({ fired: 0, skipped: 1 });

    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      `[trigger-schedule] ${trigger.id} skipped: trigger_owner_not_allowed`,
    );
    expect(launches).toHaveLength(0);
    expect(deliveries.size).toBe(0);
    expect(triggers.get(trigger.id)?.lastFiredAt).toBeNull();
  });

  it('releases the claim at the concurrency limit so the next pass retries the slot', async () => {
    const trigger = add(schedule());
    unfinished = 3;

    expect(await pass()).toMatchObject({ fired: 0, skipped: 1 });
    expect(deliveries.size).toBe(0);
    expect(triggers.get(trigger.id)?.lastFiredAt).toBeNull();

    unfinished = 0;
    expect(await pass()).toMatchObject({ fired: 1, skipped: 0 });
    expect(launches).toHaveLength(1);
  });

  it('counts a trigger whose firing throws and still fires the others', async () => {
    add(schedule({ name: 'broken', cron: '61 * * * *' }));
    add(schedule({ name: 'fine' }));

    expect(await pass()).toMatchObject({ fired: 1, failed: 1 });
    expect(launches).toHaveLength(1);
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error.mock.calls[0]?.[0]).toMatch(/^\[trigger-schedule\] .+ failed$/);
  });

  it('releases the lease when the run API is not installed', async () => {
    await expect(
      runSchedulePass({ root: root(), runtime: runtime(), runs: () => null, log }),
    ).rejects.toThrow('run API');
    expect(released).toBe(1);
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
