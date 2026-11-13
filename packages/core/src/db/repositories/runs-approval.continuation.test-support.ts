import crypto from 'node:crypto';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { sessions } from '../schema/sessions.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { CALL, READ_ONLY, type RunsApprovalFixture } from './runs-approval.fixture.test-support.js';

type Seeded = { runId: string; sessionId: string };
type Decide = (
  paused: Seeded,
  id?: string,
) => ReturnType<RunsApprovalFixture['repository']['create']>;

/** A session and a run in another workspace, both owned by the fixture's user. */
async function seedOtherWorkspaceRun(fixture: RunsApprovalFixture): Promise<string> {
  const { isolated, userId } = fixture;
  const { workspaceId: otherWorkspace } = await fixture.otherWorkspaceRepository();
  const otherMembership = crypto.randomUUID();
  const otherPrincipal = crypto.randomUUID();
  const otherAgent = crypto.randomUUID();
  const otherSession = crypto.randomUUID();
  const otherRun = crypto.randomUUID();
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
    permissions: READ_ONLY,
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
  return otherRun;
}

function decisionCases(fixture: RunsApprovalFixture, decide: Decide): void {
  it('completes the paused run and inserts the continuation together', async () => {
    const paused = await fixture.seedPaused();

    const outcome = await decide(paused);

    expect(outcome.kind).toBe('created');
    expect((await fixture.repository.get(paused.runId))?.status).toBe('completed');
    if (outcome.kind !== 'created') return;
    expect(outcome.run.status).toBe('queued');
    expect(outcome.run.approvedToolCalls).toEqual([CALL]);
  });

  it('stamps the deadline 24 hours after the pause, and keeps it once decided', async () => {
    const paused = await fixture.seedPaused();
    const stamped = async (): Promise<unknown> =>
      (
        await fixture.isolated.db.execute(
          sql`select approval_deadline_at = ended_at + interval '24 hours' as exact from runs where id = ${paused.runId}`,
        )
      ).rows[0]?.['exact'];
    expect(await stamped()).toBe(true);

    expect((await decide(paused)).kind).toBe('created');
    expect(await stamped()).toBe(true);
  });

  it('records which run a continuation continues, and gives a paused run only one', async () => {
    const { isolated, repository } = fixture;
    const paused = await fixture.seedPaused();
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
}

function integrityCases(fixture: RunsApprovalFixture, decide: Decide): void {
  it('refuses a continuation of another workspace’s run', async () => {
    const otherRun = await seedOtherWorkspaceRun(fixture);
    const { runId } = await fixture.seedRunning();

    await expect(
      fixture.isolated.db.execute(
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
    const paused = await fixture.seedPaused();
    const outcome = await decide(paused);
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;

    // The self-reference has no delete action; the session's cascade removes both runs at once.
    await fixture.isolated.db.execute(sql`delete from sessions where id = ${paused.sessionId}`);

    expect(await fixture.repository.get(paused.runId)).toBeNull();
    expect(await fixture.repository.get(outcome.run.id)).toBeNull();
  });

  it('lets exactly one of two concurrent decisions win', async () => {
    const paused = await fixture.seedPaused();

    const outcomes = await Promise.all([decide(paused), decide(paused), decide(paused)]);

    expect(outcomes.filter((o) => o.kind === 'created')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'already-decided')).toHaveLength(2);
  });
}

function refusalCases(fixture: RunsApprovalFixture, decide: Decide): void {
  it('answers already-decided, creating nothing, for a run that is not paused', async () => {
    const running = await fixture.seedRunning();
    const id = crypto.randomUUID();

    expect((await decide(running, id)).kind).toBe('already-decided');

    expect(await fixture.repository.get(id)).toBeNull();
    expect((await fixture.repository.get(running.runId))?.status).toBe('running');
  });

  it('answers already-decided for a run of another session', async () => {
    const paused = await fixture.seedPaused();
    const other = await fixture.seedSession();

    const outcome = await decide({ runId: paused.runId, sessionId: other });

    expect(outcome.kind).toBe('already-decided');
    expect((await fixture.repository.get(paused.runId))?.status).toBe('awaiting_approval');
  });

  it('leaves the pause untouched when the session is busy', async () => {
    const paused = await fixture.seedPaused();
    const sibling = await fixture.repository.create({
      id: crypto.randomUUID(),
      sessionId: paused.sessionId,
      engine: 'claude-agent-sdk',
    });
    expect(sibling.kind).toBe('created');

    expect((await decide(paused)).kind).toBe('session-busy');
    expect((await fixture.repository.get(paused.runId))?.status).toBe('awaiting_approval');
  });
}

function deadlineCases(fixture: RunsApprovalFixture, decide: Decide): void {
  it('cancels a pause older than 24 hours and creates no continuation', async () => {
    const paused = await fixture.seedPaused();
    await fixture.isolated.db.execute(
      sql`update runs set approval_deadline_at = now() - interval '1 hour' where id = ${paused.runId}`,
    );
    const id = crypto.randomUUID();

    const outcome = await decide(paused, id);

    expect(outcome.kind).toBe('approval-expired');
    expect(await fixture.repository.get(id)).toBeNull();
    const run = await fixture.repository.get(paused.runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.error).toMatch(/^approval_expired/u);
  });

  it('still honours a pause just inside the window', async () => {
    const paused = await fixture.seedPaused();
    await fixture.isolated.db.execute(
      sql`update runs set approval_deadline_at = now() + interval '1 hour' where id = ${paused.runId}`,
    );

    expect((await decide(paused)).kind).toBe('created');
  });
}

export function registerContinuationCases(fixture: RunsApprovalFixture): void {
  describe('a decision that creates the continuation (ADR-0145 D2.3)', () => {
    const decide: Decide = (paused, id = crypto.randomUUID()) =>
      fixture.repository.create({
        id,
        sessionId: paused.sessionId,
        engine: 'claude-agent-sdk',
        prompt: 'approved',
        approvedToolCalls: [CALL],
        decides: { runId: paused.runId },
      });

    decisionCases(fixture, decide);
    integrityCases(fixture, decide);
    refusalCases(fixture, decide);
    deadlineCases(fixture, decide);
  });
}
