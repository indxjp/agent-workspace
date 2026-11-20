import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { triggerDeliveries } from '../schema/trigger-deliveries.js';
import { sha256Hex, type TriggerFixture } from './triggers.fixture.test-support.js';
import { findTriggerForIngress, TRIGGER_DELIVERY_DEDUPE_WINDOW_MS } from './triggers.js';

/** The id-only ingress lookup. */
export function registerIngressLookupCases(fixture: TriggerFixture) {
  const { workspaceId, otherWorkspaceId, otherAgentId, otherPrincipalId } = fixture;
  const { created, webhook } = fixture;

  it('finds a trigger in any workspace by id alone, with its hash, and none for an unknown id', async () => {
    const { isolated } = fixture;
    const trigger = await created(webhook('ingress-find', 'url-secret'));
    const found = await findTriggerForIngress(isolated.db, trigger.id);
    expect(found?.trigger).toMatchObject({ id: trigger.id, workspaceId });
    expect(found?.secretHash).toBe(sha256Hex('url-secret'));
    const foreign = await created(
      { ...webhook('ingress-foreign'), agentId: otherAgentId, ownerPrincipalId: otherPrincipalId },
      otherWorkspaceId,
    );
    expect((await findTriggerForIngress(isolated.db, foreign.id))?.trigger.workspaceId).toBe(
      otherWorkspaceId,
    );
    expect(await findTriggerForIngress(isolated.db, crypto.randomUUID())).toBeNull();
  });
}

/** Rate-limit counting and pruning of deliveries. */
export function registerDeliveryLimitCases(fixture: TriggerFixture) {
  const { workspaceId, otherWorkspaceId, triggersFor, created, webhook, runOf } = fixture;

  it('counts deliveries from the window start, inclusive, within the trigger and workspace', async () => {
    const repo = await triggersFor(workspaceId);
    const trigger = await created(webhook('count-window'));
    const sibling = await created(webhook('count-sibling'));
    const start = new Date('2026-05-01T12:00:00Z');
    await repo.claimDelivery(trigger.id, 'old', new Date(start.getTime() - 1));
    await repo.claimDelivery(trigger.id, 'edge', start);
    await repo.claimDelivery(trigger.id, 'new', new Date(start.getTime() + 1000));
    await repo.claimDelivery(sibling.id, 'other', new Date(start.getTime() + 1000));
    expect(await repo.countDeliveriesSince(trigger.id, start)).toBe(2);
    expect(
      await (await triggersFor(otherWorkspaceId)).countDeliveriesSince(trigger.id, start),
    ).toBe(0);
  });

  it('counts only deliveries whose run has not finished', async () => {
    const repo = await triggersFor(workspaceId);
    const trigger = await created(webhook('count-runs'));
    const now = new Date();
    await repo.claimDelivery(trigger.id, 'unstarted', now);
    for (const [key, status] of [
      ['q', 'queued'],
      ['r', 'running'],
      ['c', 'completed'],
    ] as const) {
      await repo.claimDelivery(trigger.id, key, now);
      await repo.recordDeliveryRun(trigger.id, key, await runOf(status));
    }
    expect(await repo.countUnfinishedRuns(trigger.id)).toBe(2);
    expect(await (await triggersFor(otherWorkspaceId)).countUnfinishedRuns(trigger.id)).toBe(0);
  });

  it('prunes deliveries past the dedupe window, except one whose run is unfinished', async () => {
    const { isolated } = fixture;
    const repo = await triggersFor(workspaceId);
    const trigger = await created(webhook('prune'));
    const old = new Date('2026-01-01T00:00:00Z');
    const now = new Date(old.getTime() + TRIGGER_DELIVERY_DEDUPE_WINDOW_MS);
    for (const key of ['unstarted', 'done', 'running']) {
      await repo.claimDelivery(trigger.id, key, old);
    }
    await repo.recordDeliveryRun(trigger.id, 'done', await runOf('completed'));
    await repo.recordDeliveryRun(trigger.id, 'running', await runOf('running'));
    await repo.claimDelivery(trigger.id, 'recent', new Date(now.getTime() - 1));

    expect(await (await triggersFor(otherWorkspaceId)).pruneDeliveries(now)).toBe(0);
    expect(await repo.pruneDeliveries(now)).toBe(2);
    const left = await isolated.db
      .select({ key: triggerDeliveries.deliveryKey })
      .from(triggerDeliveries)
      .where(eq(triggerDeliveries.triggerId, trigger.id));
    expect(left.map((row) => row.key).sort()).toEqual(['recent', 'running']);
  });
}
