import crypto from 'node:crypto';

import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { createDatabaseRunTokenRepositoryProvider } from './run-tokens.js';
import {
  createDatabaseRunEventRepositoryProvider,
  listExpiredApprovalRunIds,
  listStaleRunIds,
} from './runs.js';
import { CALL, type RunsApprovalFixture } from './runs-approval.fixture.test-support.js';
import { createDatabaseShareRepositoryProvider } from './shares.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
/** The page size the sweeps are asked for; far above the few runs a test seeds. */
const SWEEP_LIMIT = 1_000;
/** Past the approval deadline a paused run is given (ADR-0145 D2.4). */
const PAST_APPROVAL_DEADLINE_HOURS = 25;

/** Creates a run on `sessionId` through the repository; `extra` adds the fields a case cares about. */
function createRun(
  fixture: RunsApprovalFixture,
  sessionId: string,
  extra: {
    readonly approvedToolCalls?: readonly { toolName: string; canonicalCall: string }[];
    readonly id?: string;
  } = {},
) {
  return fixture.repository.create({
    id: extra.id ?? crypto.randomUUID(),
    sessionId,
    engine: 'claude-agent-sdk',
    ...(extra.approvedToolCalls === undefined
      ? {}
      : { approvedToolCalls: extra.approvedToolCalls }),
  });
}

/**
 * What the database answers to `statement`: the message of the constraint it violates, or
 * `accepted` when it holds.
 */
async function constraintViolation(
  fixture: RunsApprovalFixture,
  statement: ReturnType<typeof sql>,
): Promise<string> {
  try {
    await fixture.isolated.db.execute(statement);
  } catch (error) {
    return error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  }
  return 'accepted';
}

function pausingCases(fixture: RunsApprovalFixture): void {
  const { seedSession, seedRunning, seedPaused } = fixture;

  it('pauses a running run: ended, the call stored, its tokens revoked', async () => {
    const { runId } = await seedRunning();
    const tokens = createDatabaseRunTokenRepositoryProvider(fixture.isolated.db).forScope(
      fixture.scope,
    );
    const tokenId = crypto.randomUUID();
    const tokenHash = 'b'.repeat(64);
    await tokens.register({
      id: tokenId,
      runId,
      tokenHash,
      expiresAt: new Date(Date.now() + MS_PER_MINUTE),
    });
    await expect(tokens.isActive(tokenId, runId, tokenHash)).resolves.toBe(true);

    const outcome = await fixture.repository.awaitApproval(runId, CALL);

    expect(outcome.kind).toBe('moved');
    if (outcome.kind !== 'moved') return;
    expect(outcome.run.status).toBe('awaiting_approval');
    expect(outcome.run.endedAt).toBeInstanceOf(Date);
    expect(outcome.run.pendingApproval).toEqual(CALL);
    await expect(tokens.isActive(tokenId, runId, tokenHash)).resolves.toBe(false);
  });

  it('pauses only a running run', async () => {
    const { repository } = fixture;
    const sessionId = await seedSession();
    const queuedId = crypto.randomUUID();
    await createRun(fixture, sessionId, { id: queuedId });
    expect((await repository.awaitApproval(queuedId, CALL)).kind).toBe('no-op');

    const { runId: pausedId } = await seedPaused();
    expect((await repository.awaitApproval(pausedId, CALL)).kind).toBe('no-op');

    const { runId: doneId } = await seedRunning();
    await repository.finish(doneId, 'completed', null);
    expect((await repository.awaitApproval(doneId, CALL)).kind).toBe('no-op');

    expect((await repository.awaitApproval(crypto.randomUUID(), CALL)).kind).toBe('not-found');
    expect((await repository.get(queuedId))?.status).toBe('queued');
  });
}

function leavingCases(fixture: RunsApprovalFixture): void {
  const { seedPaused } = fixture;

  it('leaves the pause by one decision, keeping the end time of the pause', async () => {
    const { repository } = fixture;
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
    const { repository } = fixture;
    const cancelled = await seedPaused();
    expect((await repository.finish(cancelled.runId, 'cancelled', null)).kind).toBe('moved');

    const failed = await seedPaused();
    expect((await repository.finish(failed.runId, 'failed', 'boom')).kind).toBe('no-op');
    expect((await repository.markRunning(failed.runId)).kind).toBe('no-op');
    expect((await repository.get(failed.runId))?.status).toBe('awaiting_approval');
  });
}

/** What a paused run no longer holds in its session: the busy mark, and nothing carried over. */
function sessionCases(fixture: RunsApprovalFixture): void {
  const { seedSession, seedRunning, seedPaused } = fixture;

  it('does not keep the session busy, while a running run still does', async () => {
    const paused = await seedPaused();
    const approved = [CALL];
    const next = await createRun(fixture, paused.sessionId, { approvedToolCalls: approved });
    expect(next.kind).toBe('created');
    if (next.kind !== 'created') return;
    expect(next.run.approvedToolCalls).toEqual(approved);
    expect(next.run.pendingApproval).toBeNull();

    const running = await seedRunning();
    const busy = await createRun(fixture, running.sessionId);
    expect(busy.kind).toBe('session-busy');
  });

  it('defaults the approved calls to none', async () => {
    const created = await createRun(fixture, await seedSession());
    expect(created.kind === 'created' && created.run.approvedToolCalls).toEqual([]);
  });
}

/** What the sweeps and the event log make of a paused run. */
function sweepCases(fixture: RunsApprovalFixture): void {
  const { seedRunning, seedPaused } = fixture;

  it('is not swept as stale', async () => {
    const paused = await seedPaused();
    const running = await seedRunning();
    const future = new Date(Date.now() + MS_PER_HOUR);

    const stale = await listStaleRunIds(fixture.isolated.db, future, SWEEP_LIMIT);

    expect(stale).toContain(running.runId);
    expect(stale).not.toContain(paused.runId);
  });

  it('lists a paused run only once its approval deadline has passed (ADR-0145 D2.4)', async () => {
    const paused = await seedPaused();
    const running = await seedRunning();
    const { db } = fixture.isolated;

    const beforeDeadline = await listExpiredApprovalRunIds(db, new Date(), SWEEP_LIMIT);
    expect(beforeDeadline).not.toContain(paused.runId);

    const pastDeadline = new Date(Date.now() + PAST_APPROVAL_DEADLINE_HOURS * MS_PER_HOUR);
    const expired = await listExpiredApprovalRunIds(db, pastDeadline, SWEEP_LIMIT);
    expect(expired).toContain(paused.runId);
    expect(expired).not.toContain(running.runId);

    await fixture.repository.finish(paused.runId, 'cancelled', 'approval_expired');
    expect(await listExpiredApprovalRunIds(db, pastDeadline, SWEEP_LIMIT)).not.toContain(
      paused.runId,
    );
  });

  it('takes no event after the pause, while a running run still does', async () => {
    const events = createDatabaseRunEventRepositoryProvider(fixture.isolated.db).forScope(
      fixture.scope,
    );
    const paused = await seedPaused();
    const running = await seedRunning();

    await expect(events.append(paused.runId, 'x', {}, 100)).resolves.toBeNull();
    await expect(events.append(running.runId, 'x', {}, 100)).resolves.not.toBeNull();
  });
}

function guardCases(fixture: RunsApprovalFixture): void {
  const { seedSession, seedRunning, seedPaused } = fixture;

  it('refuses an empty call before any SQL', async () => {
    const { repository } = fixture;
    const { runId } = await seedRunning();
    const empty = { toolName: '', canonicalCall: '{}' };
    await expect(repository.awaitApproval(runId, empty)).rejects.toThrow(/approval call/u);
    await expect(
      createRun(fixture, await seedSession(), { approvedToolCalls: [empty] }),
    ).rejects.toThrow(/approval call/u);
    expect((await repository.get(runId))?.status).toBe('running');
  });

  it('refuses a malformed stored call when the row is read', async () => {
    const { runId } = await seedPaused();
    await fixture.isolated.db.execute(
      sql`update runs set pending_approval = '{"toolName":"x"}'::jsonb where id = ${runId}`,
    );
    await expect(fixture.repository.get(runId)).rejects.toThrow(/approval call/u);
  });

  it('is held by the database: no pause without a call, no pause without an end time', async () => {
    const { runId } = await seedRunning();
    const violation = (statement: ReturnType<typeof sql>) =>
      constraintViolation(fixture, statement);
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
}

function consumedApprovalCases(fixture: RunsApprovalFixture): void {
  // ADR-0151, RF-303: an approval is consumed in the commit that takes its continuation out of
  // `queued`, before the runner is sent anything, and that continuation can never be queued again.
  it('consumes a continuation’s approvals durably when it starts, and never requeues it', async () => {
    const { repository } = fixture;
    const paused = await fixture.seedPaused();
    const continuationId = crypto.randomUUID();
    await createRun(fixture, paused.sessionId, { id: continuationId, approvedToolCalls: [CALL] });
    expect((await repository.get(continuationId))?.approvalsConsumedAt).toBeNull();

    const started = await repository.markRunning(continuationId);

    expect(started.kind).toBe('moved');
    if (started.kind !== 'moved') return;
    expect(started.run.approvalsConsumedAt).toBeInstanceOf(Date);
    expect(started.run.approvalsConsumedAt).toEqual(started.run.startedAt);
    // A second acceptance (a retried launch) finds nothing to move.
    expect((await repository.markRunning(continuationId)).kind).toBe('no-op');
    await expect(
      fixture.isolated.db.execute(
        sql`update runs set status = 'queued' where id = ${continuationId}`,
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message.includes('runs_consumed_approvals_never_queued'),
    );
  });

  it('stamps no consumption on a run that carries no approval', async () => {
    const { runId } = await fixture.seedRunning();
    expect((await fixture.repository.get(runId))?.approvalsConsumedAt).toBeNull();
  });
}

/** The pause itself: entering it, leaving it, and what a paused run no longer holds. */
export function registerPauseCases(fixture: RunsApprovalFixture): void {
  pausingCases(fixture);
  leavingCases(fixture);
  sessionCases(fixture);
  sweepCases(fixture);
  guardCases(fixture);
  consumedApprovalCases(fixture);
}

/** The run.status event and the public-link in-flight count a pause changes. */
export function registerPauseEventCases(fixture: RunsApprovalFixture): void {
  it('writes the run.status event when it pauses a run, when asked', async () => {
    const seeded = await fixture.seedRunning();

    await fixture.repository.awaitApproval(seeded.runId, CALL, 100);

    const rows = await fixture.isolated.db.execute(
      sql`select type, data from run_events where run_id = ${seeded.runId} order by sequence`,
    );
    expect(rows.rows).toEqual([
      { type: 'run.status', data: { status: 'awaiting_approval', error: null } },
    ]);
  });

  it('does not count a paused run as in flight for a public link', async () => {
    const shares = createDatabaseShareRepositoryProvider(fixture.isolated.db).forScope(
      fixture.scope,
    );
    const share = await shares.create({
      tokenHash: 'pub_paused_run',
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
      publisherPrincipalId: fixture.principalId,
      createdBy: fixture.userId,
    });
    const linked: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { runId } = await fixture.seedRunning();
      expect((await shares.linkRun(share.id, runId, new Date())).kind).not.toBe('unavailable');
      linked.push(runId);
    }
    const reserve = () =>
      shares.reserveVisitorMessage({
        id: share.id,
        visitorKey: 'v1_paused_run',
        windowStartedAt: new Date(Date.now() - MS_PER_HOUR),
        now: new Date(),
        limit: 100,
      });
    expect((await reserve()).kind).toBe('busy');

    const first = linked[0];
    if (first === undefined) throw new Error('no linked run');
    await fixture.repository.awaitApproval(first, CALL);

    expect((await reserve()).kind).toBe('reserved');
  });
}
