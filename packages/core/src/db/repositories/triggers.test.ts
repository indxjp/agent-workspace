import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { triggerDeliveries } from '../schema/trigger-deliveries.js';
import { triggers } from '../schema/triggers.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { postgresViolations } from './violations.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import {
  createDatabaseTriggerRepositoryProvider,
  findTriggerForIngress,
  TRIGGER_DELIVERY_DEDUPE_WINDOW_MS,
  type NewTriggerInput,
} from './triggers.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

const sha256Hex = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

async function violationOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return [...postgresViolations(error)].map((violation) => violation.constraint);
  }
  throw new Error('expected the statement to be refused');
}

describe.skipIf(!hasDatabase)('TriggerRepository (ADR-0144)', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const otherUserId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const otherPrincipalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const otherAgentId = crypto.randomUUID();
  const otherRunId = crypto.randomUUID();

  const permissions = {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  };

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_triggers');
    const { db } = isolated;
    await db.insert(workspaces).values([
      { id: workspaceId, slug: workspaceId, name: 'Triggers' },
      { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other' },
    ]);
    await db
      .insert(users)
      .values(
        [userId, otherUserId].map((id) => ({ id, email: `${id}@example.com`, name: 'Owner' })),
      );
    for (const [workspace, principal] of [
      [workspaceId, principalId],
      [otherWorkspaceId, otherPrincipalId],
    ] as const) {
      const membershipId = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({ id: membershipId, workspaceId: workspace, userId, role: 'owner' });
        await tx.insert(workspacePrincipals).values({
          id: principal,
          workspaceId: workspace,
          kind: 'membership',
          membershipId,
        });
      });
    }
    await db.insert(agents).values(
      (
        [
          [agentId, workspaceId, principalId],
          [otherAgentId, otherWorkspaceId, otherPrincipalId],
        ] as const
      ).map(([id, workspace, owner]) => ({
        id,
        workspaceId: workspace,
        name: `agent ${id}`,
        instructions: '',
        ownerPrincipalId: owner,
        createdBy: userId,
        permissions,
      })),
    );
    const otherSessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: otherSessionId,
      workspaceId: otherWorkspaceId,
      userId,
      ownerPrincipalId: otherPrincipalId,
      agentId: otherAgentId,
    });
    await db
      .insert(runs)
      .values({ id: otherRunId, workspaceId: otherWorkspaceId, sessionId: otherSessionId });
  }, 180_000);

  afterAll(async () => isolated.close());

  async function triggersFor(workspace: string) {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(workspace);
    if (scope === null) throw new Error('workspace did not resolve');
    return createDatabaseTriggerRepositoryProvider(isolated.db).forScope(scope);
  }

  const webhook = (
    name: string,
    secret = 's3cret',
  ): Extract<NewTriggerInput, { kind: 'webhook' }> => ({
    kind: 'webhook',
    name,
    agentId,
    promptTemplate: 'Handle: {{body}}',
    ownerPrincipalId: principalId,
    secretHash: sha256Hex(secret),
  });

  const schedule = (name: string): NewTriggerInput => ({
    kind: 'schedule',
    name,
    agentId,
    promptTemplate: 'Daily report',
    ownerPrincipalId: principalId,
    cron: '0 9 * * 1-5',
    timezone: 'Asia/Tokyo',
  });

  async function created(input: NewTriggerInput, workspace = workspaceId) {
    const outcome = await (await triggersFor(workspace)).create(input);
    if (outcome.kind !== 'created') throw new Error(`expected created, got ${outcome.kind}`);
    return outcome.trigger;
  }

  describe('delivery dedupe', () => {
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
      expect(await repo.claimDelivery(trigger.id, 'k', now)).toEqual({
        kind: 'duplicate',
        runId,
      });
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

    it('scopes a key to its trigger', async () => {
      const repo = await triggersFor(workspaceId);
      const first = await created(webhook('dedupe-scope-a'));
      const second = await created(webhook('dedupe-scope-b'));
      const now = new Date();
      expect((await repo.claimDelivery(first.id, 'same', now)).kind).toBe('claimed');
      expect((await repo.claimDelivery(second.id, 'same', now)).kind).toBe('claimed');
    });

    it('refuses a second row for the same (trigger, key) at the database', async () => {
      const trigger = await created(webhook('dedupe-raw'));
      const row = { workspaceId, triggerId: trigger.id, deliveryKey: 'raw' };
      await isolated.db.insert(triggerDeliveries).values(row);
      expect(await violationOf(isolated.db.insert(triggerDeliveries).values(row))).toContain(
        'trigger_deliveries_trigger_key_key',
      );
    });

    it('refuses an empty or oversized key', async () => {
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
  });

  describe('tenant scoping', () => {
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
  });

  describe('webhook secret', () => {
    it('stores only the hash and never returns it', async () => {
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
          await violationOf(
            repo.create({ ...webhook(`plaintext-${bad.length}`), secretHash: bad }),
          ),
        ).toContain('triggers_secret_hash_sha256_hex');
      }
    });

    it('replaces the hash on rotation and refuses to give a schedule one', async () => {
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
  });

  describe('ingress lookup and limits', () => {
    async function runOf(status: 'queued' | 'running' | 'completed') {
      const sessionId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      await isolated.db.insert(sessions).values({
        id: sessionId,
        workspaceId,
        userId,
        ownerPrincipalId: principalId,
        agentId,
      });
      await isolated.db.insert(runs).values({
        id: runId,
        workspaceId,
        sessionId,
        status,
        ...(status === 'completed' ? { endedAt: new Date() } : {}),
      });
      return runId;
    }

    it('finds a trigger in any workspace by id alone, with its hash, and none for an unknown id', async () => {
      const trigger = await created(webhook('ingress-find', 'url-secret'));
      const found = await findTriggerForIngress(isolated.db, trigger.id);
      expect(found?.trigger).toMatchObject({ id: trigger.id, workspaceId });
      expect(found?.secretHash).toBe(sha256Hex('url-secret'));
      const foreign = await created(
        {
          ...webhook('ingress-foreign'),
          agentId: otherAgentId,
          ownerPrincipalId: otherPrincipalId,
        },
        otherWorkspaceId,
      );
      expect((await findTriggerForIngress(isolated.db, foreign.id))?.trigger.workspaceId).toBe(
        otherWorkspaceId,
      );
      expect(await findTriggerForIngress(isolated.db, crypto.randomUUID())).toBeNull();
    });

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
  });

  describe('shape', () => {
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

    it('restarts schedule counting on enable or a cron or time zone change, and on nothing else', async () => {
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

    it('keeps the trigger when its owner principal is removed', async () => {
      const membershipId = crypto.randomUUID();
      const ownerId = crypto.randomUUID();
      await isolated.db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({ id: membershipId, workspaceId, userId: otherUserId, role: 'builder' });
        await tx.insert(workspacePrincipals).values({
          id: ownerId,
          workspaceId,
          kind: 'membership',
          membershipId,
        });
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
  });
});
