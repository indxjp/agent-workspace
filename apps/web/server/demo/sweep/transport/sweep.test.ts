import { describe, expect, it, vi } from 'vitest';

import { fixedClock } from '../../../clock';
import { MemoryLeadStore } from '../../adapters/leads/memory';
import { MemoryDemoSweepStore } from '../adapters/store/memory';
import { DEMO_SWEEP_MIN_INTERVAL_MS, DEMO_SWEEP_WORKSPACES_PER_PASS } from '../core/rules';
import type { DemoWorkspaceFiles } from '../ports';
import { createDemoSweep, type DemoSweepDependencies } from './sweep';

const T0 = new Date('2026-11-16T10:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const at = (ms: number) => new Date(T0.getTime() + ms);

function rig(overrides: Partial<DemoSweepDependencies> = {}) {
  const clock = fixedClock(T0);
  const store = new MemoryDemoSweepStore();
  const leads = new MemoryLeadStore();
  const removed: string[] = [];
  const files: DemoWorkspaceFiles = {
    removeAll: (workspaceId) => {
      removed.push(workspaceId);
      return Promise.resolve();
    },
  };
  const release = vi.fn(() => Promise.resolve());
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const sweep = createDemoSweep({
    store,
    leads,
    files,
    leadRetentionDays: 30,
    tryAcquireMaintenanceLease: () => Promise.resolve({ release }),
    clock,
    log,
    ...overrides,
  });
  return { clock, store, leads, removed, release, log, sweep };
}

describe('the demo workspace sweep', () => {
  it('deletes a demo workspace at its end and after it, and keeps one before it', async () => {
    const { store, sweep } = rig();
    store.addWorkspace('at-end', { demoExpiresAt: T0, usage: [] });
    store.addWorkspace('past', { demoExpiresAt: at(-DAY_MS), usage: [] });
    store.addWorkspace('before', { demoExpiresAt: at(1), usage: [] });
    const result = await sweep();
    expect(result.workspacesDeleted).toBe(2);
    expect(store.hasWorkspace('at-end')).toBe(false);
    expect(store.hasWorkspace('past')).toBe(false);
    expect(store.hasWorkspace('before')).toBe(true);
  });

  it('never deletes a real workspace', async () => {
    const { store, sweep, removed } = rig();
    store.addWorkspace('real', { demoExpiresAt: null, usage: [] });
    await sweep();
    expect(store.hasWorkspace('real')).toBe(true);
    expect(removed).toEqual([]);
  });

  it('removes a workspace files before its rows, and carries its spend into the day total', async () => {
    const order: string[] = [];
    const { store, sweep } = rig({
      files: { removeAll: () => Promise.resolve(void order.push('files')) },
    });
    store.addWorkspace('w', {
      demoExpiresAt: at(-1),
      usage: [{ at: at(-2 * HOUR_MS), costUsd: 1.5, unpriced: false }],
    });
    const deleting = store.deleteExpiredWorkspace.bind(store);
    store.deleteExpiredWorkspace = (id, now) => {
      order.push('rows');
      return deleting(id, now);
    };
    await sweep();
    expect(order).toEqual(['files', 'rows']);
    expect(store.carried.get('2026-11-16')).toEqual({ costUsd: 1.5, unpriced: false });
  });

  it('keeps a workspace whole when its files cannot be removed, and tries it again next time', async () => {
    let fail = true;
    const { store, sweep, log, clock } = rig({
      files: {
        removeAll: () => (fail ? Promise.reject(new Error('storage down')) : Promise.resolve()),
      },
    });
    store.addWorkspace('w', { demoExpiresAt: at(-1), usage: [] });
    const first = await sweep();
    expect(first).toMatchObject({ workspacesDeleted: 0, workspacesFailed: 1 });
    expect(store.hasWorkspace('w')).toBe(true);
    expect(log.error).toHaveBeenCalled();
    fail = false;
    clock.advance(DEMO_SWEEP_MIN_INTERVAL_MS);
    expect((await sweep()).workspacesDeleted).toBe(1);
    expect(store.hasWorkspace('w')).toBe(false);
  });

  it('one workspace failing does not stop the others, nor the other jobs', async () => {
    const { store, sweep } = rig({
      files: {
        removeAll: (id) => (id === 'bad' ? Promise.reject(new Error('x')) : Promise.resolve()),
      },
    });
    store.addWorkspace('bad', { demoExpiresAt: at(-2), usage: [] });
    store.addWorkspace('good', { demoExpiresAt: at(-1), usage: [] });
    store.addAdmission(at(-2 * DAY_MS));
    const result = await sweep();
    expect(result).toMatchObject({
      workspacesDeleted: 1,
      workspacesFailed: 1,
      admissionsDeleted: 1,
    });
  });

  it('deletes at most one pass worth of workspaces; the rest wait for the next', async () => {
    const { store, sweep } = rig();
    for (let n = 0; n < DEMO_SWEEP_WORKSPACES_PER_PASS + 3; n += 1) {
      store.addWorkspace(`w${String(n)}`, { demoExpiresAt: at(-DAY_MS - n), usage: [] });
    }
    expect((await sweep()).workspacesDeleted).toBe(DEMO_SWEEP_WORKSPACES_PER_PASS);
  });
});

describe('the login-token and admission sweeps', () => {
  it('prunes links expired or used over a day ago, and admissions older than the caps window', async () => {
    const { store, sweep } = rig();
    store.addLoginToken(at(-2 * DAY_MS));
    store.addLoginToken(at(HOUR_MS), at(-2 * DAY_MS));
    store.addLoginToken(at(HOUR_MS));
    store.addLoginToken(at(-HOUR_MS));
    store.addAdmission(at(-DAY_MS - 1));
    store.addAdmission(at(-DAY_MS));
    const result = await sweep();
    expect(result).toMatchObject({ loginTokensDeleted: 2, admissionsDeleted: 1 });
    expect(store.loginTokenCount).toBe(2);
    expect(store.admissionCount).toBe(1);
  });

  it('deletes a guest user nothing holds, after its admissions are pruned, and no other', async () => {
    const { store, sweep, clock } = rig();
    store.addUser('idle', { createdAt: at(-3 * DAY_MS), held: false, lead: true });
    store.addUser('member', { createdAt: at(-3 * DAY_MS), held: true, lead: true });
    store.addUser('recent', { createdAt: at(-HOUR_MS), held: false, lead: true });
    // Inside the look-back the cap counts it, so the user stays; the day after, both go.
    store.addUser('admitted', { createdAt: at(-3 * DAY_MS), held: false, lead: true });
    store.addAdmission(at(-HOUR_MS), 'admitted');
    const first = await sweep();
    expect(first.guestUsersDeleted).toBe(1);
    expect(store.hasUser('idle')).toBe(false);
    expect(store.hasUser('member')).toBe(true);
    expect(store.hasUser('recent')).toBe(true);
    expect(store.hasUser('admitted')).toBe(true);
    clock.advance(DAY_MS + HOUR_MS);
    expect((await sweep()).guestUsersDeleted).toBe(2);
    expect(store.hasUser('admitted')).toBe(false);
    expect(store.hasUser('recent')).toBe(false);
    expect(store.hasUser('member')).toBe(true);
  });
});

describe('the lead retention job (R7)', () => {
  it('deletes leads last contacted before the retention period and keeps recent ones', async () => {
    const { leads, sweep } = rig({ leadRetentionDays: 30 });
    await leads.recordContact({ email: 'old@example.test', entry: null, now: at(-31 * DAY_MS) });
    await leads.recordContact({ email: 'edge@example.test', entry: null, now: at(-30 * DAY_MS) });
    await leads.recordContact({ email: 'new@example.test', entry: null, now: at(-DAY_MS) });
    const result = await sweep();
    expect(result.leadsDeleted).toBe(1);
    expect(leads.leads.map((lead) => lead.email)).toEqual([
      'edge@example.test',
      'new@example.test',
    ]);
  });

  it('does not run while the retention period is unset, and says so once', async () => {
    const { leads, sweep, log, clock } = rig({ leadRetentionDays: null });
    await leads.recordContact({
      email: 'ancient@example.test',
      entry: null,
      now: at(-3650 * DAY_MS),
    });
    expect((await sweep()).leadsDeleted).toBeNull();
    clock.advance(DEMO_SWEEP_MIN_INTERVAL_MS);
    await sweep();
    expect(leads.leads).toHaveLength(1);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('AW_STORE_LEAD_RETENTION_DAYS'));
  });
});

describe('the sweep schedule', () => {
  it('runs at most once per interval in a process, and again after it', async () => {
    const { sweep, clock, store } = rig();
    store.addWorkspace('w', { demoExpiresAt: at(-1), usage: [] });
    expect((await sweep()).throttled).toBe(false);
    expect((await sweep()).throttled).toBe(true);
    clock.advance(DEMO_SWEEP_MIN_INTERVAL_MS - 1);
    expect((await sweep()).throttled).toBe(true);
    clock.advance(1);
    expect((await sweep()).throttled).toBe(false);
  });

  it('does nothing while another replica holds the lease, and is not throttled for trying again', async () => {
    let held = true;
    const release = vi.fn(() => Promise.resolve());
    const { sweep, store } = rig({
      tryAcquireMaintenanceLease: () => Promise.resolve(held ? null : { release }),
    });
    store.addWorkspace('w', { demoExpiresAt: at(-1), usage: [] });
    expect(await sweep()).toMatchObject({ leaseHeld: true, workspacesDeleted: 0 });
    held = false;
    expect(await sweep()).toMatchObject({ leaseHeld: false, workspacesDeleted: 1 });
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the lease even when a step throws', async () => {
    const { sweep, release, store } = rig();
    store.expiredWorkspaceIds = () => Promise.reject(new Error('db'));
    await sweep();
    expect(release).toHaveBeenCalledOnce();
  });
});
