import { and, eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';

import type { Database } from './client.js';
import { GENERAL_AGENT_PERMISSIONS } from './seed.js';
import {
  createMembershipPrincipal,
  expectConstraintViolation,
  seedTenantBase,
  type TenantBase,
} from './seed.fixture.test-support.js';
import { agents } from './schema/agents.js';
import { memberships } from './schema/memberships.js';
import { modelConnections } from './schema/model-connections.js';
import { runs } from './schema/runs.js';
import { sessions } from './schema/sessions.js';
import { workspaces } from './schema/workspaces.js';

/** One workspace, one user who is a member of it, one agent and one model connection in it. */
export interface Tenant extends TenantBase {
  modelConnectionId: string;
}

export async function createTenant(db: Database, slug: string, email: string): Promise<Tenant> {
  const base = await seedTenantBase(db, slug, email);
  const [connection] = await db
    .insert(modelConnections)
    .values({ workspaceId: base.workspaceId, name: 'Claude', provider: 'anthropic', config: {} })
    .returning();
  if (connection === undefined) throw new Error(`could not populate the ${slug} tenant`);
  return { ...base, modelConnectionId: connection.id };
}

/** The connection and the two tenants a cross-tenant case runs against. */
interface CrossTenantContext {
  db: Database;
  a: Tenant;
  b: Tenant;
}

async function refusesForeignAgentSession({ db, a, b }: CrossTenantContext): Promise<void> {
  await expectConstraintViolation(
    db.execute(
      sql`insert into ${sessions} (workspace_id, user_id, agent_id, owner_principal_id) values (${b.workspaceId}, ${b.userId}, ${a.agentId}, ${b.principalId})`,
    ),
    'sessions_agent_workspace_fk',
  );

  // …and the identical statement naming B's own agent is accepted.
  const accepted = await db
    .insert(sessions)
    .values({
      workspaceId: b.workspaceId,
      userId: b.userId,
      agentId: b.agentId,
      ownerPrincipalId: b.principalId,
    })
    .returning();
  expect(accepted).toHaveLength(1);
}

async function refusesForeignWorkspaceRun({ db, a, b }: CrossTenantContext): Promise<void> {
  const [session] = await db
    .insert(sessions)
    .values({
      workspaceId: a.workspaceId,
      userId: a.userId,
      agentId: a.agentId,
      ownerPrincipalId: a.principalId,
    })
    .returning();
  expect(session).toBeDefined();

  await expectConstraintViolation(
    db.execute(
      sql`insert into ${runs} (workspace_id, session_id) values (${b.workspaceId}, ${session?.id ?? ''})`,
    ),
    'runs_session_workspace_fk',
  );

  const accepted = await db
    .insert(runs)
    .values({ workspaceId: a.workspaceId, sessionId: session?.id ?? '' })
    .returning();
  expect(accepted).toHaveLength(1);
}

async function refusesNonMemberSession({ db, a, b }: CrossTenantContext): Promise<void> {
  // A's user is a real user and B's agent is a real agent in B, so every single-column
  // reference on this row resolves. The membership is the only thing that does not exist.
  await expectConstraintViolation(
    db.execute(
      sql`insert into ${sessions} (workspace_id, user_id, agent_id, owner_principal_id) values (${b.workspaceId}, ${a.userId}, ${b.agentId}, ${b.principalId})`,
    ),
    'sessions_member_workspace_fk',
  );

  // Give A's user a membership in B and the identical statement is accepted.
  const crossWorkspacePrincipalId = await createMembershipPrincipal(
    db,
    b.workspaceId,
    a.userId,
    'viewer',
  );
  const accepted = await db
    .insert(sessions)
    .values({
      workspaceId: b.workspaceId,
      userId: a.userId,
      agentId: b.agentId,
      ownerPrincipalId: crossWorkspacePrincipalId,
    })
    .returning();
  expect(accepted).toHaveLength(1);
}

async function refusesBorrowedModelConnection({ db, a, b }: CrossTenantContext): Promise<void> {
  await expectConstraintViolation(
    db.insert(agents).values({
      workspaceId: a.workspaceId,
      name: 'Borrowed connection',
      instructions: '',
      permissions: GENERAL_AGENT_PERMISSIONS,
      modelConnectionId: b.modelConnectionId,
      createdBy: a.userId,
      ownerPrincipalId: a.principalId,
    }),
    'agents_model_connection_workspace_fk',
  );

  const accepted = await db
    .insert(agents)
    .values({
      workspaceId: a.workspaceId,
      name: 'Own connection',
      instructions: '',
      permissions: GENERAL_AGENT_PERMISSIONS,
      modelConnectionId: a.modelConnectionId,
      createdBy: a.userId,
      ownerPrincipalId: a.principalId,
    })
    .returning();
  expect(accepted).toHaveLength(1);
  expect(accepted[0]?.modelConnectionId).toBe(a.modelConnectionId);
}

async function fallsBackWhenConnectionDeleted({ db, a }: CrossTenantContext): Promise<void> {
  // The pairing on `model_connection_id` is a SECOND constraint precisely so this behaviour
  // survives: a composite ON DELETE SET NULL would null `workspace_id` too, and `workspace_id`
  // is NOT NULL. This case proves the two constraints co-operate rather than deadlock.
  await db
    .update(agents)
    .set({ modelConnectionId: a.modelConnectionId })
    .where(eq(agents.id, a.agentId));

  await db.delete(modelConnections).where(eq(modelConnections.id, a.modelConnectionId));

  const [agent] = await db.select().from(agents).where(eq(agents.id, a.agentId));
  expect(agent?.modelConnectionId).toBeNull();
  expect(agent?.workspaceId).toBe(a.workspaceId);
}

async function refusesRemovingSessionOwner({ db, a }: CrossTenantContext): Promise<void> {
  await db.insert(sessions).values({
    workspaceId: a.workspaceId,
    userId: a.userId,
    agentId: a.agentId,
    ownerPrincipalId: a.principalId,
  });

  await expectConstraintViolation(
    db
      .delete(memberships)
      .where(and(eq(memberships.workspaceId, a.workspaceId), eq(memberships.userId, a.userId))),
    'sessions_member_workspace_fk',
  );
}

async function deletesWholeWorkspace({ db, a, b }: CrossTenantContext): Promise<void> {
  // Deleting a workspace cascades into `memberships` and `sessions` in the same statement.
  // This asserts that the statement succeeds and leaves nothing behind. It does NOT
  // discriminate `sessions_member_workspace_fk`'s `NO ACTION` from `RESTRICT` — measured on
  // PostgreSQL 17.11, this delete succeeds under both, because both are checked at end of
  // statement. No test in this repository tells those two actions apart; see
  // docs/adr/W1-DB-01-schema-conventions.md decision 14.
  await db.insert(sessions).values({
    workspaceId: a.workspaceId,
    userId: a.userId,
    agentId: a.agentId,
    ownerPrincipalId: a.principalId,
  });

  await db.delete(workspaces).where(eq(workspaces.id, a.workspaceId));

  const remainingSessions = await db
    .select()
    .from(sessions)
    .where(eq(sessions.workspaceId, a.workspaceId));
  expect(remainingSessions).toEqual([]);
  const remainingMemberships = await db
    .select()
    .from(memberships)
    .where(eq(memberships.workspaceId, a.workspaceId));
  expect(remainingMemberships).toEqual([]);
  // B is untouched.
  const survivors = await db.select().from(workspaces);
  expect(survivors.map((row) => row.id)).toEqual([b.workspaceId]);
}

export function registerCrossTenantCases(current: () => CrossTenantContext): void {
  it('refuses a session in one workspace that names an agent in another', () =>
    refusesForeignAgentSession(current()));
  it("refuses a run whose workspace differs from its session's", () =>
    refusesForeignWorkspaceRun(current()));
  it('refuses a session for a user who holds no membership in that workspace', () =>
    refusesNonMemberSession(current()));
  it("refuses an agent pointing at another workspace's model connection", () =>
    refusesBorrowedModelConnection(current()));
  it('still falls an agent back to the default model when its connection is deleted', () =>
    fallsBackWhenConnectionDeleted(current()));
  it('refuses to remove a member who still owns a session in that workspace', () =>
    refusesRemovingSessionOwner(current()));
  it('deletes a whole workspace in one statement, memberships and sessions together', () =>
    deletesWholeWorkspace(current()));
}
