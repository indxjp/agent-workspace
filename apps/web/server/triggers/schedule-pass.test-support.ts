/**
 * In-memory fakes for the schedule-pass tests: a trigger repository whose delivery claim is atomic
 * like the unique index it stands for, a maintenance lease, and a run API that records its launches.
 * All of it reads and writes the one `world`, which `resetWorld` returns to its initial state.
 */
import { randomUUID } from 'node:crypto';

import { vi } from 'vitest';

import { Principal } from '../rbac/principal';
import { TEST_WORKSPACE_ID } from '../rbac/testing';
import type { LaunchContext, RunApiEnvironment } from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import type { TriggerRecord, TriggersRuntime } from './runtime';
import { runSchedulePass, type ScheduleRoot } from './schedule-pass';

const AGENT = randomUUID();
const OWNER = randomUUID();
export const NOW = new Date('2026-10-18T00:05:00Z');
// 09:00 every day in Tokyo is 00:00Z, so the slot of NOW is 2026-10-18T00:00:00Z.
export const SLOT = '2026-10-18T00:00:00.000Z';

export interface World {
  triggers: Map<string, TriggerRecord>;
  deliveries: Map<string, string | null>;
  launches: LaunchContext[];
  ownerGone: boolean;
  unfinished: number;
  leaseFree: boolean;
  released: number;
  markFiredFails: number;
  pruned: Date[];
  clock: Date;
}

const freshWorld = (): World => ({
  triggers: new Map(),
  deliveries: new Map(),
  launches: [],
  ownerGone: false,
  unfinished: 0,
  leaseFree: true,
  released: 0,
  markFiredFails: 0,
  pruned: [],
  clock: NOW,
});

/** The mutable in-memory state every fake in this file reads and writes. */
export const world: World = freshWorld();

/** Reset `world` to its initial state and clear the logger spies (call from `beforeEach`). */
export function resetWorld(): void {
  Object.assign(world, freshWorld());
  log.error.mockClear();
  log.warn.mockClear();
}

export const schedule = (overrides: Partial<TriggerRecord> = {}): TriggerRecord => ({
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

export const add = (trigger: TriggerRecord): TriggerRecord => {
  world.triggers.set(trigger.id, trigger);
  return trigger;
};

export const runtime = (): TriggersRuntime => ({
  repository: () =>
    Promise.resolve({
      list: () => Promise.resolve([...world.triggers.values()]),
      get: (id) => Promise.resolve(world.triggers.get(id) ?? null),
      create: () => Promise.reject(new Error('not used')),
      update: () => Promise.reject(new Error('not used')),
      setSecretHash: () => Promise.reject(new Error('not used')),
      remove: () => Promise.reject(new Error('not used')),
      countDeliveriesSince: () => Promise.resolve(world.deliveries.size),
      countUnfinishedRuns: () => Promise.resolve(world.unfinished),
      markFired: (id, at) => {
        if (world.markFiredFails > 0) {
          world.markFiredFails -= 1;
          return Promise.reject(new Error('database unavailable'));
        }
        const row = world.triggers.get(id);
        if (row === undefined) return Promise.resolve(false);
        world.triggers.set(id, { ...row, lastFiredAt: at });
        return Promise.resolve(true);
      },
      claimDelivery: (_triggerId, key) => {
        if (world.deliveries.has(key)) {
          return Promise.resolve({ kind: 'duplicate', runId: world.deliveries.get(key) ?? null });
        }
        world.deliveries.set(key, null);
        return Promise.resolve({ kind: 'claimed' });
      },
      recordDeliveryRun: (_triggerId, key, runId) => {
        world.deliveries.set(key, runId);
        return Promise.resolve(true);
      },
      releaseDelivery: (_triggerId, key) => Promise.resolve(world.deliveries.delete(key)),
      pruneDeliveries: (now) => {
        world.pruned.push(now);
        return Promise.resolve(0);
      },
    }),
  findForIngress: () => Promise.resolve(null),
  owner: (workspaceId, principalId) =>
    Promise.resolve(
      world.ownerGone
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
  now: () => world.clock,
});

export const root = (): ScheduleRoot => ({
  listWorkspaceIds: () => Promise.resolve([TEST_WORKSPACE_ID]),
  tryAcquireMaintenanceLease: () =>
    Promise.resolve(
      world.leaseFree
        ? {
            release: () => {
              world.released += 1;
              return Promise.resolve();
            },
          }
        : null,
    ),
});

export const env = (): RunApiEnvironment => ({
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
    world.launches.push(context);
  },
});

export const log = { error: vi.fn(), warn: vi.fn() };
export const pass = () => runSchedulePass({ root: root(), runtime: runtime(), runs: env, log });
