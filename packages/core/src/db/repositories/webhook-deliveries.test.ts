/**
 * The webhook outbox against a real PostgreSQL (N-3, issue #250, ADR-SDK-18-N3-250 D3, D4): the
 * run's stop writes one pending delivery per subscribed webhook in its own transaction, and the
 * worker's claims never share a row and never settle a row twice.
 */
import crypto from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { webhookDeliveries } from '../schema/webhook-deliveries.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseRunRepositoryProvider, type RunRepository } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations } from './violations.js';
import {
  createDatabaseWebhookDeliveryRepository,
  type WebhookDeliveryRepository,
} from './webhook-deliveries.js';
import { createDatabaseWebhookRepositoryProvider, type WebhookRepository } from './webhooks.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/webhook-deliveries.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

const CALL = { toolName: 'send_email', canonicalCall: '{"to":"a@example.test"}' } as const;
const CLAIM = { limit: 100, claimMs: 60_000, maxAttempts: 8 } as const;

interface Tenant {
  readonly workspaceId: string;
  readonly userId: string;
  readonly principalId: string;
  readonly agentId: string;
  runs: RunRepository;
  webhooks: WebhookRepository;
}

describe.skipIf(!hasDatabase)('the webhook delivery outbox (ADR-SDK-18-N3-250 D4)', () => {
  let isolated: IsolatedTestDatabase;
  let outbox: WebhookDeliveryRepository;
  let tenant: Tenant;
  let other: Tenant;
  /** Subscribed to every event. */
  let allEvents: string;
  /** Subscribed to `run.failed` only. */
  let failuresOnly: string;
  /** The other workspace's webhook, subscribed to every event. */
  let otherWebhook: string;

  async function seedTenant(): Promise<Tenant> {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const { db } = isolated;
    await db.insert(workspaces).values({ id: workspaceId, slug: workspaceId, name: 'Hooks' });
    await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Hooked agent',
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('fixture workspace did not resolve');
    return {
      workspaceId,
      userId,
      principalId,
      agentId,
      runs: createDatabaseRunRepositoryProvider(db).forScope(scope),
      webhooks: createDatabaseWebhookRepositoryProvider(db).forScope(scope),
    };
  }

  async function seedRunning(owner: Tenant): Promise<{ runId: string; sessionId: string }> {
    const sessionId = crypto.randomUUID();
    await isolated.db.insert(sessions).values({
      id: sessionId,
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      ownerPrincipalId: owner.principalId,
      agentId: owner.agentId,
    });
    const runId = crypto.randomUUID();
    const created = await owner.runs.create({ id: runId, sessionId, engine: 'claude-agent-sdk' });
    expect(created.kind).toBe('created');
    expect((await owner.runs.markRunning(runId)).kind).toBe('moved');
    return { runId, sessionId };
  }

  async function webhookOf(
    owner: Tenant,
    events: Parameters<WebhookRepository['create']>[0]['events'],
  ) {
    const created = await owner.webhooks.create({ url: 'https://hooks.example.com/', events });
    if (created.kind !== 'created') throw new Error('webhook create failed');
    return created.webhook.id;
  }

  /** The deliveries written for `runId`, as `webhookId → eventType`. */
  async function deliveriesOf(runId: string): Promise<Record<string, string>> {
    const rows = await isolated.db
      .select({ webhookId: webhookDeliveries.webhookId, eventType: webhookDeliveries.eventType })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.runId, runId));
    return Object.fromEntries(rows.map((row) => [row.webhookId, row.eventType]));
  }

  async function violationOf(promise: Promise<unknown>): Promise<string[]> {
    try {
      await promise;
    } catch (error) {
      return [...postgresViolations(error)].map((violation) => violation.constraint);
    }
    throw new Error('expected the statement to be refused');
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_webhook_deliveries');
    outbox = createDatabaseWebhookDeliveryRepository(isolated.db);
    tenant = await seedTenant();
    other = await seedTenant();
    allEvents = await webhookOf(tenant, ['run.completed', 'run.failed', 'run.cancelled']);
    failuresOnly = await webhookOf(tenant, ['run.failed']);
    otherWebhook = await webhookOf(other, ['run.completed', 'run.failed', 'run.cancelled']);
  }, 180_000);

  afterAll(async () => isolated.close());

  describe('writing (stopIn)', () => {
    it('writes one pending delivery per subscribed webhook of the run’s workspace', async () => {
      const { runId } = await seedRunning(tenant);
      expect((await tenant.runs.finish(runId, 'completed', null)).kind).toBe('moved');

      expect(await deliveriesOf(runId)).toEqual({ [allEvents]: 'run.completed' });
      const [row] = await isolated.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.runId, runId));
      expect(row).toMatchObject({
        workspaceId: tenant.workspaceId,
        state: 'pending',
        attempts: 0,
        deliveredAt: null,
      });

      const failed = await seedRunning(tenant);
      await tenant.runs.finish(failed.runId, 'failed', 'boom');
      expect(await deliveriesOf(failed.runId)).toEqual({
        [allEvents]: 'run.failed',
        [failuresOnly]: 'run.failed',
      });
      expect(Object.keys(await deliveriesOf(failed.runId))).not.toContain(otherWebhook);
    });

    it('writes nothing for a pause, and nothing for a finish that does not move the run', async () => {
      const { runId } = await seedRunning(tenant);
      expect((await tenant.runs.awaitApproval(runId, CALL)).kind).toBe('moved');
      expect(await deliveriesOf(runId)).toEqual({});

      // The pause's decision is the terminal transition, and it emits once.
      expect((await tenant.runs.finish(runId, 'cancelled', null)).kind).toBe('moved');
      expect(await deliveriesOf(runId)).toEqual({ [allEvents]: 'run.cancelled' });
      expect((await tenant.runs.finish(runId, 'completed', null)).kind).toBe('no-op');
      expect((await tenant.runs.finish(runId, 'cancelled', null)).kind).toBe('no-op');
      expect(await deliveriesOf(runId)).toEqual({ [allEvents]: 'run.cancelled' });
    });

    it('writes run.completed for an approval decision, in the continuation’s transaction', async () => {
      const paused = await seedRunning(tenant);
      await tenant.runs.awaitApproval(paused.runId, CALL);
      const continuation = crypto.randomUUID();
      const decided = await tenant.runs.create({
        id: continuation,
        sessionId: paused.sessionId,
        engine: 'claude-agent-sdk',
        approvedToolCalls: [CALL],
        decides: { runId: paused.runId },
      });
      expect(decided.kind).toBe('created');
      expect(await deliveriesOf(paused.runId)).toEqual({ [allEvents]: 'run.completed' });
      expect(await deliveriesOf(continuation)).toEqual({});
    });

    it('leaves no delivery when the stop’s transaction rolls back', async () => {
      const paused = await seedRunning(tenant);
      await tenant.runs.awaitApproval(paused.runId, CALL);
      const taken = await seedRunning(tenant);
      // The decision completes the pause, then the continuation's insert collides with an
      // existing run's id: the whole transaction, outbox row included, rolls back.
      const refused = await tenant.runs.create({
        id: taken.runId,
        sessionId: paused.sessionId,
        engine: 'claude-agent-sdk',
        approvedToolCalls: [CALL],
        decides: { runId: paused.runId },
      });
      expect(refused.kind).not.toBe('created');
      expect((await tenant.runs.get(paused.runId))?.status).toBe('awaiting_approval');
      expect(await deliveriesOf(paused.runId)).toEqual({});
    });

    it('writes nothing for a removed webhook, and a remove drops its pending deliveries', async () => {
      const removed = await webhookOf(tenant, ['run.completed']);
      const before = await seedRunning(tenant);
      await tenant.runs.finish(before.runId, 'completed', null);
      expect(Object.keys(await deliveriesOf(before.runId))).toContain(removed);

      expect(await tenant.webhooks.remove(removed)).toBe(true);
      expect(Object.keys(await deliveriesOf(before.runId))).not.toContain(removed);
      const after = await seedRunning(tenant);
      await tenant.runs.finish(after.runId, 'completed', null);
      expect(await deliveriesOf(after.runId)).toEqual({ [allEvents]: 'run.completed' });
    });

    it('refuses a delivery that pairs one workspace with another’s webhook or run', async () => {
      const { runId } = await seedRunning(tenant);
      const insert = (workspaceId: string, webhookId: string, run: string) =>
        isolated.db
          .insert(webhookDeliveries)
          .values({ workspaceId, webhookId, runId: run, eventType: 'run.completed' });
      expect(await violationOf(insert(tenant.workspaceId, otherWebhook, runId))).toContain(
        'webhook_deliveries_webhook_workspace_fk',
      );
      expect(await violationOf(insert(other.workspaceId, otherWebhook, runId))).toContain(
        'webhook_deliveries_run_workspace_fk',
      );
      // The dedup by run: a second row for one (webhook, run) is refused.
      await tenant.runs.finish(runId, 'completed', null);
      expect(await violationOf(insert(tenant.workspaceId, allEvents, runId))).toContain(
        'webhook_deliveries_webhook_run_key',
      );
    });
  });

  describe('claiming and settling', () => {
    /** Claim everything due, so a test starts from an outbox with nothing claimable. */
    async function drain(): Promise<void> {
      for (;;) {
        const claimed = await outbox.claimDue(CLAIM);
        if (claimed.length === 0) return;
        for (const row of claimed)
          await outbox.markFailed(row.id, row.attempt, { statusCode: null, error: 'drained' });
      }
    }

    async function pendingDeliveries(count: number): Promise<string[]> {
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const { runId } = await seedRunning(other);
        await other.runs.finish(runId, 'completed', null);
        expect(await deliveriesOf(runId)).toEqual({ [otherWebhook]: 'run.completed' });
        ids.push(runId);
      }
      return ids;
    }

    it('never lets two concurrent claims take the same row', async () => {
      await drain();
      const runIds = await pendingDeliveries(12);
      const [first, second] = await Promise.all([
        outbox.claimDue({ limit: 8, claimMs: 60_000, maxAttempts: 8 }),
        outbox.claimDue({ limit: 8, claimMs: 60_000, maxAttempts: 8 }),
      ]);
      const firstIds = new Set(first?.map(({ id }) => id));
      const overlap = (second ?? []).filter(({ id }) => firstIds.has(id));
      expect(overlap).toEqual([]);
      const claimed = [...(first ?? []), ...(second ?? [])];
      expect(claimed).toHaveLength(12);
      expect(new Set(claimed.map(({ runId }) => runId))).toEqual(new Set(runIds));
      for (const row of claimed) {
        expect(row).toMatchObject({
          workspaceId: other.workspaceId,
          webhookId: otherWebhook,
          eventType: 'run.completed',
          url: 'https://hooks.example.com/',
          attempt: 1,
        });
      }
      // A claimed row is not due again until its claim lapses.
      await expect(outbox.claimDue(CLAIM)).resolves.toEqual([]);
    });

    it('settles a claim once: a second settle, or a stale claim, changes nothing', async () => {
      await drain();
      await pendingDeliveries(1);
      const [claim] = await outbox.claimDue(CLAIM);
      if (claim === undefined) throw new Error('nothing was claimed');

      await expect(outbox.markDelivered(claim.id, claim.attempt + 1, 200)).resolves.toBe(false);
      await expect(outbox.markDelivered(claim.id, claim.attempt, 204)).resolves.toBe(true);
      await expect(outbox.markDelivered(claim.id, claim.attempt, 200)).resolves.toBe(false);
      await expect(
        outbox.scheduleRetry(claim.id, claim.attempt, new Date(), { statusCode: 500, error: 'x' }),
      ).resolves.toBe(false);
      await expect(
        outbox.markFailed(claim.id, claim.attempt, { statusCode: 500, error: 'x' }),
      ).resolves.toBe(false);
      const [row] = await isolated.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, claim.id));
      expect(row).toMatchObject({ state: 'delivered', lastStatusCode: 204, attempts: 1 });
      expect(row?.deliveredAt).toBeInstanceOf(Date);
      await expect(outbox.claimDue(CLAIM)).resolves.toEqual([]);
    });

    it('retries at the scheduled time, counts each claim, and fails for good', async () => {
      await drain();
      await pendingDeliveries(1);
      const [first] = await outbox.claimDue(CLAIM);
      if (first === undefined) throw new Error('nothing was claimed');
      const past = new Date(Date.now() - 1_000);
      await expect(
        outbox.scheduleRetry(first.id, first.attempt, past, { statusCode: 500, error: 'http_500' }),
      ).resolves.toBe(true);

      const [second] = await outbox.claimDue(CLAIM);
      expect(second?.id).toBe(first.id);
      expect(second?.attempt).toBe(2);
      if (second === undefined) return;
      // The first claim is stale now.
      await expect(outbox.markDelivered(first.id, first.attempt, 200)).resolves.toBe(false);
      await expect(
        outbox.markFailed(second.id, second.attempt, { statusCode: null, error: ' timeout ' }),
      ).resolves.toBe(true);
      const [row] = await isolated.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, first.id));
      expect(row).toMatchObject({ state: 'failed', attempts: 2, lastError: 'timeout' });
      expect(row?.lastAttemptAt).toBeInstanceOf(Date);
      await expect(outbox.claimDue(CLAIM)).resolves.toEqual([]);
    });

    it('defers a claim without counting it, and a lapsed claim becomes due by itself', async () => {
      await drain();
      await pendingDeliveries(1);
      const [claim] = await outbox.claimDue(CLAIM);
      if (claim === undefined) throw new Error('nothing was claimed');
      await expect(
        outbox.deferClaim(claim.id, claim.attempt, new Date(Date.now() - 1_000)),
      ).resolves.toBe(true);
      const [again] = await outbox.claimDue({ limit: 1, claimMs: 1, maxAttempts: 8 });
      expect(again).toMatchObject({ id: claim.id, attempt: 1 });
      // A one-millisecond claim lapses: the row is due again, as after a crash mid-attempt.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const [lapsed] = await outbox.claimDue(CLAIM);
      expect(lapsed).toMatchObject({ id: claim.id, attempt: 2 });
    });

    it('prunes settled deliveries older than the cut-off, never pending ones', async () => {
      await drain();
      await pendingDeliveries(1);
      const settledBefore = await isolated.db
        .select({ value: sql<number>`count(*)::int` })
        .from(webhookDeliveries)
        .where(sql`${webhookDeliveries.state} <> 'pending'`);
      const pruned = await outbox.pruneSettled(new Date(Date.now() + 60_000));
      expect(pruned).toBe(settledBefore[0]?.value);
      const left = await isolated.db
        .select({ state: webhookDeliveries.state })
        .from(webhookDeliveries);
      expect(left.length).toBeGreaterThan(0);
      expect(left.every(({ state }) => state === 'pending')).toBe(true);
    });

    it('never claims a row past the attempt limit, and fails a due one that has used them all', async () => {
      await drain();
      await pendingDeliveries(1);
      const limited = { limit: 100, claimMs: 1, maxAttempts: 2 } as const;
      // Two claims whose attempts lapse without a settle, as when a worker throws or dies mid-attempt.
      const [first] = await outbox.claimDue(limited);
      if (first === undefined) throw new Error('nothing was claimed');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const [second] = await outbox.claimDue(limited);
      expect(second).toMatchObject({ id: first.id, attempt: 2 });
      await new Promise((resolve) => setTimeout(resolve, 20));

      await expect(outbox.claimDue(limited)).resolves.toEqual([]);
      const [row] = await isolated.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, first.id));
      expect(row).toMatchObject({ state: 'failed', attempts: 2, lastError: 'attempts_exhausted' });
      expect(row?.lastAttemptAt).toBeInstanceOf(Date);
      await expect(outbox.claimDue(CLAIM)).resolves.toEqual([]);
    });

    it('leaves an in-flight last attempt alone until its claim lapses', async () => {
      await drain();
      await pendingDeliveries(1);
      const [only] = await outbox.claimDue({ ...CLAIM, maxAttempts: 1 });
      if (only === undefined) throw new Error('nothing was claimed');
      await expect(outbox.claimDue({ ...CLAIM, maxAttempts: 1 })).resolves.toEqual([]);
      await expect(outbox.markDelivered(only.id, only.attempt, 200)).resolves.toBe(true);
    });

    it('refuses a non-positive limit, claim length or attempt limit', async () => {
      await expect(outbox.claimDue({ limit: 0, claimMs: 1, maxAttempts: 1 })).rejects.toThrow(
        /limit/u,
      );
      await expect(outbox.claimDue({ limit: 1, claimMs: 0.5, maxAttempts: 1 })).rejects.toThrow(
        /claimMs/u,
      );
      await expect(outbox.claimDue({ limit: 1, claimMs: 1, maxAttempts: 0 })).rejects.toThrow(
        /maxAttempts/u,
      );
    });
  });
});
