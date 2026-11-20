import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { triggers } from '../schema/triggers.js';
import { sha256Hex, type TriggerFixture, violationOf } from './triggers.fixture.test-support.js';

/** A workspace cannot see or touch another workspace's triggers, and names are per workspace. */
export function registerTenantScopingCases(fixture: TriggerFixture) {
  const { workspaceId, otherWorkspaceId, otherRunId, otherAgentId, otherPrincipalId } = fixture;
  const { triggersFor, created, webhook } = fixture;

  it('hides a trigger and its deliveries from another workspace', async () => {
    const repo = await triggersFor(workspaceId);
    const other = await triggersFor(otherWorkspaceId);
    const trigger = await created(webhook('scoped'));
    const now = new Date();
    await repo.claimDelivery(trigger.id, 'k', now);

    expect(await other.get(trigger.id)).toBeNull();
    expect(await other.list()).toEqual([]);
    expect(await other.update(trigger.id, { enabled: false })).toEqual({ kind: 'not-found' });
    expect(await other.setSecretHash(trigger.id, sha256Hex('x'))).toEqual({ kind: 'not-found' });
    expect(await other.markFired(trigger.id, now)).toBe(false);
    expect(await other.remove(trigger.id)).toBe(false);
    expect(await other.claimDelivery(trigger.id, 'k', now)).toEqual({
      kind: 'trigger-not-found',
    });
    expect(await other.recordDeliveryRun(trigger.id, 'k', otherRunId)).toBe(false);
    expect(await other.releaseDelivery(trigger.id, 'k')).toBe(false);

    expect(await repo.get(trigger.id)).toMatchObject({ enabled: true, lastFiredAt: null });
    expect((await repo.claimDelivery(trigger.id, 'k', now)).kind).toBe('duplicate');
  });

  it("refuses another workspace's agent or owner and writes nothing", async () => {
    const repo = await triggersFor(workspaceId);
    expect(await repo.create({ ...webhook('foreign-agent'), agentId: otherAgentId })).toEqual({
      kind: 'agent-not-found',
    });
    expect(
      await repo.create({ ...webhook('foreign-owner'), ownerPrincipalId: otherPrincipalId }),
    ).toEqual({ kind: 'owner-not-found' });
    expect((await repo.list()).filter((t) => t.name.startsWith('foreign-'))).toEqual([]);
  });

  it('allows one name in two workspaces and refuses it twice in one', async () => {
    const repo = await triggersFor(workspaceId);
    await created(webhook('shared-name'));
    expect(await repo.create(webhook('shared-name'))).toEqual({ kind: 'name-taken' });
    const other = await triggersFor(otherWorkspaceId);
    const outcome = await other.create({
      ...webhook('shared-name'),
      agentId: otherAgentId,
      ownerPrincipalId: otherPrincipalId,
    });
    expect(outcome.kind).toBe('created');
  });
}

/** The webhook secret is stored only as a SHA-256 hex digest. */
export function registerWebhookSecretCases(fixture: TriggerFixture) {
  const { workspaceId, triggersFor, created, webhook, schedule } = fixture;

  it('stores only the hash and never returns it', async () => {
    const { isolated } = fixture;
    const secret = 'plaintext-url-secret';
    const trigger = await created(webhook('hashed', secret));
    expect(trigger.hasSecret).toBe(true);
    expect(Object.keys(trigger)).not.toContain('secretHash');
    expect(JSON.stringify(trigger)).not.toContain(sha256Hex(secret));

    const rows = await isolated.db.select().from(triggers).where(eq(triggers.id, trigger.id));
    expect(rows[0]?.secretHash).toBe(sha256Hex(secret));
    expect(rows[0]?.secretHash).not.toBe(secret);
  });

  it('refuses a value that is not a SHA-256 hex digest', async () => {
    const repo = await triggersFor(workspaceId);
    const trigger = await created(webhook('plaintext-guard'));
    for (const bad of ['plaintext-url-secret', sha256Hex('x').toUpperCase(), 'ab']) {
      expect(await violationOf(repo.setSecretHash(trigger.id, bad))).toContain(
        'triggers_secret_hash_sha256_hex',
      );
      expect(
        await violationOf(repo.create({ ...webhook(`plaintext-${bad.length}`), secretHash: bad })),
      ).toContain('triggers_secret_hash_sha256_hex');
    }
  });

  it('replaces the hash on rotation and refuses to give a schedule one', async () => {
    const { isolated } = fixture;
    const repo = await triggersFor(workspaceId);
    const trigger = await created(webhook('rotate', 'old'));
    const rotated = await repo.setSecretHash(trigger.id, sha256Hex('new'));
    expect(rotated.kind).toBe('set');
    const rows = await isolated.db.select().from(triggers).where(eq(triggers.id, trigger.id));
    expect(rows[0]?.secretHash).toBe(sha256Hex('new'));

    const timed = await created(schedule('rotate-schedule'));
    expect(await repo.setSecretHash(timed.id, sha256Hex('x'))).toEqual({ kind: 'not-webhook' });
    expect(timed.hasSecret).toBe(false);
  });
}
