import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { triggerDeliveries } from '../schema/trigger-deliveries.js';
import { type TriggerFixture, violationOf } from './triggers.fixture.test-support.js';
import { TRIGGER_DELIVERY_DEDUPE_WINDOW_MS } from './triggers.js';

/** Claiming a key, the run it records, and concurrent claims. */
export function registerDeliveryClaimCases(fixture: TriggerFixture) {
  const { workspaceId, otherWorkspaceId, otherRunId, triggersFor, created, webhook } = fixture;

  it('pins the window at 24 hours', () => {
    expect(TRIGGER_DELIVERY_DEDUPE_WINDOW_MS).toBe(86_400_000);
  });

  it('claims a key once, then answers with the first firing run id', async () => {
    const repo = await triggersFor(workspaceId);
    const trigger = await created(webhook('dedupe-basic'));
    const now = new Date();
    expect(await repo.claimDelivery(trigger.id, 'k1', now)).toEqual({ kind: 'claimed' });
    expect(await repo.claimDelivery(trigger.id, 'k1', now)).toEqual({
      kind: 'duplicate',
      runId: null,
    });
    expect(await repo.claimDelivery(trigger.id, 'k2', now)).toEqual({ kind: 'claimed' });
  });

  it('returns the recorded run id on a repeat and records it only once', async () => {
    const { isolated, userId, principalId, agentId } = fixture;
    const repo = await triggersFor(workspaceId);
    const trigger = await created(webhook('dedupe-run'));
    const otherRepo = await triggersFor(otherWorkspaceId);
    const now = new Date();
    await repo.claimDelivery(trigger.id, 'k', now);

    // A run of another workspace cannot be named by this workspace's delivery.
    expect(await violationOf(repo.recordDeliveryRun(trigger.id, 'k', otherRunId))).toContain(
      'trigger_deliveries_run_workspace_fk',
    );
    expect(await otherRepo.recordDeliveryRun(trigger.id, 'k', otherRunId)).toBe(false);

    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await isolated.db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      userId,
      ownerPrincipalId: principalId,
      agentId,
    });
    await isolated.db.insert(runs).values({ id: runId, workspaceId, sessionId });
    expect(await repo.recordDeliveryRun(trigger.id, 'k', runId)).toBe(true);
    expect(await repo.recordDeliveryRun(trigger.id, 'k', runId)).toBe(false);
    expect(await repo.claimDelivery(trigger.id, 'k', now)).toEqual({ kind: 'duplicate', runId });
  });

  it('lets exactly one of many concurrent claims win', async () => {
    const repo = await triggersFor(workspaceId);
    const trigger = await created(webhook('dedupe-race'));
    const now = new Date();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => repo.claimDelivery(trigger.id, 'race', now)),
    );
    expect(outcomes.filter((outcome) => outcome.kind === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'duplicate')).toHaveLength(7);
  });
}

/** The database constraints on the delivery table. */
export function registerDeliveryConstraintCases(fixture: TriggerFixture) {
  const { workspaceId, triggersFor, created, webhook } = fixture;

  it('scopes a key to its trigger', async () => {
    const repo = await triggersFor(workspaceId);
    const first = await created(webhook('dedupe-scope-a'));
    const second = await created(webhook('dedupe-scope-b'));
    const now = new Date();
    expect((await repo.claimDelivery(first.id, 'same', now)).kind).toBe('claimed');
    expect((await repo.claimDelivery(second.id, 'same', now)).kind).toBe('claimed');
  });

  it('refuses a second row for the same (trigger, key) at the database', async () => {
    const { isolated } = fixture;
    const trigger = await created(webhook('dedupe-raw'));
    const row = { workspaceId, triggerId: trigger.id, deliveryKey: 'raw' };
    await isolated.db.insert(triggerDeliveries).values(row);
    expect(await violationOf(isolated.db.insert(triggerDeliveries).values(row))).toContain(
      'trigger_deliveries_trigger_key_key',
    );
  });

  it('refuses an empty or oversized key', async () => {
    const { isolated } = fixture;
    const trigger = await created(webhook('dedupe-length'));
    for (const deliveryKey of ['', 'x'.repeat(256)]) {
      expect(
        await violationOf(
          isolated.db
            .insert(triggerDeliveries)
            .values({ workspaceId, triggerId: trigger.id, deliveryKey }),
        ),
      ).toContain('trigger_deliveries_key_length');
    }
  });
}

/** Reclaiming after the window and releasing a key. */
export function registerDeliveryWindowCases(fixture: TriggerFixture) {
  const { workspaceId, triggersFor, created, webhook } = fixture;

  it('reclaims a key once the window has passed, and not a moment before', async () => {
    const repo = await triggersFor(workspaceId);
    const trigger = await created(webhook('dedupe-window'));
    const start = new Date('2026-01-01T00:00:00Z');
    await repo.claimDelivery(trigger.id, 'w', start);
    const justInside = new Date(start.getTime() + TRIGGER_DELIVERY_DEDUPE_WINDOW_MS - 1);
    expect((await repo.claimDelivery(trigger.id, 'w', justInside)).kind).toBe('duplicate');
    const atEdge = new Date(start.getTime() + TRIGGER_DELIVERY_DEDUPE_WINDOW_MS);
    expect((await repo.claimDelivery(trigger.id, 'w', atEdge)).kind).toBe('claimed');
    expect((await repo.claimDelivery(trigger.id, 'w', atEdge)).kind).toBe('duplicate');
  });

  it('frees a released key and removes deliveries with their trigger', async () => {
    const { isolated } = fixture;
    const repo = await triggersFor(workspaceId);
    const trigger = await created(webhook('dedupe-release'));
    const now = new Date();
    await repo.claimDelivery(trigger.id, 'r', now);
    expect(await repo.releaseDelivery(trigger.id, 'r')).toBe(true);
    expect(await repo.releaseDelivery(trigger.id, 'r')).toBe(false);
    expect((await repo.claimDelivery(trigger.id, 'r', now)).kind).toBe('claimed');

    expect(await repo.remove(trigger.id)).toBe(true);
    expect(
      await isolated.db
        .select()
        .from(triggerDeliveries)
        .where(eq(triggerDeliveries.triggerId, trigger.id)),
    ).toEqual([]);
  });
}
