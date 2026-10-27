/**
 * The `awaiting_approval` run status against a real PostgreSQL (P5-2, ADR-0145 D1).
 *
 * A paused run has stopped: it has an end time, its tokens are revoked, and it neither keeps its
 * session busy nor counts as in flight. It leaves the pause only by a decision (`completed` or
 * `cancelled`), exactly once, and never back to `running`.
 */
import crypto from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { runStatuses } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseRunTokenRepositoryProvider } from './run-tokens.js';
import {
  createDatabaseRunEventRepositoryProvider,
  createDatabaseRunRepositoryProvider,
  listStaleRunIds,
  type RunRepository,
} from './runs.js';
import { parseApprovalCall, parseApprovalCalls, runStatusesThatMayMoveTo } from './runs/rows.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createDatabaseShareRepositoryProvider } from './shares.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/runs-approval.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

const CALL = { toolName: 'send_email', canonicalCall: '{"to":"a@example.test"}' } as const;

describe('runStatusesThatMayMoveTo', () => {
  it('is the transition table, and no status moves to itself', () => {
    const table: Record<(typeof runStatuses)[number], readonly string[]> = {
      queued: [],
      running: ['queued'],
      awaiting_approval: ['running'],
      completed: ['queued', 'running', 'awaiting_approval'],
      cancelled: ['queued', 'running', 'awaiting_approval'],
      failed: ['queued', 'running'],
    };
    for (const to of runStatuses) {
      expect([...runStatusesThatMayMoveTo(to)]).toEqual(table[to]);
      expect(runStatusesThatMayMoveTo(to)).not.toContain(to);
    }
  });
});

describe('the approval call shape', () => {
  it.each([
    ['an empty tool name', { toolName: '', canonicalCall: '{}' }],
    ['an empty call', { toolName: 'send_email', canonicalCall: '' }],
    ['a missing call', { toolName: 'send_email' }],
    ['an unknown key', { toolName: 'send_email', canonicalCall: '{}', extra: 1 }],
    ['a non-object', 'send_email'],
    ['null', null],
    ['an array', []],
  ])('rejects %s', (_label, value) => {
    expect(() => parseApprovalCall(value)).toThrow(/approval call/u);
  });

  it('accepts exactly a tool name and a canonical call, and a list of them', () => {
    expect(parseApprovalCall(CALL)).toEqual(CALL);
    expect(parseApprovalCalls([CALL, CALL])).toEqual([CALL, CALL]);
    expect(() => parseApprovalCalls(CALL)).toThrow(/array/u);
  });
});

describe.skipIf(!hasDatabase)('the awaiting_approval run status against PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let scope: WorkspaceScope;
  let repository: RunRepository;
  let userId: string;
  let principalId: string;
  let agentId: string;
  const workspaceId = crypto.randomUUID();

  async function seedSession(): Promise<string> {
    const id = crypto.randomUUID();
    await isolated.db
      .insert(sessions)
      .values({ id, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    return id;
  }

  /** A running run in a fresh session. */
  async function seedRunning(): Promise<{ runId: string; sessionId: string }> {
    const sessionId = await seedSession();
    const runId = crypto.randomUUID();
    const created = await repository.create({ id: runId, sessionId, engine: 'claude-agent-sdk' });
    expect(created.kind).toBe('created');
    expect((await repository.markRunning(runId)).kind).toBe('moved');
    return { runId, sessionId };
  }

  async function seedPaused(): Promise<{ runId: string; sessionId: string }> {
    const seeded = await seedRunning();
    expect((await repository.awaitApproval(seeded.runId, CALL)).kind).toBe('moved');
    return seeded;
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_runs_approval');
    userId = crypto.randomUUID();
    principalId = crypto.randomUUID();
    agentId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Approvals' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Approval agent',
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
    const resolved = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (resolved === null) throw new Error('fixture workspace did not resolve');
    scope = resolved;
    repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
  }, 180_000);

  afterAll(async () => isolated.close());

  it('pauses a running run: ended, the call stored, its tokens revoked', async () => {
    const { runId } = await seedRunning();
    const tokens = createDatabaseRunTokenRepositoryProvider(isolated.db).forScope(scope);
    const tokenId = crypto.randomUUID();
    const tokenHash = 'b'.repeat(64);
    await tokens.register({
      id: tokenId,
      runId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(tokens.isActive(tokenId, runId, tokenHash)).resolves.toBe(true);

    const outcome = await repository.awaitApproval(runId, CALL);

    expect(outcome.kind).toBe('moved');
    if (outcome.kind !== 'moved') return;
    expect(outcome.run.status).toBe('awaiting_approval');
    expect(outcome.run.endedAt).toBeInstanceOf(Date);
    expect(outcome.run.pendingApproval).toEqual(CALL);
    await expect(tokens.isActive(tokenId, runId, tokenHash)).resolves.toBe(false);
  });

  it('pauses only a running run', async () => {
    const sessionId = await seedSession();
    const queuedId = crypto.randomUUID();
    await repository.create({ id: queuedId, sessionId, engine: 'claude-agent-sdk' });
    expect((await repository.awaitApproval(queuedId, CALL)).kind).toBe('no-op');

    const { runId: pausedId } = await seedPaused();
    expect((await repository.awaitApproval(pausedId, CALL)).kind).toBe('no-op');

    const { runId: doneId } = await seedRunning();
    await repository.finish(doneId, 'completed', null);
    expect((await repository.awaitApproval(doneId, CALL)).kind).toBe('no-op');

    expect((await repository.awaitApproval(crypto.randomUUID(), CALL)).kind).toBe('not-found');
    expect((await repository.get(queuedId))?.status).toBe('queued');
  });

  it('leaves the pause by one decision, keeping the end time of the pause', async () => {
    const { runId } = await seedPaused();
    const paused = await repository.get(runId);

    const first = await repository.finish(runId, 'completed', null);
    expect(first.kind).toBe('moved');
    if (first.kind !== 'moved') return;
    expect(first.run.status).toBe('completed');
    expect(first.run.endedAt).toEqual(paused?.endedAt);
    expect(first.run.pendingApproval).toEqual(CALL);

    // The compare-and-set of ADR-0145 D2.3: the second decision finds nothing to move.
    expect((await repository.finish(runId, 'completed', null)).kind).toBe('no-op');
    expect((await repository.finish(runId, 'cancelled', null)).kind).toBe('no-op');
  });

  it('can be cancelled out of the pause, but not failed or restarted', async () => {
    const cancelled = await seedPaused();
    expect((await repository.finish(cancelled.runId, 'cancelled', null)).kind).toBe('moved');

    const failed = await seedPaused();
    expect((await repository.finish(failed.runId, 'failed', 'boom')).kind).toBe('no-op');
    expect((await repository.markRunning(failed.runId)).kind).toBe('no-op');
    expect((await repository.get(failed.runId))?.status).toBe('awaiting_approval');
  });

  it('does not keep the session busy, while a running run still does', async () => {
    const paused = await seedPaused();
    const approved = [CALL];
    const next = await repository.create({
      id: crypto.randomUUID(),
      sessionId: paused.sessionId,
      engine: 'claude-agent-sdk',
      approvedToolCalls: approved,
    });
    expect(next.kind).toBe('created');
    if (next.kind !== 'created') return;
    expect(next.run.approvedToolCalls).toEqual(approved);
    expect(next.run.pendingApproval).toBeNull();

    const running = await seedRunning();
    const busy = await repository.create({
      id: crypto.randomUUID(),
      sessionId: running.sessionId,
      engine: 'claude-agent-sdk',
    });
    expect(busy.kind).toBe('session-busy');
  });

  it('defaults the approved calls to none', async () => {
    const created = await repository.create({
      id: crypto.randomUUID(),
      sessionId: await seedSession(),
      engine: 'claude-agent-sdk',
    });
    expect(created.kind === 'created' && created.run.approvedToolCalls).toEqual([]);
  });

  it('is not swept as stale', async () => {
    const paused = await seedPaused();
    const running = await seedRunning();
    const future = new Date(Date.now() + 3_600_000);

    const stale = await listStaleRunIds(isolated.db, future, 1_000);

    expect(stale).toContain(running.runId);
    expect(stale).not.toContain(paused.runId);
  });

  it('takes no event after the pause, while a running run still does', async () => {
    const events = createDatabaseRunEventRepositoryProvider(isolated.db).forScope(scope);
    const paused = await seedPaused();
    const running = await seedRunning();

    await expect(events.append(paused.runId, 'x', {}, 100)).resolves.toBeNull();
    await expect(events.append(running.runId, 'x', {}, 100)).resolves.not.toBeNull();
  });

  it('refuses an empty call before any SQL', async () => {
    const { runId } = await seedRunning();
    const empty = { toolName: '', canonicalCall: '{}' };
    await expect(repository.awaitApproval(runId, empty)).rejects.toThrow(/approval call/u);
    await expect(
      repository.create({
        id: crypto.randomUUID(),
        sessionId: await seedSession(),
        engine: 'claude-agent-sdk',
        approvedToolCalls: [empty],
      }),
    ).rejects.toThrow(/approval call/u);
    expect((await repository.get(runId))?.status).toBe('running');
  });

  it('refuses a malformed stored call when the row is read', async () => {
    const { runId } = await seedPaused();
    await isolated.db.execute(
      sql`update runs set pending_approval = '{"toolName":"x"}'::jsonb where id = ${runId}`,
    );
    await expect(repository.get(runId)).rejects.toThrow(/approval call/u);
  });

  it('is held by the database: no pause without a call, no pause without an end time', async () => {
    const { runId } = await seedRunning();
    const violation = async (statement: ReturnType<typeof sql>): Promise<string> => {
      try {
        await isolated.db.execute(statement);
      } catch (error) {
        return error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
      }
      return 'accepted';
    };
    expect(
      await violation(
        sql`update runs set status = 'awaiting_approval', ended_at = now(), approval_deadline_at = now() where id = ${runId}`,
      ),
    ).toContain('runs_awaiting_approval_has_pending');
    expect(
      await violation(
        sql`update runs set status = 'awaiting_approval', pending_approval = '{}'::jsonb, approval_deadline_at = now() where id = ${runId}`,
      ),
    ).toContain('runs_ended_at_iff_terminal');
    expect(
      await violation(
        sql`update runs set status = 'awaiting_approval', pending_approval = '{}'::jsonb, ended_at = now() where id = ${runId}`,
      ),
    ).toContain('runs_awaiting_approval_has_deadline');
    expect(await violation(sql`update runs set status = 'paused' where id = ${runId}`)).toContain(
      'runs_status_valid',
    );
  });

  // ADR-0151, RF-303: an approval is consumed in the commit that takes its continuation out of
  // `queued`, before the runner is sent anything, and that continuation can never be queued again.
  it('consumes a continuation’s approvals durably when it starts, and never requeues it', async () => {
    const paused = await seedPaused();
    const continuationId = crypto.randomUUID();
    await repository.create({
      id: continuationId,
      sessionId: paused.sessionId,
      engine: 'claude-agent-sdk',
      approvedToolCalls: [CALL],
    });
    expect((await repository.get(continuationId))?.approvalsConsumedAt).toBeNull();

    const started = await repository.markRunning(continuationId);

    expect(started.kind).toBe('moved');
    if (started.kind !== 'moved') return;
    expect(started.run.approvalsConsumedAt).toBeInstanceOf(Date);
    expect(started.run.approvalsConsumedAt).toEqual(started.run.startedAt);
    // A second acceptance (a retried launch) finds nothing to move.
    expect((await repository.markRunning(continuationId)).kind).toBe('no-op');
    await expect(
      isolated.db.execute(sql`update runs set status = 'queued' where id = ${continuationId}`),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message.includes('runs_consumed_approvals_never_queued'),
    );
  });

  it('stamps no consumption on a run that carries no approval', async () => {
    const { runId } = await seedRunning();
    expect((await repository.get(runId))?.approvalsConsumedAt).toBeNull();
  });

  // ADR-0145 D2.1, #1541: an approved call is good for one use, however many callers race for it.
  describe('consuming an approved call', () => {
    const OTHER = { toolName: 'send_email', canonicalCall: '{"to":"b@example.test"}' } as const;

    async function seedApproved(): Promise<string> {
      const runId = crypto.randomUUID();
      await repository.create({
        id: runId,
        sessionId: await seedSession(),
        engine: 'claude-agent-sdk',
        approvedToolCalls: [CALL],
      });
      expect((await repository.markRunning(runId)).kind).toBe('moved');
      return runId;
    }

    it('consumes on first use and refuses the second', async () => {
      const runId = await seedApproved();

      await expect(repository.consumeApprovedCall(runId, CALL)).resolves.toBe('consumed');
      await expect(repository.consumeApprovedCall(runId, CALL)).resolves.toBe('already-used');

      expect((await repository.get(runId))?.consumedToolCalls).toEqual([CALL]);
    });

    it('gives exactly one of many parallel callers the approval', async () => {
      const runId = await seedApproved();

      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => repository.consumeApprovedCall(runId, CALL)),
      );

      expect(outcomes.filter((outcome) => outcome === 'consumed')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'already-used')).toHaveLength(7);
      expect((await repository.get(runId))?.consumedToolCalls).toEqual([CALL]);
    });

    it('refuses a call that was not approved, and consumes nothing', async () => {
      const runId = await seedApproved();

      await expect(repository.consumeApprovedCall(runId, OTHER)).resolves.toBe('not-approved');

      expect((await repository.get(runId))?.consumedToolCalls).toEqual([]);
      await expect(repository.consumeApprovedCall(runId, CALL)).resolves.toBe('consumed');
    });

    it('refuses a run that is not running, or does not exist', async () => {
      const queuedId = crypto.randomUUID();
      await repository.create({
        id: queuedId,
        sessionId: await seedSession(),
        engine: 'claude-agent-sdk',
        approvedToolCalls: [CALL],
      });
      await expect(repository.consumeApprovedCall(queuedId, CALL)).resolves.toBe('not-approved');

      const doneId = await seedApproved();
      await repository.finish(doneId, 'completed', null);
      await expect(repository.consumeApprovedCall(doneId, CALL)).resolves.toBe('not-approved');

      await expect(repository.consumeApprovedCall(crypto.randomUUID(), CALL)).resolves.toBe(
        'not-approved',
      );
    });

    it('refuses another workspace’s scope', async () => {
      const runId = await seedApproved();
      const otherWorkspaceId = crypto.randomUUID();
      await isolated.db
        .insert(workspaces)
        .values({ id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Elsewhere' });
      const otherScope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
        otherWorkspaceId,
      );
      if (otherScope === null) throw new Error('fixture workspace did not resolve');
      const other = createDatabaseRunRepositoryProvider(isolated.db).forScope(otherScope);

      await expect(other.consumeApprovedCall(runId, CALL)).resolves.toBe('not-approved');

      expect((await repository.get(runId))?.consumedToolCalls).toEqual([]);
    });

    it('refuses a malformed call before any SQL', async () => {
      const runId = await seedApproved();
      await expect(
        repository.consumeApprovedCall(runId, { toolName: '', canonicalCall: '{}' }),
      ).rejects.toThrow(/approval call/u);
    });

    it('defaults to none consumed', async () => {
      const { runId } = await seedRunning();
      expect((await repository.get(runId))?.consumedToolCalls).toEqual([]);
    });
  });

  describe('the start idempotency key (ADR-0151, #250)', () => {
    const key = (): { principalId: string; key: string; requestHash: string } => ({
      principalId,
      key: crypto.randomUUID(),
      requestHash: 'a'.repeat(64),
    });

    it('is found again with its request hash, and holds across a pause', async () => {
      const idempotency = key();
      const sessionId = await seedSession();
      const runId = crypto.randomUUID();
      await repository.create({ id: runId, sessionId, engine: 'claude-agent-sdk', idempotency });
      await repository.markRunning(runId);
      await repository.awaitApproval(runId, CALL);

      const found = await repository.findByIdempotencyKey(principalId, idempotency.key);

      expect(found?.run.id).toBe(runId);
      expect(found?.run.status).toBe('awaiting_approval');
      expect(found?.requestHash).toBe(idempotency.requestHash);
      // The pause frees the session, never the key.
      const again = await repository.create({
        id: crypto.randomUUID(),
        sessionId,
        engine: 'claude-agent-sdk',
        idempotency,
      });
      expect(again).toEqual({ kind: 'idempotency-key-taken', key: idempotency.key });
    });

    it('is scoped to the principal', async () => {
      const idempotency = key();
      await repository.create({
        id: crypto.randomUUID(),
        sessionId: await seedSession(),
        engine: 'claude-agent-sdk',
        idempotency,
      });
      await expect(
        repository.findByIdempotencyKey(crypto.randomUUID(), idempotency.key),
      ).resolves.toBeNull();
      const other = await repository.create({
        id: crypto.randomUUID(),
        sessionId: await seedSession(),
        engine: 'claude-agent-sdk',
        idempotency: { ...idempotency, principalId: crypto.randomUUID() },
      });
      expect(other.kind).toBe('created');
    });

    it('is held by the database: a key always has its hash', async () => {
      const { runId } = await seedRunning();
      await expect(
        isolated.db.execute(sql`update runs set idempotency_key = 'k' where id = ${runId}`),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof Error &&
          error.cause instanceof Error &&
          error.cause.message.includes('runs_idempotency_key_has_hash'),
      );
    });
  });

  describe('a decision that creates the continuation (ADR-0145 D2.3)', () => {
    const decide = (paused: { runId: string; sessionId: string }, id = crypto.randomUUID()) =>
      repository.create({
        id,
        sessionId: paused.sessionId,
        engine: 'claude-agent-sdk',
        prompt: 'approved',
        approvedToolCalls: [CALL],
        decides: { runId: paused.runId },
      });

    it('completes the paused run and inserts the continuation together', async () => {
      const paused = await seedPaused();

      const outcome = await decide(paused);

      expect(outcome.kind).toBe('created');
      expect((await repository.get(paused.runId))?.status).toBe('completed');
      if (outcome.kind !== 'created') return;
      expect(outcome.run.status).toBe('queued');
      expect(outcome.run.approvedToolCalls).toEqual([CALL]);
    });

    it('stamps the deadline 24 hours after the pause, and keeps it once decided', async () => {
      const paused = await seedPaused();
      const stamped = async (): Promise<unknown> =>
        (
          await isolated.db.execute(
            sql`select approval_deadline_at = ended_at + interval '24 hours' as exact from runs where id = ${paused.runId}`,
          )
        ).rows[0]?.['exact'];
      expect(await stamped()).toBe(true);

      expect((await decide(paused)).kind).toBe('created');
      expect(await stamped()).toBe(true);
    });

    it('records which run a continuation continues, and gives a paused run only one', async () => {
      const paused = await seedPaused();
      const outcome = await decide(paused);
      expect(outcome.kind).toBe('created');
      if (outcome.kind !== 'created') return;
      const continues = await isolated.db.execute(
        sql`select continues_run_id from runs where id = ${outcome.run.id}`,
      );
      expect(continues.rows[0]?.['continues_run_id']).toBe(paused.runId);

      // Only the index stands in the way now: the paused run is forced back to waiting and the
      // continuation finished, so neither the status guard nor the busy check refuses.
      await isolated.db.execute(
        sql`update runs set status = 'cancelled', ended_at = now() where id = ${outcome.run.id}`,
      );
      await isolated.db.execute(
        sql`update runs set status = 'awaiting_approval' where id = ${paused.runId}`,
      );
      const id = crypto.randomUUID();

      expect(await decide(paused, id)).toEqual({ kind: 'already-decided', runId: paused.runId });
      expect(await repository.get(id)).toBeNull();
      expect((await repository.get(paused.runId))?.status).toBe('awaiting_approval');
    });

    it('refuses a continuation of another workspace’s run', async () => {
      const otherWorkspace = crypto.randomUUID();
      const otherMembership = crypto.randomUUID();
      const otherPrincipal = crypto.randomUUID();
      const otherAgent = crypto.randomUUID();
      const otherSession = crypto.randomUUID();
      const otherRun = crypto.randomUUID();
      await isolated.db
        .insert(workspaces)
        .values({ id: otherWorkspace, slug: otherWorkspace, name: 'Elsewhere' });
      await isolated.db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({ id: otherMembership, workspaceId: otherWorkspace, userId, role: 'owner' });
        await tx.insert(workspacePrincipals).values({
          id: otherPrincipal,
          workspaceId: otherWorkspace,
          kind: 'membership',
          membershipId: otherMembership,
        });
      });
      await isolated.db.insert(agents).values({
        id: otherAgent,
        workspaceId: otherWorkspace,
        name: 'Elsewhere agent',
        instructions: '',
        ownerPrincipalId: otherPrincipal,
        createdBy: userId,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      });
      await isolated.db.insert(sessions).values({
        id: otherSession,
        workspaceId: otherWorkspace,
        userId,
        ownerPrincipalId: otherPrincipal,
        agentId: otherAgent,
      });
      await isolated.db.execute(
        sql`insert into runs (id, workspace_id, session_id) values (${otherRun}, ${otherWorkspace}, ${otherSession})`,
      );
      const { runId } = await seedRunning();

      await expect(
        isolated.db.execute(
          sql`update runs set continues_run_id = ${otherRun} where id = ${runId}`,
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof Error &&
          error.cause instanceof Error &&
          error.cause.message.includes('runs_continues_run_workspace_fk'),
      );
    });

    it('lets a session holding a paused run and its continuation be deleted', async () => {
      const paused = await seedPaused();
      const outcome = await decide(paused);
      expect(outcome.kind).toBe('created');
      if (outcome.kind !== 'created') return;

      // The self-reference has no delete action; the session's cascade removes both runs at once.
      await isolated.db.execute(sql`delete from sessions where id = ${paused.sessionId}`);

      expect(await repository.get(paused.runId)).toBeNull();
      expect(await repository.get(outcome.run.id)).toBeNull();
    });

    it('lets exactly one of two concurrent decisions win', async () => {
      const paused = await seedPaused();

      const outcomes = await Promise.all([decide(paused), decide(paused), decide(paused)]);

      expect(outcomes.filter((o) => o.kind === 'created')).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === 'already-decided')).toHaveLength(2);
    });

    it('answers already-decided, creating nothing, for a run that is not paused', async () => {
      const running = await seedRunning();
      const id = crypto.randomUUID();

      expect((await decide(running, id)).kind).toBe('already-decided');

      expect(await repository.get(id)).toBeNull();
      expect((await repository.get(running.runId))?.status).toBe('running');
    });

    it('answers already-decided for a run of another session', async () => {
      const paused = await seedPaused();
      const other = await seedSession();

      const outcome = await decide({ runId: paused.runId, sessionId: other });

      expect(outcome.kind).toBe('already-decided');
      expect((await repository.get(paused.runId))?.status).toBe('awaiting_approval');
    });

    it('leaves the pause untouched when the session is busy', async () => {
      const paused = await seedPaused();
      const sibling = await repository.create({
        id: crypto.randomUUID(),
        sessionId: paused.sessionId,
        engine: 'claude-agent-sdk',
      });
      expect(sibling.kind).toBe('created');

      expect((await decide(paused)).kind).toBe('session-busy');
      expect((await repository.get(paused.runId))?.status).toBe('awaiting_approval');
    });

    it('cancels a pause older than 24 hours and creates no continuation', async () => {
      const paused = await seedPaused();
      await isolated.db.execute(
        sql`update runs set approval_deadline_at = now() - interval '1 hour' where id = ${paused.runId}`,
      );
      const id = crypto.randomUUID();

      const outcome = await decide(paused, id);

      expect(outcome.kind).toBe('approval-expired');
      expect(await repository.get(id)).toBeNull();
      const run = await repository.get(paused.runId);
      expect(run?.status).toBe('cancelled');
      expect(run?.error).toMatch(/^approval_expired/u);
    });

    it('still honours a pause just inside the window', async () => {
      const paused = await seedPaused();
      await isolated.db.execute(
        sql`update runs set approval_deadline_at = now() + interval '1 hour' where id = ${paused.runId}`,
      );

      expect((await decide(paused)).kind).toBe('created');
    });
  });

  it('writes the run.status event when it pauses a run, when asked', async () => {
    const seeded = await seedRunning();

    await repository.awaitApproval(seeded.runId, CALL, 100);

    const rows = await isolated.db.execute(
      sql`select type, data from run_events where run_id = ${seeded.runId} order by sequence`,
    );
    expect(rows.rows).toEqual([
      { type: 'run.status', data: { status: 'awaiting_approval', error: null } },
    ]);
  });

  it('does not count a paused run as in flight for a public link', async () => {
    const shares = createDatabaseShareRepositoryProvider(isolated.db).forScope(scope);
    const share = await shares.create({
      token: 'pub_paused_run',
      subjectType: 'agent',
      subjectId: 'agent-1',
      subjectLabel: 'Runnable agent',
      visibility: 'public',
      include: {},
      mode: 'runnable',
      snapshot: null,
      budgetCapUsd: '20.0000',
      expiresAt: null,
      passphraseHash: null,
      publisherPrincipalId: principalId,
      createdBy: userId,
    });
    const linked: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { runId } = await seedRunning();
      expect((await shares.linkRun(share.id, runId, new Date())).kind).not.toBe('unavailable');
      linked.push(runId);
    }
    const reserve = () =>
      shares.reserveVisitorMessage({
        id: share.id,
        visitorKey: 'v1_paused_run',
        windowStartedAt: new Date(Date.now() - 3_600_000),
        now: new Date(),
        limit: 100,
      });
    expect((await reserve()).kind).toBe('busy');

    const first = linked[0];
    if (first === undefined) throw new Error('no linked run');
    await repository.awaitApproval(first, CALL);

    expect((await reserve()).kind).toBe('reserved');
  });
});
