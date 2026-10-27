import crypto from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import type { KeysetPosition } from './keyset.js';
import { createDatabaseSessionRepositoryProvider } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('SessionRepository lifecycle against PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const workspace = { id: crypto.randomUUID(), slug: 'session-lifecycle', name: 'Sessions' };
  const user = { id: crypto.randomUUID(), email: 'sessions@example.test', name: 'Session Owner' };
  const agent = { id: crypto.randomUUID(), name: 'Lifecycle Agent' };
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_session_lifecycle');
    await isolated.db.insert(workspaces).values(workspace);
    await isolated.db.insert(users).values(user);
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId: workspace.id, userId: user.id, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId: workspace.id,
        kind: 'membership',
        membershipId,
      });
    });
    await isolated.db.insert(agents).values({
      ...agent,
      workspaceId: workspace.id,
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: user.id,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
  }, 180_000);

  afterAll(async () => isolated.close());

  it('lists metadata, maps the engine id, and archives/restores idempotently', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspace.id,
    );
    if (scope === null) throw new Error('workspace does not resolve');
    const repository = createDatabaseSessionRepositoryProvider(isolated.db).forScope(scope);
    const id = crypto.randomUUID();
    await expect(
      repository.ensure({
        id,
        agentId: agent.id,
        ownerPrincipalId: principalId,
        userId: user.id,
        title: 'Initial',
      }),
    ).resolves.toMatchObject({ kind: 'created' });
    const engineSessionId = crypto.randomUUID();
    await expect(
      repository.update(id, {
        title: 'Renamed',
        engineIdentity: { engineSessionId, engine: 'claude-agent-sdk' },
      }),
    ).resolves.toMatchObject({ kind: 'updated' });
    await expect(repository.getByEngineSessionId(engineSessionId)).resolves.toMatchObject({
      id,
      title: 'Renamed',
      status: 'active',
      // ADR-0065's pairing: `update` writes the engine alongside the id it belongs to, so a row
      // that has an identity always names the engine that reported it. `schema/sessions.ts` cites
      // this assertion as the reason the pairing is not also a database CHECK.
      engine: 'claude-agent-sdk',
      engineSessionId,
    });
    // An update that names neither leaves both as they were, rather than clearing either.
    await expect(repository.update(id, { title: 'Renamed twice' })).resolves.toMatchObject({
      kind: 'updated',
      session: { engine: 'claude-agent-sdk', engineSessionId },
    });
    await expect(
      repository.list({ visibility: { kind: 'all' }, status: 'active' }),
    ).resolves.toMatchObject({
      items: [{ id }],
      nextCursor: null,
    });
    await expect(repository.archive(id)).resolves.toMatchObject({
      kind: 'updated',
      session: { status: 'archived' },
    });
    await expect(repository.archive(id)).resolves.toMatchObject({
      kind: 'no-op',
      session: { status: 'archived' },
    });
    await expect(
      repository.list({ visibility: { kind: 'all' }, status: 'active' }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(repository.restore(id)).resolves.toMatchObject({
      kind: 'updated',
      session: { status: 'active' },
    });
  });

  it('pages with limit=1 by (created_at, id): every row once, ties split by id, inserts never shift a walk (S-5)', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspace.id,
    );
    if (scope === null) throw new Error('workspace does not resolve');
    const repository = createDatabaseSessionRepositoryProvider(isolated.db).forScope(scope);
    // Three rows share one instant, so only `id` can order them across page boundaries.
    const tie = new Date('2026-01-02T03:04:05.123Z');
    const engineSessionId = crypto.randomUUID();
    await isolated.db.insert(sessions).values([
      ...[0, 1, 2].map(() => ({
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        agentId: agent.id,
        ownerPrincipalId: principalId,
        createdAt: tie,
      })),
      {
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        agentId: agent.id,
        ownerPrincipalId: principalId,
        engineSessionId,
        engine: 'claude-agent-sdk' as const,
        createdAt: new Date('2026-01-02T03:04:05.124Z'),
      },
    ]);
    const all = await repository.list({ visibility: { kind: 'all' } });
    expect(all.nextCursor).toBeNull();
    expect(all.items.length).toBeGreaterThanOrEqual(4);

    const walked: string[] = [];
    let cursor: KeysetPosition | null = null;
    for (let pages = 0; pages <= all.items.length; pages += 1) {
      const page = await repository.list({ visibility: { kind: 'all' }, limit: 1, cursor });
      walked.push(...page.items.map((row) => row.id));
      if (pages === 0) {
        // A session created mid-walk is newer than every boundary already handed out.
        await repository.ensure({
          id: crypto.randomUUID(),
          agentId: agent.id,
          ownerPrincipalId: principalId,
        });
      }
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(walked).toEqual(all.items.map((row) => row.id));

    await expect(
      repository.list({ visibility: { kind: 'engine-session', engineSessionId } }),
    ).resolves.toMatchObject({ items: [{ engineSessionId }], nextCursor: null });
    await expect(
      repository.list({ visibility: { kind: 'owner', principalId: crypto.randomUUID() } }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(repository.list({ visibility: { kind: 'all' }, limit: 201 })).rejects.toThrow(
      /limit/,
    );
  });

  it('separates two rows a microsecond apart on a limit=1 walk (S-5)', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspace.id,
    );
    if (scope === null) throw new Error('workspace does not resolve');
    const repository = createDatabaseSessionRepositoryProvider(isolated.db).forScope(scope);
    // A `Date` holds milliseconds only, so the two instants are written as PostgreSQL text: a
    // boundary truncated to milliseconds would fall between them and hide or repeat one.
    const earlier = crypto.randomUUID();
    const later = crypto.randomUUID();
    await isolated.db.insert(sessions).values([
      {
        id: earlier,
        workspaceId: workspace.id,
        agentId: agent.id,
        ownerPrincipalId: principalId,
        createdAt: sql`'2026-02-03T04:05:06.123456Z'::timestamptz`,
      },
      {
        id: later,
        workspaceId: workspace.id,
        agentId: agent.id,
        ownerPrincipalId: principalId,
        createdAt: sql`'2026-02-03T04:05:06.123457Z'::timestamptz`,
      },
    ]);

    const walked: string[] = [];
    let cursor: KeysetPosition | null = null;
    for (let pages = 0; pages < 1_000; pages += 1) {
      const page = await repository.list({ visibility: { kind: 'all' }, limit: 1, cursor });
      walked.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(walked.filter((id) => id === earlier)).toHaveLength(1);
    expect(walked.filter((id) => id === later)).toHaveLength(1);
    // Newest first: the later microsecond comes before the earlier one.
    expect(walked.indexOf(later)).toBeLessThan(walked.indexOf(earlier));
  });

  it("filters by owner in the query: another principal's session is excluded, and 'all' includes it", async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspace.id,
    );
    if (scope === null) throw new Error('workspace does not resolve');
    const repository = createDatabaseSessionRepositoryProvider(isolated.db).forScope(scope);
    const otherUser = {
      id: crypto.randomUUID(),
      email: 'other-sessions@example.test',
      name: 'Other Owner',
    };
    const otherMembershipId = crypto.randomUUID();
    const otherPrincipalId = crypto.randomUUID();
    await isolated.db.insert(users).values(otherUser);
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({
        id: otherMembershipId,
        workspaceId: workspace.id,
        userId: otherUser.id,
        role: 'viewer',
      });
      await tx.insert(workspacePrincipals).values({
        id: otherPrincipalId,
        workspaceId: workspace.id,
        kind: 'membership',
        membershipId: otherMembershipId,
      });
    });
    const mine = crypto.randomUUID();
    const theirs = crypto.randomUUID();
    await repository.ensure({ id: mine, agentId: agent.id, ownerPrincipalId: principalId });
    await repository.ensure({ id: theirs, agentId: agent.id, ownerPrincipalId: otherPrincipalId });

    const owned = await repository.list({ visibility: { kind: 'owner', principalId } });
    const ownedIds = owned.items.map((row) => row.id);
    expect(ownedIds).toContain(mine);
    expect(ownedIds).not.toContain(theirs);
    expect(owned.items.every((row) => row.ownerPrincipalId === principalId)).toBe(true);

    const everyone = await repository.list({ visibility: { kind: 'all' } });
    expect(everyone.items.map((row) => row.id)).toEqual(expect.arrayContaining([mine, theirs]));
  });

  describe('discardIfUnused (issue #1263)', () => {
    const scopeOf = async (workspaceId: string) => {
      const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
        workspaceId,
      );
      if (scope === null) throw new Error('workspace does not resolve');
      return scope;
    };
    const repositoryOf = async (workspaceId: string) =>
      createDatabaseSessionRepositoryProvider(isolated.db).forScope(await scopeOf(workspaceId));
    const open = async () => {
      const id = crypto.randomUUID();
      await (
        await repositoryOf(workspace.id)
      ).ensure({ id, agentId: agent.id, ownerPrincipalId: principalId });
      return id;
    };

    it('deletes a session that has no run', async () => {
      const repository = await repositoryOf(workspace.id);
      const id = await open();

      await expect(repository.discardIfUnused(id)).resolves.toBe(true);
      await expect(repository.get(id)).resolves.toBeNull();
      await expect(repository.discardIfUnused(id)).resolves.toBe(false);
    });

    it('keeps a session that has a run, and the run with it', async () => {
      const repository = await repositoryOf(workspace.id);
      const id = await open();
      const runId = crypto.randomUUID();
      await isolated.db
        .insert(runs)
        .values({ id: runId, workspaceId: workspace.id, sessionId: id });

      await expect(repository.discardIfUnused(id)).resolves.toBe(false);
      await expect(repository.get(id)).resolves.not.toBeNull();
      const surviving = await isolated.db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, runId));
      expect(surviving).toHaveLength(1);
    });

    it("cannot delete another workspace's session, or a malformed id", async () => {
      const otherWorkspace = {
        id: crypto.randomUUID(),
        slug: 'session-discard-other',
        name: 'Other',
      };
      await isolated.db.insert(workspaces).values(otherWorkspace);
      const id = await open();
      const foreign = await repositoryOf(otherWorkspace.id);

      await expect(foreign.discardIfUnused(id)).resolves.toBe(false);
      await expect(foreign.discardIfUnused('not-a-uuid')).resolves.toBe(false);
      await expect((await repositoryOf(workspace.id)).get(id)).resolves.not.toBeNull();
    });
  });
});
