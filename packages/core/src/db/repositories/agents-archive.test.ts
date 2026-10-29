/**
 * `AgentRepository.listArchiveCandidates` and `archive` against real PostgreSQL (issue #1851): the
 * prefilter the auto-archive sweep reads, and the archive write with its audit row.
 */
import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { auditEvents } from '../schema/audit-events.js';
import { memberships } from '../schema/memberships.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseAgentRepositoryProvider, type AgentRepository } from './agents.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

const DAY_MS = 24 * 60 * 60 * 1000;
const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;

describe.skipIf(!hasDatabase)('AgentRepository archive against PostgreSQL (issue #1851)', () => {
  let isolated: IsolatedTestDatabase;
  let repository: AgentRepository;
  let otherRepository: AgentRepository;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const creatorId = crypto.randomUUID();
  const old = new Date(Date.now() - 40 * DAY_MS);

  async function seedAgent(
    name: string,
    options: { agentMade?: boolean; createdAt?: Date; workspace?: string } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await isolated.db.insert(agents).values({
      id,
      workspaceId: options.workspace ?? workspaceId,
      name,
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions: PERMISSIONS,
      createdAt: options.createdAt ?? old,
      ...(options.agentMade === false
        ? {}
        : { createdByAgentId: creatorId, createdByAgentVersion: 1, createdByRunId: 'run-1' }),
    });
    return id;
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_agent_archive_1851');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: 'agent-archive', name: 'Agent Archive' },
      { id: otherWorkspaceId, slug: 'agent-archive-other', name: 'Other' },
    ]);
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    const membershipId = crypto.randomUUID();
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    await isolated.db.insert(agents).values({
      id: creatorId,
      workspaceId,
      name: 'creator',
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions: PERMISSIONS,
    });
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const scope = await resolver.forWorkspaceId(workspaceId);
    const otherScope = await resolver.forWorkspaceId(otherWorkspaceId);
    if (scope === null || otherScope === null) throw new Error('fixture workspace did not resolve');
    const provider = createDatabaseAgentRepositoryProvider(isolated.db);
    repository = provider.forScope(scope);
    otherRepository = provider.forScope(otherScope);
  }, 180_000);

  afterAll(async () => isolated.close());

  it('lists only unarchived agent-made agents older than the cutoff, by id after the cursor', async () => {
    const made = await seedAgent('made');
    const person = await seedAgent('person', { agentMade: false });
    const fresh = await seedAgent('fresh', { createdAt: new Date() });
    const archivedAlready = await seedAgent('archived');
    await repository.archive([archivedAlready], new Date());

    const page = await repository.listArchiveCandidates({
      createdBefore: new Date(Date.now() - 30 * DAY_MS),
      notRestoredSince: new Date(Date.now() - 30 * DAY_MS),
      afterId: null,
      limit: 100,
    });
    const ids = page.map((candidate) => candidate.id);

    expect(ids).toContain(made);
    expect(ids).not.toContain(person);
    expect(ids).not.toContain(fresh);
    expect(ids).not.toContain(archivedAlready);
    expect(ids).toEqual([...ids].sort());
    const candidate = page.find((c) => c.id === made);
    expect(candidate?.createdByAgent).toEqual({ agentId: creatorId, version: 1, runId: 'run-1' });
    expect(candidate?.lastRunAt).toBeNull();

    const first = ids[0];
    if (first === undefined) throw new Error('no candidates');
    const next = await repository.listArchiveCandidates({
      createdBefore: new Date(Date.now() - 30 * DAY_MS),
      notRestoredSince: new Date(Date.now() - 30 * DAY_MS),
      afterId: first,
      limit: 100,
    });
    expect(next.map((c) => c.id)).toEqual(ids.slice(1));
    const limited = await repository.listArchiveCandidates({
      createdBefore: new Date(Date.now() - 30 * DAY_MS),
      notRestoredSince: new Date(Date.now() - 30 * DAY_MS),
      afterId: null,
      limit: 1,
    });
    expect(limited).toHaveLength(1);
  });

  it('reports the newest run of any session of the agent', async () => {
    const id = await seedAgent('ran');
    const sessionId = crypto.randomUUID();
    await isolated.db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId: id });
    const recent = new Date(Date.now() - 2 * DAY_MS);
    await isolated.db.insert(runs).values([
      {
        id: crypto.randomUUID(),
        workspaceId,
        sessionId,
        createdAt: new Date(Date.now() - 35 * DAY_MS),
      },
      { id: crypto.randomUUID(), workspaceId, sessionId, createdAt: recent },
    ]);

    const page = await repository.listArchiveCandidates({
      createdBefore: new Date(Date.now() - 30 * DAY_MS),
      notRestoredSince: new Date(Date.now() - 30 * DAY_MS),
      afterId: null,
      limit: 1000,
    });

    expect(page.find((candidate) => candidate.id === id)?.lastRunAt?.getTime()).toBe(
      recent.getTime(),
    );
  });

  it('archives with one audit row each, and a repeat archives and audits nothing', async () => {
    const id = await seedAgent('to-archive');
    const at = new Date('2026-10-27T04:00:00.000Z');

    expect(await repository.archive([id], at)).toEqual([id]);
    expect(await repository.archive([id], new Date())).toEqual([]);

    const row = (await repository.get(id))?.archivedAt;
    expect(row?.getTime()).toBe(at.getTime());
    const audit = await isolated.db.select().from(auditEvents).where(eq(auditEvents.subjectId, id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      workspaceId,
      action: 'agent-changed',
      subjectLabel: 'to-archive',
      actorPrincipalId: null,
      details: { archived: true },
    });
  });

  it('never archives another workspace’s agent, and an empty list is a no-op', async () => {
    const id = await seedAgent('theirs');

    expect(await otherRepository.archive([id], new Date())).toEqual([]);
    expect(await repository.archive([], new Date())).toEqual([]);
    expect((await repository.get(id))?.archivedAt).toBeUndefined();
  });

  it('restores with one audit row naming the caller, and a repeat restores and audits nothing', async () => {
    const id = await seedAgent('to-restore');
    await repository.archive([id], new Date());
    const actor = { principalId, userId, label: 'Ada' };

    const outcome = await repository.restore(id, actor);
    expect(outcome.kind).toBe('restored');
    expect((await repository.get(id))?.archivedAt).toBeUndefined();
    expect((await repository.restore(id, actor)).kind).toBe('not-archived');

    const audit = await isolated.db.select().from(auditEvents).where(eq(auditEvents.subjectId, id));
    const restores = audit.filter(
      (row) => row.details !== null && 'archived' in row.details && !row.details.archived,
    );
    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatchObject({
      workspaceId,
      action: 'agent-changed',
      subjectLabel: 'to-restore',
      actorPrincipalId: principalId,
      actorUserId: userId,
      actorLabel: 'Ada',
    });
  });

  it('answers not-found for another workspace’s agent and leaves it archived', async () => {
    const id = await seedAgent('theirs-archived');
    await repository.archive([id], new Date());

    const actor = { principalId, userId, label: 'Ada' };
    expect(await otherRepository.restore(id, actor)).toEqual({ kind: 'not-found' });
    expect((await repository.get(id))?.archivedAt).toBeDefined();
  });

  it('leaves a recently restored agent out of the candidates for the restore window', async () => {
    const recent = await seedAgent('restored-1-day-ago');
    const stale = await seedAgent('restored-31-days-ago');
    const archivedOnly = await seedAgent('only-archived-1-day-ago');
    const audit = (subject: string, archived: boolean, daysAgo: number) =>
      isolated.db.insert(auditEvents).values({
        workspaceId,
        action: 'agent-changed',
        subjectId: subject,
        subjectLabel: 'x',
        actorLabel: 'Ada',
        details: { archived },
        createdAt: new Date(Date.now() - daysAgo * DAY_MS),
      });
    await audit(recent, false, 1);
    await audit(stale, false, 31);
    // An archive row is not a restore: it must not exclude the agent.
    await audit(archivedOnly, true, 1);

    const page = await repository.listArchiveCandidates({
      createdBefore: new Date(Date.now() - 30 * DAY_MS),
      notRestoredSince: new Date(Date.now() - 30 * DAY_MS),
      afterId: null,
      limit: 1000,
    });
    const ids = page.map((candidate) => candidate.id);

    expect(ids).not.toContain(recent);
    expect(ids).toContain(stale);
    expect(ids).toContain(archivedOnly);
  });

  it('does not archive an agent restored in the last 30 days, even when it was listed before', async () => {
    const id = await seedAgent('restored-after-listing');
    await isolated.db.insert(auditEvents).values({
      workspaceId,
      action: 'agent-changed',
      subjectId: id,
      subjectLabel: 'x',
      actorLabel: 'Ada',
      details: { archived: false },
      createdAt: new Date(Date.now() - DAY_MS),
    });

    expect(await repository.archive([id], new Date())).toEqual([]);
    expect((await repository.get(id))?.archivedAt).toBeUndefined();
  });
});
