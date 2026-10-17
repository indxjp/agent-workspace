/**
 * `AgentGrantRepository` against a real PostgreSQL — the mechanism behind spec §21's Viewer "run
 * permitted agents" (issue #117). Copies `./mcp-servers.test.ts`'s isolated-database shape.
 */
import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentGrants } from '../schema/agent-grants.js';
import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseAgentGrantRepositoryProvider } from './agent-grants.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[repositories/agent-grants.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the ' +
      'agent_grants repository was NOT exercised against a real PostgreSQL. A green result ' +
      'without it says nothing about AgentGrantRepository.',
  );
}

describe.skipIf(!hasDatabase)('AgentGrantRepository against real PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let scopeA: WorkspaceScope;
  let scopeB: WorkspaceScope;
  const workspaceA = { id: crypto.randomUUID(), slug: 'w9-auth-117-a', name: 'A' };
  const workspaceB = { id: crypto.randomUUID(), slug: 'w9-auth-117-b', name: 'B' };
  const ownerA = crypto.randomUUID();
  const ownerB = crypto.randomUUID();
  const viewerA = crypto.randomUUID();
  const agentA = crypto.randomUUID();
  const ownerMembershipA = crypto.randomUUID();
  const ownerMembershipB = crypto.randomUUID();
  const viewerMembershipA = crypto.randomUUID();
  const ownerPrincipalA = crypto.randomUUID();
  const viewerPrincipalA = crypto.randomUUID();
  const ownerPrincipalB = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w9_auth_117_agent_grants');
    await isolated.db.insert(workspaces).values([workspaceA, workspaceB]);
    await isolated.db.insert(users).values([
      { id: ownerA, email: `${ownerA}@example.test`, name: 'Owner A' },
      { id: ownerB, email: `${ownerB}@example.test`, name: 'Owner B' },
      { id: viewerA, email: `${viewerA}@example.test`, name: 'Viewer A' },
    ]);
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values([
        { id: ownerMembershipA, workspaceId: workspaceA.id, userId: ownerA, role: 'owner' },
        { id: ownerMembershipB, workspaceId: workspaceB.id, userId: ownerB, role: 'owner' },
        { id: viewerMembershipA, workspaceId: workspaceA.id, userId: viewerA, role: 'viewer' },
      ]);
      await tx.insert(workspacePrincipals).values([
        {
          id: ownerPrincipalA,
          workspaceId: workspaceA.id,
          kind: 'membership',
          membershipId: ownerMembershipA,
        },
        {
          id: ownerPrincipalB,
          workspaceId: workspaceB.id,
          kind: 'membership',
          membershipId: ownerMembershipB,
        },
        {
          id: viewerPrincipalA,
          workspaceId: workspaceA.id,
          kind: 'membership',
          membershipId: viewerMembershipA,
        },
      ]);
    });
    await isolated.db.insert(agents).values({
      id: agentA,
      workspaceId: workspaceA.id,
      name: 'Support',
      instructions: '',
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      ownerPrincipalId: ownerPrincipalA,
      createdBy: ownerA,
    });

    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const resolvedA = await resolver.forWorkspaceId(workspaceA.id);
    const resolvedB = await resolver.forWorkspaceId(workspaceB.id);
    if (resolvedA === null || resolvedB === null) {
      throw new Error('fixture setup failed: workspace scope did not resolve');
    }
    scopeA = resolvedA;
    scopeB = resolvedB;
  }, 180_000);

  afterAll(async () => isolated.close());

  it('reports no grant before one is inserted', async () => {
    const repo = createDatabaseAgentGrantRepositoryProvider(isolated.db).forScope(scopeA);
    expect(await repo.hasGrant(agentA, viewerA)).toBe(false);
  });

  it('reports a grant once inserted directly, and stops after it is removed', async () => {
    await isolated.db
      .insert(agentGrants)
      .values({ workspaceId: workspaceA.id, agentId: agentA, userId: viewerA });
    const repo = createDatabaseAgentGrantRepositoryProvider(isolated.db).forScope(scopeA);
    expect(await repo.hasGrant(agentA, viewerA)).toBe(true);

    await isolated.db.delete(agentGrants).where(eq(agentGrants.userId, viewerA));
    expect(await repo.hasGrant(agentA, viewerA)).toBe(false);
  });

  it('adds, lists, replaces, and removes grants by membership principal id', async () => {
    const repo = createDatabaseAgentGrantRepositoryProvider(isolated.db).forScope(scopeA);
    expect(await repo.replacePrincipalIds(agentA, [viewerPrincipalA])).toEqual({
      kind: 'updated',
      principalIds: [viewerPrincipalA],
    });
    expect(await repo.listPrincipalIds(agentA)).toEqual([viewerPrincipalA]);
    expect(await repo.hasGrant(agentA, viewerA)).toBe(true);

    expect(await repo.replacePrincipalIds(agentA, [])).toEqual({
      kind: 'updated',
      principalIds: [],
    });
    expect(await repo.listPrincipalIds(agentA)).toEqual([]);
    expect(await repo.hasGrant(agentA, viewerA)).toBe(false);
  });

  it('refuses a cross-tenant principal without changing the existing grant set', async () => {
    const repo = createDatabaseAgentGrantRepositoryProvider(isolated.db).forScope(scopeA);
    await repo.replacePrincipalIds(agentA, [viewerPrincipalA]);
    expect(await repo.replacePrincipalIds(agentA, [ownerPrincipalB])).toEqual({
      kind: 'principal-not-found',
      principalId: ownerPrincipalB,
    });
    expect(await repo.listPrincipalIds(agentA)).toEqual([viewerPrincipalA]);
  });

  it('serializes concurrent replacements so the stored grants are one complete caller set', async () => {
    const secondViewer = crypto.randomUUID();
    const secondMembership = crypto.randomUUID();
    await isolated.db.insert(users).values({
      id: secondViewer,
      email: `second-${secondViewer}@example.test`,
      name: 'Second viewer',
    });
    await isolated.db.insert(memberships).values({
      id: secondMembership,
      workspaceId: workspaceA.id,
      userId: secondViewer,
      role: 'viewer',
    });
    const principalRows = await isolated.db
      .select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .where(
        and(
          eq(workspacePrincipals.workspaceId, workspaceA.id),
          eq(workspacePrincipals.membershipId, secondMembership),
        ),
      );
    const secondPrincipal = principalRows[0]?.id;
    if (secondPrincipal === undefined) throw new Error('membership principal trigger did not run');

    const repo = createDatabaseAgentGrantRepositoryProvider(isolated.db).forScope(scopeA);
    await Promise.all([
      repo.replacePrincipalIds(agentA, [viewerPrincipalA]),
      repo.replacePrincipalIds(agentA, [secondPrincipal]),
    ]);
    expect([[viewerPrincipalA], [secondPrincipal]]).toContainEqual(
      await repo.listPrincipalIds(agentA),
    );
  });

  it('cross-workspace isolation (spec §25): a grant in A is invisible from B', async () => {
    await isolated.db
      .insert(agentGrants)
      .values({ workspaceId: workspaceA.id, agentId: agentA, userId: viewerA })
      .onConflictDoNothing();
    const repoB = createDatabaseAgentGrantRepositoryProvider(isolated.db).forScope(scopeB);
    expect(await repoB.hasGrant(agentA, viewerA)).toBe(false);
  });

  it(
    "revocation is the composite FK, not a background job: deleting the Viewer's membership " +
      'removes the grant row atomically (issue #117)',
    async () => {
      const doomed = crypto.randomUUID();
      await isolated.db
        .insert(users)
        .values({ id: doomed, email: `${doomed}@example.test`, name: 'Doomed Viewer' });
      await isolated.db
        .insert(memberships)
        .values({ workspaceId: workspaceA.id, userId: doomed, role: 'viewer' });
      await isolated.db
        .insert(agentGrants)
        .values({ workspaceId: workspaceA.id, agentId: agentA, userId: doomed });

      const repo = createDatabaseAgentGrantRepositoryProvider(isolated.db).forScope(scopeA);
      expect(await repo.hasGrant(agentA, doomed)).toBe(true);

      await isolated.db
        .delete(memberships)
        .where(and(eq(memberships.workspaceId, workspaceA.id), eq(memberships.userId, doomed)));

      // Nobody deleted the grant row directly — the membership's removal did, by the composite
      // foreign key's ON DELETE CASCADE (`agent_grants_member_workspace_fk`).
      expect(await repo.hasGrant(agentA, doomed)).toBe(false);
      const remaining = await isolated.db
        .select({ id: agentGrants.id })
        .from(agentGrants)
        .where(and(eq(agentGrants.workspaceId, workspaceA.id), eq(agentGrants.userId, doomed)));
      expect(remaining).toHaveLength(0);
    },
  );

  it('the tenant-pairing constraint refuses a grant naming another workspace’s agent', async () => {
    const stranger = crypto.randomUUID();
    await isolated.db
      .insert(users)
      .values({ id: stranger, email: `${stranger}@example.test`, name: 'Stranger' });
    await isolated.db
      .insert(memberships)
      .values({ workspaceId: workspaceB.id, userId: stranger, role: 'viewer' });

    // Directly via SQL, as the verifier attack asks: `agent_id` belongs to workspace A while
    // `workspace_id` names B. Assert the database refuses it by constraint name.
    let thrown: unknown;
    try {
      await isolated.db
        .insert(agentGrants)
        .values({ workspaceId: workspaceB.id, agentId: agentA, userId: stranger });
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'expected agent_grants_agent_workspace_fk to reject the insert').toBeDefined();
    const seen: string[] = [];
    let cursor: unknown = thrown;
    for (let depth = 0; depth < 10 && typeof cursor === 'object' && cursor !== null; depth += 1) {
      const name: unknown = (cursor as { constraint?: unknown }).constraint;
      if (typeof name === 'string') seen.push(name);
      cursor = (cursor as { cause?: unknown }).cause;
    }
    expect(seen).toContain('agent_grants_agent_workspace_fk');
  });
});
