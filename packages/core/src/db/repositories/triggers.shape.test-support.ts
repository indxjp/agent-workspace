import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { triggers } from '../schema/triggers.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { sha256Hex, type TriggerFixture, violationOf } from './triggers.fixture.test-support.js';
import { findTriggerForIngress } from './triggers.js';

/** Schedule round-trip and the optional output schema and subject. */
export function registerTriggerFieldCases(fixture: TriggerFixture) {
  const { workspaceId, triggersFor, created, webhook, schedule } = fixture;

  it('round-trips a schedule, defaults enabled and records firings', async () => {
    const repo = await triggersFor(workspaceId);
    const trigger = await created(schedule('daily'));
    expect(trigger).toMatchObject({
      kind: 'schedule',
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Tokyo',
      enabled: true,
      lastFiredAt: null,
    });
    const first = new Date('2026-03-02T00:00:00Z');
    expect(await repo.markFired(trigger.id, first)).toBe(true);
    expect((await repo.get(trigger.id))?.lastFiredAt).toEqual(first);
    await repo.markFired(trigger.id, new Date('2026-03-01T00:00:00Z'));
    expect((await repo.get(trigger.id))?.lastFiredAt).toEqual(first);
    expect(await repo.markFired(crypto.randomUUID(), first)).toBe(false);
  });

  it('stores, replaces, keeps and clears the output schema, and the ingress lookup returns it', async () => {
    const { isolated } = fixture;
    const repo = await triggersFor(workspaceId);
    const sheet = { type: 'object', properties: { verdict: { type: 'string' } } };
    const typed = await created({ ...webhook('typed-output'), outputSchema: sheet });
    expect(typed.outputSchema).toEqual(sheet);
    expect((await created(webhook('untyped-output'))).outputSchema).toBeNull();
    expect((await findTriggerForIngress(isolated.db, typed.id))?.trigger.outputSchema).toEqual(
      sheet,
    );

    const kept = await repo.update(typed.id, { enabled: false });
    expect(kept).toMatchObject({ kind: 'updated', trigger: { outputSchema: sheet } });
    const next = { type: 'object', properties: { score: { type: 'number' } } };
    const replaced = await repo.update(typed.id, { outputSchema: next });
    expect(replaced).toMatchObject({ kind: 'updated', trigger: { outputSchema: next } });
    const cleared = await repo.update(typed.id, { outputSchema: null });
    expect(cleared).toMatchObject({ kind: 'updated', trigger: { outputSchema: null } });
    expect((await repo.get(typed.id))?.outputSchema).toBeNull();
  });

  it('stores, replaces, keeps and clears the subject, and the ingress lookup returns it', async () => {
    const { isolated } = fixture;
    const repo = await triggersFor(workspaceId);
    const withSubject = await created({ ...webhook('subject-set'), subject: 'alice' });
    expect(withSubject.subject).toBe('alice');
    expect((await created(webhook('subject-unset'))).subject).toBeNull();
    expect((await findTriggerForIngress(isolated.db, withSubject.id))?.trigger.subject).toBe(
      'alice',
    );

    const kept = await repo.update(withSubject.id, { enabled: false });
    expect(kept).toMatchObject({ kind: 'updated', trigger: { subject: 'alice' } });
    const replaced = await repo.update(withSubject.id, { subject: 'bob' });
    expect(replaced).toMatchObject({ kind: 'updated', trigger: { subject: 'bob' } });
    const cleared = await repo.update(withSubject.id, { subject: null });
    expect(cleared).toMatchObject({ kind: 'updated', trigger: { subject: null } });
    expect((await repo.get(withSubject.id))?.subject).toBeNull();
  });
}

/** Updates and the kind-shape rules. */
export function registerTriggerUpdateCases(fixture: TriggerFixture) {
  const { workspaceId, principalId, agentId, triggersFor, created, webhook, schedule } = fixture;

  it('restarts schedule counting on enable or a cron or time zone change, and on nothing else', async () => {
    const { isolated } = fixture;
    const repo = await triggersFor(workspaceId);
    const trigger = await created(schedule('restart'));
    expect(trigger.scheduleFrom).toBeNull();
    const old = new Date('2026-01-01T00:00:00Z');
    /** Whether `patch` moved the counting base off an old value. */
    const restarts = async (patch: Parameters<typeof repo.update>[1]) => {
      await isolated.db
        .update(triggers)
        .set({ scheduleFrom: old })
        .where(eq(triggers.id, trigger.id));
      const outcome = await repo.update(trigger.id, patch);
      if (outcome.kind !== 'updated') throw new Error(`expected updated, got ${outcome.kind}`);
      return outcome.trigger.scheduleFrom?.getTime() !== old.getTime();
    };
    expect(await restarts({ enabled: false })).toBe(false);
    expect(await restarts({ name: 'restart-renamed', cron: '0 9 * * 1-5' })).toBe(false);
    expect(await restarts({ enabled: true })).toBe(true);
    expect(await restarts({ enabled: true, timezone: 'Asia/Tokyo' })).toBe(false);
    expect(await restarts({ cron: '0 10 * * 1-5' })).toBe(true);
    expect(await restarts({ timezone: 'UTC' })).toBe(true);
  });

  it('refuses a kind that carries the other kind fields', async () => {
    const { isolated } = fixture;
    const bad = [
      { kind: 'webhook', cron: '* * * * *', timezone: 'UTC', secretHash: sha256Hex('x') },
      { kind: 'webhook', cron: null, timezone: null, secretHash: null },
      { kind: 'schedule', cron: '* * * * *', timezone: 'UTC', secretHash: sha256Hex('x') },
      { kind: 'schedule', cron: null, timezone: null, secretHash: null },
      { kind: 'schedule', cron: '* * * * *', timezone: null, secretHash: null },
    ] as const;
    for (const [index, shape] of bad.entries()) {
      expect(
        await violationOf(
          isolated.db.insert(triggers).values({
            workspaceId,
            agentId,
            ownerPrincipalId: principalId,
            name: `bad-shape-${String(index)}`,
            promptTemplate: 'x',
            ...shape,
          }),
        ),
      ).toContain('triggers_kind_shape');
    }
  });

  it('updates fields, refuses a clash, and keeps the kind rules', async () => {
    const repo = await triggersFor(workspaceId);
    const timed = await created(schedule('upd-schedule'));
    const hook = await created(webhook('upd-webhook'));
    const updated = await repo.update(timed.id, {
      promptTemplate: 'New',
      cron: '*/5 * * * *',
      enabled: false,
    });
    if (updated.kind !== 'updated') throw new Error('expected updated');
    expect(updated.trigger).toMatchObject({
      promptTemplate: 'New',
      cron: '*/5 * * * *',
      timezone: 'Asia/Tokyo',
      enabled: false,
    });
    expect(updated.trigger.updatedAt.getTime()).toBeGreaterThanOrEqual(timed.updatedAt.getTime());
    expect(await repo.update(timed.id, { name: 'upd-webhook' })).toEqual({ kind: 'name-taken' });
    expect(await repo.update(hook.id, { cron: '* * * * *' })).toEqual({ kind: 'invalid-shape' });
    expect(await repo.update(crypto.randomUUID(), { enabled: true })).toEqual({
      kind: 'not-found',
    });
  });
}

/** Referential integrity between a trigger and its owner and agent. */
export function registerTriggerIntegrityCases(fixture: TriggerFixture) {
  const { workspaceId, userId, otherUserId, principalId, permissions } = fixture;
  const { triggersFor, created, webhook } = fixture;

  it('keeps the trigger when its owner principal is removed', async () => {
    const { isolated } = fixture;
    const membershipId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId, userId: otherUserId, role: 'builder' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: ownerId, workspaceId, kind: 'membership', membershipId });
    });
    const trigger = await created({ ...webhook('owner-guard'), ownerPrincipalId: ownerId });
    expect(
      await violationOf(
        isolated.db.delete(workspacePrincipals).where(eq(workspacePrincipals.id, ownerId)),
      ),
    ).toContain('triggers_owner_workspace_fk');
    expect(await (await triggersFor(workspaceId)).get(trigger.id)).not.toBeNull();
  });

  it("deletes an agent's triggers with the agent", async () => {
    const { isolated } = fixture;
    const doomed = crypto.randomUUID();
    await isolated.db.insert(agents).values({
      id: doomed,
      workspaceId,
      name: 'doomed',
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions,
    });
    const trigger = await created({ ...webhook('agent-cascade'), agentId: doomed });
    await isolated.db.delete(agents).where(eq(agents.id, doomed));
    expect(await (await triggersFor(workspaceId)).get(trigger.id)).toBeNull();
  });
}
