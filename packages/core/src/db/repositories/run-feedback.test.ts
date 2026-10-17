import crypto from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { runFeedback } from '../schema/run-feedback.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import {
  createDatabaseRunFeedbackRepositoryProvider,
  type ListRunFeedbackInput,
} from './run-feedback.js';
import { createDatabaseRunRepositoryProvider } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('RunFeedbackRepository (issue #539)', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_run_feedback');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: workspaceId, name: 'Feedback' },
      { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other' },
    ]);
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Feedback agent',
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
    await isolated.db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    // Finished, as a rated run is: a session takes one run at a time, and `listForAgent` below
    // starts another in this session.
    await isolated.db
      .insert(runs)
      .values({ id: runId, workspaceId, sessionId, status: 'completed', endedAt: new Date() });
  }, 180_000);

  afterAll(async () => isolated.close());

  async function feedbackFor(workspace: string) {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(workspace);
    if (scope === null) throw new Error('workspace did not resolve');
    return createDatabaseRunFeedbackRepositoryProvider(isolated.db).forScope(scope);
  }

  const rowsOf = (id: string) =>
    isolated.db.select().from(runFeedback).where(eq(runFeedback.runId, id));

  it('stores one row per call', async () => {
    const feedback = await feedbackFor(workspaceId);
    await feedback.record({ runId, rating: 'up', comment: null });
    await feedback.record({ runId, rating: 'down', comment: 'c'.repeat(1000) });
    const rows = await rowsOf(runId);
    expect(rows.map((row) => [row.workspaceId, row.rating, row.comment?.length ?? null])).toEqual(
      expect.arrayContaining([
        [workspaceId, 'up', null],
        [workspaceId, 'down', 1000],
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it('refuses a rating outside the set and a comment over 1000 characters', async () => {
    const insert = (rating: string, comment: string | null) =>
      isolated.db.execute(
        sql`insert into run_feedback (workspace_id, run_id, rating, comment)
            values (${workspaceId}, ${runId}, ${rating}, ${comment})`,
      );
    await expect(insert('meh', null)).rejects.toThrow();
    await expect(insert('up', 'c'.repeat(1001))).rejects.toThrow();
  });

  it('refuses a run of another workspace (tenant-paired FK)', async () => {
    const feedback = await feedbackFor(otherWorkspaceId);
    await expect(feedback.record({ runId, rating: 'up', comment: null })).rejects.toThrow();
  });

  describe('listForAgent (issue #620)', () => {
    const otherPrincipalId = crypto.randomUUID();
    const otherSessionId = crypto.randomUUID();
    const promptedRunId = crypto.randomUUID();
    const othersRunId = crypto.randomUUID();

    beforeAll(async () => {
      const otherUserId = crypto.randomUUID();
      const otherMembershipId = crypto.randomUUID();
      await isolated.db
        .insert(users)
        .values({ id: otherUserId, email: `${otherUserId}@example.com`, name: 'Viewer' });
      await isolated.db.transaction(async (tx) => {
        await tx.insert(memberships).values({
          id: otherMembershipId,
          workspaceId,
          userId: otherUserId,
          role: 'viewer',
        });
        await tx.insert(workspacePrincipals).values({
          id: otherPrincipalId,
          workspaceId,
          kind: 'membership',
          membershipId: otherMembershipId,
        });
      });
      await isolated.db.insert(sessions).values({
        id: otherSessionId,
        workspaceId,
        userId: otherUserId,
        ownerPrincipalId: otherPrincipalId,
        agentId,
      });
      const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
        workspaceId,
      );
      if (scope === null) throw new Error('workspace did not resolve');
      // Through `RunRepository.create`, so the prompt read back below is the one a run stores.
      const created = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
      await created.create({
        id: promptedRunId,
        sessionId,
        engine: 'claude-agent-sdk',
        prompt: 'Where is order 1042?',
      });
      await isolated.db
        .insert(runs)
        .values({ id: othersRunId, workspaceId, sessionId: otherSessionId, prompt: 'Hello' });
      const feedback = await feedbackFor(workspaceId);
      await feedback.record({ runId: promptedRunId, rating: 'down', comment: 'Wrong order.' });
      await feedback.record({ runId: othersRunId, rating: 'down', comment: null });
    });

    const list = async (filter: Partial<ListRunFeedbackInput> = {}, workspace = workspaceId) =>
      (await feedbackFor(workspace)).listForAgent({ agentId, limit: 50, ...filter });

    it('lists the agent’s ratings newest first, with the run’s prompt', async () => {
      const rows = await list({ rating: 'down' });
      expect(rows.map((row) => [row.runId, row.comment, row.prompt])).toEqual([
        [othersRunId, null, 'Hello'],
        [promptedRunId, 'Wrong order.', 'Where is order 1042?'],
        [runId, 'c'.repeat(1000), null],
      ]);
      expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    });

    it('filters by rating, run, owner, time and limit', async () => {
      expect((await list({ rating: 'up' })).map((row) => row.runId)).toEqual([runId]);
      expect((await list({ runId: promptedRunId })).map((row) => row.runId)).toEqual([
        promptedRunId,
      ]);
      expect((await list({ ownerPrincipalId: otherPrincipalId })).map((row) => row.runId)).toEqual([
        othersRunId,
      ]);
      expect(await list({ since: new Date(Date.now() + 60_000) })).toEqual([]);
      expect(await list({ limit: 1 })).toHaveLength(1);
    });

    it('never lists another agent’s or another workspace’s ratings', async () => {
      expect(await list({ agentId: crypto.randomUUID() })).toEqual([]);
      expect(await list({}, otherWorkspaceId)).toEqual([]);
    });
  });
});
