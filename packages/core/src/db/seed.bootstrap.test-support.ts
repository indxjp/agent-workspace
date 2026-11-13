import { and, eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';

import type { Database } from './client.js';
import { GENERAL_AGENT_NAME, GENERAL_AGENT_PERMISSIONS, seed } from './seed.js';
import { expectConstraintViolation } from './seed.fixture.test-support.js';
import { agentFiles } from './schema/agent-files.js';
import { agentMcpServers } from './schema/agent-mcp-servers.js';
import { agentSkills } from './schema/agent-skills.js';
import { agents } from './schema/agents.js';
import { apiKeys } from './schema/api-keys.js';
import { auditEvents } from './schema/audit-events.js';
import { files } from './schema/files.js';
import { mcpServers } from './schema/mcp-servers.js';
import { memberships } from './schema/memberships.js';
import { runs } from './schema/runs.js';
import { secrets } from './schema/secrets.js';
import { sessions } from './schema/sessions.js';
import { skills } from './schema/skills.js';
import { users } from './schema/users.js';
import { workspaces } from './schema/workspaces.js';
import { workspacePrincipals } from './schema/workspace-principals.js';

const OPTIONS = {
  workspaceSlug: 'seed-test',
  workspaceName: 'Seed Test Workspace',
  adminEmail: 'admin@example.com',
  adminName: 'admin',
} as const;

/** The truncation that gives a seed case a clean slate, whether or not the migration just ran. */
export async function truncateSeedTables(db: Database): Promise<void> {
  await db.execute(
    sql`truncate table ${runs}, ${sessions}, ${agents}, ${memberships}, ${users}, ${workspaces} restart identity cascade`,
  );
}

async function requireMembershipPrincipalId(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<string> {
  const [principal] = await db
    .select({ id: workspacePrincipals.id })
    .from(workspacePrincipals)
    .innerJoin(memberships, eq(workspacePrincipals.membershipId, memberships.id))
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
  if (principal === undefined) throw new Error('the test membership has no workspace principal');
  return principal.id;
}

async function seedTwiceKeepsOneGeneral(db: Database): Promise<void> {
  const first = await seed(db, OPTIONS);
  const second = await seed(db, OPTIONS);
  expect(second).toEqual(first);

  const workspaceRows = await db.select().from(workspaces);
  expect(workspaceRows).toHaveLength(1);

  const general = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, first.workspaceId), eq(agents.name, GENERAL_AGENT_NAME)));
  expect(general).toHaveLength(1);

  const allAgents = await db.select().from(agents);
  expect(allAgents).toHaveLength(1);
  expect(allAgents[0]?.permissions).toEqual(GENERAL_AGENT_PERMISSIONS);
  expect(allAgents[0]?.modelConnectionId).toBeNull();
  expect(allAgents[0]?.model).toBeNull();
}

async function seedWithoutGeneral(db: Database): Promise<void> {
  await truncateSeedTables(db);
  const result = await seed(db, { ...OPTIONS, general: false });
  expect(result.generalAgentId).toBeUndefined();
  expect(await db.select().from(agents)).toEqual([]);
  // A later seed without the option still finds or creates it: nothing was lost.
  expect((await seed(db, OPTIONS)).generalAgentId).toBeDefined();
}

async function seedCreatesNoResources(db: Database): Promise<void> {
  // §19.5 rule 3's General agent is the whole of the seed's product. A seed that also created
  // a skill, a connector, a file, an API key or an audit row would be a deployment shipping
  // state nobody chose — and it would make "exactly one General agent" the only thing the
  // suite above actually pinned. Asserted per table by name so a failure says which one.
  await seed(db, OPTIONS);
  expect(await db.select().from(skills)).toEqual([]);
  expect(await db.select().from(mcpServers)).toEqual([]);
  expect(await db.select().from(files)).toEqual([]);
  expect(await db.select().from(agentSkills)).toEqual([]);
  expect(await db.select().from(agentMcpServers)).toEqual([]);
  expect(await db.select().from(agentFiles)).toEqual([]);
  expect(await db.select().from(apiKeys)).toEqual([]);
  expect(await db.select().from(secrets)).toEqual([]);
  expect(await db.select().from(auditEvents)).toEqual([]);
}

async function seedCreatesOwnerAdministrator(db: Database): Promise<void> {
  const result = await seed(db, OPTIONS);
  const userRows = await db.select().from(users);
  expect(userRows).toHaveLength(1);
  expect(userRows[0]?.email).toBe(OPTIONS.adminEmail);

  const membershipRows = await db.select().from(memberships);
  expect(membershipRows).toHaveLength(1);
  expect(membershipRows[0]?.role).toBe('owner');
  expect(membershipRows[0]?.userId).toBe(result.adminUserId);
  expect(membershipRows[0]?.workspaceId).toBe(result.workspaceId);
}

async function generalMatchesUserCreatedAgent(db: Database): Promise<void> {
  const result = await seed(db, OPTIONS);
  const ownerPrincipalId = await requireMembershipPrincipalId(
    db,
    result.workspaceId,
    result.adminUserId,
  );
  // Insert a second agent exactly the way the §17 create flow would, with the same settings.
  await db
    .insert(agents)
    .values({
      workspaceId: result.workspaceId,
      name: 'Customer Support Agent',
      instructions: '',
      permissions: GENERAL_AGENT_PERMISSIONS,
      createdBy: result.adminUserId,
      ownerPrincipalId,
    })
    .onConflictDoNothing({ target: [agents.workspaceId, agents.name] });

  const rows = await db.select().from(agents).orderBy(agents.name);
  expect(rows).toHaveLength(2);
  const [userCreated, general] = rows;
  expect(userCreated?.name).toBe('Customer Support Agent');
  expect(general?.name).toBe(GENERAL_AGENT_NAME);

  // Every column that is not the identity or the name must be equal. If a later change adds
  // a marker column to distinguish the built-in agent, this fails.
  const comparable = (row: (typeof rows)[number] | undefined) => ({
    workspaceId: row?.workspaceId,
    instructions: row?.instructions,
    modelConnectionId: row?.modelConnectionId,
    model: row?.model,
    permissions: row?.permissions,
    ownerPrincipalId: row?.ownerPrincipalId,
  });
  expect(comparable(general)).toEqual(comparable(userCreated));
}

async function refusesBlankAgentName(db: Database): Promise<void> {
  const result = await seed(db, OPTIONS);
  const ownerPrincipalId = await requireMembershipPrincipalId(
    db,
    result.workspaceId,
    result.adminUserId,
  );
  await expectConstraintViolation(
    db.insert(agents).values({
      workspaceId: result.workspaceId,
      name: '   ',
      instructions: '',
      permissions: GENERAL_AGENT_PERMISSIONS,
      createdBy: result.adminUserId,
      ownerPrincipalId,
    }),
    'agents_name_not_blank',
  );
}

async function refusesUnknownMembershipRole(db: Database): Promise<void> {
  const result = await seed(db, OPTIONS);
  await expectConstraintViolation(
    db.execute(
      sql`insert into ${memberships} (workspace_id, user_id, role) values (${result.workspaceId}, ${result.adminUserId}, 'superuser')`,
    ),
    'memberships_role_valid',
  );
}

async function refusesCompletedRunWithoutEnd(db: Database): Promise<void> {
  const result = await seed(db, OPTIONS);
  const agentId = result.generalAgentId;
  if (agentId === undefined) throw new Error('the seed created no General agent');
  const ownerPrincipalId = await requireMembershipPrincipalId(
    db,
    result.workspaceId,
    result.adminUserId,
  );
  const [session] = await db
    .insert(sessions)
    .values({
      workspaceId: result.workspaceId,
      userId: result.adminUserId,
      agentId,
      ownerPrincipalId,
    })
    .returning();
  expect(session).toBeDefined();
  await expectConstraintViolation(
    db.insert(runs).values({
      workspaceId: result.workspaceId,
      sessionId: session?.id ?? '',
      status: 'completed',
    }),
    'runs_ended_at_iff_terminal',
  );
  // …and the positive case: the same insert with an end time is accepted, so the constraint
  // is proved to reject the bad row rather than every row.
  const accepted = await db
    .insert(runs)
    .values({
      workspaceId: result.workspaceId,
      sessionId: session?.id ?? '',
      status: 'completed',
      startedAt: new Date(Date.now() - 1000),
      endedAt: new Date(),
    })
    .returning();
  expect(accepted).toHaveLength(1);
  expect(accepted[0]?.costUsd).toBe('0.000000');
}

export function registerBootstrapCases(database: () => Database): void {
  it('creates exactly one General agent, and stays at one when run again', () =>
    seedTwiceKeepsOneGeneral(database()));
  it('creates no General agent when told not to (the local runtime, issue #692)', () =>
    seedWithoutGeneral(database()));
  it('creates nothing in the resource tables W2-DB-01 added', () =>
    seedCreatesNoResources(database()));
  it('creates one bootstrap administrator holding the owner role', () =>
    seedCreatesOwnerAdministrator(database()));
  it('leaves General indistinguishable from a user-created agent apart from its name', () =>
    generalMatchesUserCreatedAgent(database()));
  it('refuses a non-lower-case email at the database, not only in Zod', async () => {
    await expectConstraintViolation(
      database().insert(users).values({ email: 'Mixed@Example.com', name: 'x' }),
      'users_email_lowercase',
    );
  });
  it('refuses an agent whose name is only whitespace', () => refusesBlankAgentName(database()));
  it('refuses a membership role outside the four of §21', () =>
    refusesUnknownMembershipRole(database()));
  it('refuses a completed run with no end time (runs_ended_at_iff_terminal)', () =>
    refusesCompletedRunWithoutEnd(database()));
}
