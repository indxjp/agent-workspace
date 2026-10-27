/**
 * The acceptance test for this task: against a real PostgreSQL 17, `db:migrate` then `db:seed`
 * must leave **exactly one** agent named `General`, and that agent must be an ordinary row
 * (spec §19.5 rule 3).
 *
 * **It needs a database, and it says so when it does not have one.** `TEST_DATABASE_URL` names
 * a throwaway PostgreSQL that this file will migrate, truncate and write to — never a
 * development database. When the variable is absent the suite is SKIPPED and a warning is
 * printed naming what was not verified. Skipped is not passed: a green run without that
 * variable has not exercised any of this, which is why the warning exists — it is there for a
 * developer running `pnpm test` on a machine with no container.
 *
 * **CI is not that machine.** W1-INF-02 wired a `postgres:17-alpine` service and a job-level
 * `TEST_DATABASE_URL` into `.github/workflows/ci.yml`, and that workflow's "No test in the run
 * was skipped" step reads vitest's own JSON report and fails the build if any test did not
 * execute — so these suites cannot be skipped in CI without turning the build red.
 *
 * An earlier revision of this header said the shipping pull request declares a CI gap for these
 * suites instead. That sentence was written by W1-DB-01 (commit 1456fde) and was true then:
 * `git log -S "postgres:17-alpine" -- .github/workflows/ci.yml` shows the service arrived later,
 * in W1-INF-02 (commit bfd2d1e), which is not an ancestor of 1456fde. It was left in place
 * unedited while this file grew, by which time it had become a false statement about the pull
 * request shipping it. It is withdrawn.
 *
 * The environment-only assertions below (`readSeedOptions`) run everywhere, database or not.
 */
import { getTableConfig } from 'drizzle-orm/pg-core';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { connect, type Database, parseDatabaseUrl } from './client.js';
import { runMigrations } from './migrate.js';
import { GENERAL_AGENT_NAME, GENERAL_AGENT_PERMISSIONS, readSeedOptions, seed } from './seed.js';
import { agentFiles } from './schema/agent-files.js';
import { agentMcpServers } from './schema/agent-mcp-servers.js';
import { agentSkills } from './schema/agent-skills.js';
import { agents } from './schema/agents.js';
import { apiKeys } from './schema/api-keys.js';
import { auditEvents } from './schema/audit-events.js';
import { files } from './schema/files.js';
import { mcpServers } from './schema/mcp-servers.js';
import { memberships } from './schema/memberships.js';
import { modelConnections } from './schema/model-connections.js';
import { runs } from './schema/runs.js';
import {
  SECRET_NONCE_BYTES,
  SECRET_TAG_BYTES,
  SECRET_WRAPPED_DATA_KEY_BYTES,
  secrets,
} from './schema/secrets.js';
import { sessions } from './schema/sessions.js';
import { skills } from './schema/skills.js';
import { users } from './schema/users.js';
import { workspaces } from './schema/workspaces.js';
import { workspacePrincipals } from './schema/workspace-principals.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[seed.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the migration and the ' +
      '"exactly one General agent" assertion did NOT run. This suite is the acceptance test ' +
      'for W1-DB-01; a green result without it verifies nothing about the database.',
  );
}

/**
 * Assert that a statement was rejected by a specific named database constraint.
 *
 * Drizzle wraps driver errors, so the constraint name is not in `error.message` — it is the
 * `constraint` property of a `pg` error somewhere down the `cause` chain. Matching on the
 * message text instead would pass for ANY failure of the statement, including a typo in the
 * test's own SQL, which would make this suite claim the database enforces a rule it does not.
 */
async function expectConstraintViolation(
  statement: Promise<unknown>,
  constraint: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await statement;
  } catch (error) {
    thrown = error;
  }
  expect(
    thrown,
    `expected constraint ${constraint} to reject the statement, but it succeeded`,
  ).toBeDefined();

  const seen: string[] = [];
  let cursor: unknown = thrown;
  for (let depth = 0; depth < 10 && typeof cursor === 'object' && cursor !== null; depth += 1) {
    const name: unknown = (cursor as { constraint?: unknown }).constraint;
    if (typeof name === 'string') seen.push(name);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  expect(seen, `the rejection named no constraint; error was: ${String(thrown)}`).toContain(
    constraint,
  );
}

const OPTIONS = {
  workspaceSlug: 'seed-test',
  workspaceName: 'Seed Test Workspace',
  adminEmail: 'admin@example.com',
  adminName: 'admin',
} as const;

async function createMembershipPrincipal(
  db: Database,
  workspaceId: string,
  userId: string,
  role: 'owner' | 'admin' | 'builder' | 'viewer' = 'owner',
): Promise<string> {
  return db.transaction(async (tx) => {
    const [membership] = await tx
      .insert(memberships)
      .values({ workspaceId, userId, role })
      .returning({ id: memberships.id });
    if (membership === undefined) throw new Error('could not create the test membership');
    const [principal] = await tx
      .insert(workspacePrincipals)
      .values({ workspaceId, kind: 'membership', membershipId: membership.id })
      .returning({ id: workspacePrincipals.id });
    if (principal === undefined) throw new Error('could not create the test membership principal');
    return principal.id;
  });
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

describe('readSeedOptions (no database required)', () => {
  it('refuses to invent an administrator identity', () => {
    expect(() => readSeedOptions({})).toThrow(/BOOTSTRAP_ADMIN is not set/u);
    expect(() => readSeedOptions({ BOOTSTRAP_ADMIN: '   ' })).toThrow(
      /BOOTSTRAP_ADMIN is not set/u,
    );
  });

  it.each(['admin', 'admin@', '@example.com', 'a b@example.com', 'admin@example'])(
    'rejects %s as an administrator address',
    (value) => {
      expect(() => readSeedOptions({ BOOTSTRAP_ADMIN: value })).toThrow(/not a usable email/u);
    },
  );

  it('lower-cases the address, because the users table requires it', () => {
    expect(readSeedOptions({ BOOTSTRAP_ADMIN: ' Admin@Example.COM ' }).adminEmail).toBe(
      'admin@example.com',
    );
  });

  it('rejects a workspace slug that is not URL-safe', () => {
    expect(() =>
      readSeedOptions({ BOOTSTRAP_ADMIN: 'a@b.c', WORKSPACE_SLUG: 'Not A Slug' }),
    ).toThrow(/not a usable slug/u);
  });

  it('defaults only the values that identify nobody', () => {
    const options = readSeedOptions({ BOOTSTRAP_ADMIN: 'a@b.co' });
    expect(options.workspaceSlug).toBe('default');
    expect(options.adminEmail).toBe('a@b.co');
  });
});

describe('agents table shape', () => {
  it('has one column that marks an agent as built in, and it is nullable (§19.5 rule 3, ADR-0108 B-D1)', () => {
    const columns = getTableConfig(agents).columns.map((column) => column.name);
    expect(columns).toEqual([
      'id',
      'workspace_id',
      'name',
      'instructions',
      'model_connection_id',
      'model',
      // Added by W3-CP-06, outside this task's `Owns` cell — declared on its PR. §17 Step 5 /
      // §14.9: a reference to `runtime_profiles`, not a flag, so it does not touch this test's
      // actual point (there is still no column that could mark an agent as built in).
      'runtime_profile_id',
      'permissions',
      // Added by SDK-02-234 (S-13): a nullable, replaceable policy, not a flag — NULL means
      // "compile from permissions and the assigned resources" (today's behaviour for every row
      // this test seeds), so this test's point survives unchanged.
      'policy',
      // Added by W9-AUTH-117 (issue #117): not a flag either — a tenant-paired reference to
      // whoever created the row, so this test's point survives unchanged.
      'created_by',
      'owner_principal_id',
      // Added by #1848: the one built-in marker. NULL for every ordinary row, including General,
      // which this file's seed still creates as an ordinary, editable and deletable agent.
      'builtin_key',
      // Added by PR #403's review (issue #393): when first-run setup last configured the agent, a
      // composer preference. Not a built-in flag: the agent stays an ordinary, editable and
      // deletable row, and General is not marked by it.
      'setup_configured_at',
      // Added by issue #613: the version the row was last written from. Not a flag either.
      'materialised_version_id',
      // Added by #1851: lineage of an agent made by an agent, and when it was archived. Both
      // null for every ordinary row, and neither marks an agent as built in.
      'created_by_agent_id',
      'created_by_agent_version',
      'created_by_run_id',
      'archived_at',
      'created_at',
      'updated_at',
    ]);
  });
});

describe.skipIf(!hasDatabase)('seed against a real PostgreSQL', () => {
  let pool: ReturnType<typeof connect>['pool'];
  let db: Database;

  beforeAll(async () => {
    const config = { url: parseDatabaseUrl(rawUrl), maxConnections: 4 };
    await runMigrations(config);
    ({ pool, db } = connect(config));
    // A clean slate that does not depend on the migration having just run: this file owns the
    // database named by TEST_DATABASE_URL.
    await db.execute(
      sql`truncate table ${runs}, ${sessions}, ${agents}, ${memberships}, ${users}, ${workspaces} restart identity cascade`,
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('creates exactly one General agent, and stays at one when run again', async () => {
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
  });

  it('creates no General agent when told not to (the local runtime, issue #692)', async () => {
    await db.execute(
      sql`truncate table ${runs}, ${sessions}, ${agents}, ${memberships}, ${users}, ${workspaces} restart identity cascade`,
    );
    const result = await seed(db, { ...OPTIONS, general: false });
    expect(result.generalAgentId).toBeUndefined();
    expect(await db.select().from(agents)).toEqual([]);
    // A later seed without the option still finds or creates it: nothing was lost.
    expect((await seed(db, OPTIONS)).generalAgentId).toBeDefined();
  });

  it('creates nothing in the resource tables W2-DB-01 added', async () => {
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
  });

  it('creates one bootstrap administrator holding the owner role', async () => {
    const result = await seed(db, OPTIONS);
    const userRows = await db.select().from(users);
    expect(userRows).toHaveLength(1);
    expect(userRows[0]?.email).toBe(OPTIONS.adminEmail);

    const membershipRows = await db.select().from(memberships);
    expect(membershipRows).toHaveLength(1);
    expect(membershipRows[0]?.role).toBe('owner');
    expect(membershipRows[0]?.userId).toBe(result.adminUserId);
    expect(membershipRows[0]?.workspaceId).toBe(result.workspaceId);
  });

  it('leaves General indistinguishable from a user-created agent apart from its name', async () => {
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
  });

  it('refuses a non-lower-case email at the database, not only in Zod', async () => {
    await expectConstraintViolation(
      db.insert(users).values({ email: 'Mixed@Example.com', name: 'x' }),
      'users_email_lowercase',
    );
  });

  it('refuses an agent whose name is only whitespace', async () => {
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
  });

  it('refuses a membership role outside the four of §21', async () => {
    const result = await seed(db, OPTIONS);
    await expectConstraintViolation(
      db.execute(
        sql`insert into ${memberships} (workspace_id, user_id, role) values (${result.workspaceId}, ${result.adminUserId}, 'superuser')`,
      ),
      'memberships_role_valid',
    );
  });

  it('refuses a completed run with no end time (runs_ended_at_iff_terminal)', async () => {
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
  });
});

/**
 * The §25 cross-tenant integrity suite.
 *
 * Every case below is an INSERT or DELETE that a real PostgreSQL either accepts or rejects.
 * Three of them are the exact statements a review of this schema demonstrated the database used
 * to accept: a session in one workspace naming an agent in another, a run carrying a
 * workspace_id different from its session's, and a session owned by a user holding no membership
 * in that workspace. They are here so that a change reopening any of those holes fails a test
 * rather than shipping.
 *
 * Rejections are matched by constraint NAME, not by message text, so a test cannot pass because
 * the statement failed for some unrelated reason such as a typo in its own SQL. Every rejection
 * is paired with the corresponding statement that must still be ACCEPTED — a constraint that
 * rejects everything is not isolation, it is an outage.
 *
 * This suite owns its own connection and truncates before each case, because it deliberately
 * creates a second workspace and the suite above counts rows globally.
 */
describe.skipIf(!hasDatabase)('§25 cross-tenant referential integrity', () => {
  let pool: ReturnType<typeof connect>['pool'];
  let db: Database;

  /** One workspace, one user who is a member of it, one agent and one model connection in it. */
  interface Tenant {
    workspaceId: string;
    userId: string;
    principalId: string;
    agentId: string;
    modelConnectionId: string;
  }

  async function createTenant(slug: string, email: string): Promise<Tenant> {
    const [workspace] = await db
      .insert(workspaces)
      .values({ slug, name: `Workspace ${slug}` })
      .returning();
    const [user] = await db.insert(users).values({ email, name: email }).returning();
    if (workspace === undefined || user === undefined) {
      throw new Error(`could not create the ${slug} tenant`);
    }
    const principalId = await createMembershipPrincipal(db, workspace.id, user.id);
    const [connection] = await db
      .insert(modelConnections)
      .values({ workspaceId: workspace.id, name: 'Claude', provider: 'anthropic', config: {} })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        workspaceId: workspace.id,
        name: GENERAL_AGENT_NAME,
        instructions: '',
        permissions: GENERAL_AGENT_PERMISSIONS,
        createdBy: user.id,
        ownerPrincipalId: principalId,
      })
      .returning();
    if (connection === undefined || agent === undefined) {
      throw new Error(`could not populate the ${slug} tenant`);
    }
    return {
      workspaceId: workspace.id,
      userId: user.id,
      principalId,
      agentId: agent.id,
      modelConnectionId: connection.id,
    };
  }

  let a: Tenant;
  let b: Tenant;

  beforeAll(async () => {
    const config = { url: parseDatabaseUrl(rawUrl), maxConnections: 4 };
    await runMigrations(config);
    ({ pool, db } = connect(config));
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate table ${runs}, ${sessions}, ${agents}, ${modelConnections}, ${memberships}, ${users}, ${workspaces} restart identity cascade`,
    );
    a = await createTenant('tenant-a', 'a@example.com');
    b = await createTenant('tenant-b', 'b@example.com');
  });

  it('refuses a session in one workspace that names an agent in another', async () => {
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
  });

  it("refuses a run whose workspace differs from its session's", async () => {
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
  });

  it('refuses a session for a user who holds no membership in that workspace', async () => {
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
  });

  it("refuses an agent pointing at another workspace's model connection", async () => {
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
  });

  it('still falls an agent back to the default model when its connection is deleted', async () => {
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
  });

  it('refuses to remove a member who still owns a session in that workspace', async () => {
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
  });

  it('deletes a whole workspace in one statement, memberships and sessions together', async () => {
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
  });
});

/**
 * The same §25 proof as the suite above, for the tables W2-DB-01 adds, plus the shape
 * constraints those tables carry.
 *
 * Every case is one statement PostgreSQL either accepts or rejects, and every rejection is
 * matched by constraint NAME rather than by message text — a test that passes because the
 * statement failed for some other reason is a test that proves nothing. Every rejection is
 * paired with the statement that must still be ACCEPTED, because a constraint that rejects
 * everything is not isolation, it is an outage.
 */
describe.skipIf(!hasDatabase)('§25 tenant isolation over the Wave 2 resource tables', () => {
  let pool: ReturnType<typeof connect>['pool'];
  let db: Database;

  /** One workspace with one of every resource this task added. */
  interface ResourceTenant {
    workspaceId: string;
    userId: string;
    principalId: string;
    agentId: string;
    skillId: string;
    fileId: string;
    secretId: string;
    mcpServerId: string;
  }

  /** An envelope whose parts are the right SIZES. Nothing here is real cryptography. */
  function envelope() {
    return {
      algorithm: 'aes-256-gcm' as const,
      masterKeyId: 'test-master-key',
      wrappedDataKey: Buffer.alloc(SECRET_WRAPPED_DATA_KEY_BYTES, 1),
      wrappedDataKeyNonce: Buffer.alloc(SECRET_NONCE_BYTES, 2),
      wrappedDataKeyTag: Buffer.alloc(SECRET_TAG_BYTES, 3),
      ciphertext: Buffer.alloc(24, 4),
      ciphertextNonce: Buffer.alloc(SECRET_NONCE_BYTES, 5),
      ciphertextTag: Buffer.alloc(SECRET_TAG_BYTES, 6),
    };
  }

  async function createResourceTenant(slug: string, email: string): Promise<ResourceTenant> {
    const [workspace] = await db
      .insert(workspaces)
      .values({ slug, name: `Workspace ${slug}` })
      .returning();
    const [user] = await db.insert(users).values({ email, name: email }).returning();
    if (workspace === undefined || user === undefined) {
      throw new Error(`could not create the ${slug} tenant`);
    }
    const principalId = await createMembershipPrincipal(db, workspace.id, user.id);
    const [agent] = await db
      .insert(agents)
      .values({
        workspaceId: workspace.id,
        name: GENERAL_AGENT_NAME,
        instructions: '',
        permissions: GENERAL_AGENT_PERMISSIONS,
        createdBy: user.id,
        ownerPrincipalId: principalId,
      })
      .returning();
    const [skill] = await db
      .insert(skills)
      .values({
        workspaceId: workspace.id,
        name: 'invoice-review',
        skillMd: '---\nname: invoice-review\n---\n\nReview invoices.\n',
        createdBy: user.id,
        ownerPrincipalId: principalId,
      })
      .returning();
    const [file] = await db
      .insert(files)
      .values({
        workspaceId: workspace.id,
        path: 'contracts/agreement.pdf',
        kind: 'file',
        storageKey: `${slug}/contracts/agreement.pdf`,
        sizeBytes: 1024,
        contentType: 'application/pdf',
        createdBy: user.id,
        ownerPrincipalId: principalId,
      })
      .returning();
    const [secret] = await db
      .insert(secrets)
      .values({ workspaceId: workspace.id, name: 'GITHUB_TOKEN', ...envelope() })
      .returning();
    if (agent === undefined || skill === undefined || file === undefined || secret === undefined) {
      throw new Error(`could not populate the ${slug} tenant`);
    }
    const [server] = await db
      .insert(mcpServers)
      .values({
        workspaceId: workspace.id,
        name: 'GitHub',
        transport: 'http',
        url: 'https://example.com/mcp',
        authType: 'bearer',
        credentialSecretId: secret.id,
        createdBy: user.id,
        ownerPrincipalId: principalId,
      })
      .returning();
    if (server === undefined) throw new Error(`could not create the ${slug} connector`);
    return {
      workspaceId: workspace.id,
      userId: user.id,
      principalId,
      agentId: agent.id,
      skillId: skill.id,
      fileId: file.id,
      secretId: secret.id,
      mcpServerId: server.id,
    };
  }

  let a: ResourceTenant;
  let b: ResourceTenant;

  beforeAll(async () => {
    const config = { url: parseDatabaseUrl(rawUrl), maxConnections: 4 };
    await runMigrations(config);
    ({ pool, db } = connect(config));
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // Truncating `workspaces` cascades into every table that references it, which is every
    // table this task added.
    await db.execute(sql`truncate table ${workspaces}, ${users} restart identity cascade`);
    a = await createResourceTenant('res-a', 'res-a@example.com');
    b = await createResourceTenant('res-b', 'res-b@example.com');
  });

  it("refuses to assign another workspace's skill to an agent", async () => {
    await expectConstraintViolation(
      db.execute(
        sql`insert into ${agentSkills} (workspace_id, agent_id, skill_id) values (${a.workspaceId}, ${a.agentId}, ${b.skillId})`,
      ),
      'agent_skills_skill_workspace_fk',
    );

    const accepted = await db
      .insert(agentSkills)
      .values({ workspaceId: a.workspaceId, agentId: a.agentId, skillId: a.skillId })
      .returning();
    expect(accepted).toHaveLength(1);
  });

  it("refuses to assign another workspace's connector to an agent", async () => {
    await expectConstraintViolation(
      db.execute(
        sql`insert into ${agentMcpServers} (workspace_id, agent_id, mcp_server_id) values (${a.workspaceId}, ${a.agentId}, ${b.mcpServerId})`,
      ),
      'agent_mcp_servers_server_workspace_fk',
    );

    const accepted = await db
      .insert(agentMcpServers)
      .values({ workspaceId: a.workspaceId, agentId: a.agentId, mcpServerId: a.mcpServerId })
      .returning();
    expect(accepted).toHaveLength(1);
  });

  it("refuses to grant an agent another workspace's file", async () => {
    await expectConstraintViolation(
      db.execute(
        sql`insert into ${agentFiles} (workspace_id, agent_id, file_id, access) values (${a.workspaceId}, ${a.agentId}, ${b.fileId}, 'read')`,
      ),
      'agent_files_file_workspace_fk',
    );

    const accepted = await db
      .insert(agentFiles)
      .values({
        workspaceId: a.workspaceId,
        agentId: a.agentId,
        fileId: a.fileId,
        access: 'read-write',
      })
      .returning();
    expect(accepted).toHaveLength(1);
  });

  it("refuses a connector authenticating with another workspace's secret", async () => {
    await expectConstraintViolation(
      db.insert(mcpServers).values({
        workspaceId: a.workspaceId,
        name: 'Borrowed credential',
        transport: 'sse',
        url: 'https://example.com/mcp/sse',
        authType: 'api-key',
        credentialSecretId: b.secretId,
        createdBy: a.userId,
        ownerPrincipalId: a.principalId,
      }),
      'mcp_servers_credential_secret_workspace_fk',
    );

    const accepted = await db
      .insert(mcpServers)
      .values({
        workspaceId: a.workspaceId,
        name: 'Own credential',
        transport: 'sse',
        url: 'https://example.com/mcp/sse',
        authType: 'api-key',
        credentialSecretId: a.secretId,
        createdBy: a.userId,
        ownerPrincipalId: a.principalId,
      })
      .returning();
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.credentialSecretId).toBe(a.secretId);
  });

  it('refuses to delete a secret a connector still authenticates with', async () => {
    // `ON DELETE RESTRICT` on the tenant-paired reference. The alternative — cascade, or set
    // null — is a connector that silently stops authenticating.
    await expectConstraintViolation(
      db.delete(secrets).where(eq(secrets.id, a.secretId)),
      'mcp_servers_credential_secret_workspace_fk',
    );

    // Detach the connector and the same delete is accepted, so the constraint is proved to
    // reject the dangerous statement rather than every statement.
    await db
      .update(mcpServers)
      .set({ authType: 'none', credentialSecretId: null })
      .where(eq(mcpServers.id, a.mcpServerId));
    await db.delete(secrets).where(eq(secrets.id, a.secretId));
    expect(await db.select().from(secrets).where(eq(secrets.id, a.secretId))).toEqual([]);
  });

  it('deletes a whole workspace and takes its resources with it', async () => {
    await db.delete(workspaces).where(eq(workspaces.id, a.workspaceId));

    expect(await db.select().from(skills).where(eq(skills.workspaceId, a.workspaceId))).toEqual([]);
    expect(await db.select().from(files).where(eq(files.workspaceId, a.workspaceId))).toEqual([]);
    expect(
      await db.select().from(mcpServers).where(eq(mcpServers.workspaceId, a.workspaceId)),
    ).toEqual([]);
    expect(await db.select().from(secrets).where(eq(secrets.workspaceId, a.workspaceId))).toEqual(
      [],
    );
    // B is untouched.
    const survivors = await db.select().from(workspaces);
    expect(survivors.map((row) => row.id)).toEqual([b.workspaceId]);
  });
});

/**
 * The shape constraints the Wave 2 resource tables carry, each proved by one rejected statement
 * and one accepted statement.
 *
 * The `secrets` cases are the ones this task's brief asks for by name: the table has to make
 * storing a plaintext secret awkward. What follows is the measurement of "awkward", and it is
 * narrower than an earlier revision of this comment claimed. What is measured is that a row
 * missing an envelope part, or carrying one at the wrong size, is refused by constraint name.
 * It is NOT measured — because it is not true — that a caller who never ran AES-256-GCM is
 * refused: `goodEnvelope` below is exactly such a caller. It fabricates every companion with
 * `Buffer.alloc` and sets `ciphertext` to the literal `'not-really-encrypted'`, and the
 * assertions here require PostgreSQL to ACCEPT it. That row is this suite's own counterexample
 * to the stronger claim, and it is left in place deliberately: it is what the constraints
 * actually permit. Proving a stored value is genuinely encrypted is W2-CP-02's acceptance.
 */
describe.skipIf(!hasDatabase)('Wave 2 resource tables — shape constraints', () => {
  let pool: ReturnType<typeof connect>['pool'];
  let db: Database;
  let workspaceId: string;
  /** `created_by` is tenant-paired to `memberships` (issue #117); every test in this block needs
   *  a real member of `workspaceId` to attribute its inserts to. */
  let ownerUserId: string;
  let ownerPrincipalId: string;

  const goodEnvelope = {
    algorithm: 'aes-256-gcm' as const,
    masterKeyId: 'test-master-key',
    wrappedDataKey: Buffer.alloc(SECRET_WRAPPED_DATA_KEY_BYTES, 1),
    wrappedDataKeyNonce: Buffer.alloc(SECRET_NONCE_BYTES, 2),
    wrappedDataKeyTag: Buffer.alloc(SECRET_TAG_BYTES, 3),
    ciphertext: Buffer.from('not-really-encrypted'),
    ciphertextNonce: Buffer.alloc(SECRET_NONCE_BYTES, 5),
    ciphertextTag: Buffer.alloc(SECRET_TAG_BYTES, 6),
  };

  beforeAll(async () => {
    const config = { url: parseDatabaseUrl(rawUrl), maxConnections: 4 };
    await runMigrations(config);
    ({ pool, db } = connect(config));
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table ${workspaces}, ${users} restart identity cascade`);
    const [workspace] = await db
      .insert(workspaces)
      .values({ slug: 'shapes', name: 'Shapes' })
      .returning();
    if (workspace === undefined) throw new Error('could not create the shapes workspace');
    workspaceId = workspace.id;
    const [owner] = await db
      .insert(users)
      .values({ email: 'shapes-owner@example.test', name: 'Shapes Owner' })
      .returning();
    if (owner === undefined) throw new Error('could not create the shapes owner');
    ownerUserId = owner.id;
    ownerPrincipalId = await createMembershipPrincipal(db, workspaceId, ownerUserId);
  });

  it('refuses a secret whose nonce is not 12 bytes', async () => {
    await expectConstraintViolation(
      db.insert(secrets).values({
        workspaceId,
        name: 'ANTHROPIC_API_KEY',
        ...goodEnvelope,
        ciphertextNonce: Buffer.alloc(8, 5),
      }),
      'secrets_nonce_sizes',
    );

    const accepted = await db
      .insert(secrets)
      .values({ workspaceId, name: 'ANTHROPIC_API_KEY', ...goodEnvelope })
      .returning();
    expect(accepted).toHaveLength(1);
  });

  it('refuses a secret whose authentication tag is not 16 bytes', async () => {
    await expectConstraintViolation(
      db.insert(secrets).values({
        workspaceId,
        name: 'AZURE_OPENAI_API_KEY',
        ...goodEnvelope,
        wrappedDataKeyTag: Buffer.alloc(4, 3),
      }),
      'secrets_tag_sizes',
    );
  });

  it('refuses a secret whose wrapped data key is not an AES-256 key', async () => {
    await expectConstraintViolation(
      db.insert(secrets).values({
        workspaceId,
        name: 'INTERNAL_DATABASE_TOKEN',
        ...goodEnvelope,
        wrappedDataKey: Buffer.alloc(16, 1),
      }),
      'secrets_wrapped_data_key_size',
    );
  });

  it('refuses a secret whose name is not environment-variable shaped', async () => {
    await expectConstraintViolation(
      db.insert(secrets).values({ workspaceId, name: 'github token', ...goodEnvelope }),
      'secrets_name_shape',
    );
  });

  it('refuses a connector that claims an authentication it stores no credential for', async () => {
    await expectConstraintViolation(
      db.insert(mcpServers).values({
        workspaceId,
        name: 'Unauthenticated bearer',
        transport: 'http',
        url: 'https://example.com/mcp',
        authType: 'bearer',
        createdBy: ownerUserId,
        ownerPrincipalId,
      }),
      'mcp_servers_credential_required',
    );

    const accepted = await db
      .insert(mcpServers)
      .values({
        workspaceId,
        name: 'Anonymous',
        transport: 'http',
        url: 'https://example.com/mcp',
        authType: 'none',
        createdBy: ownerUserId,
        ownerPrincipalId,
      })
      .returning();
    expect(accepted).toHaveLength(1);
  });

  it('refuses a stdio connector that carries a URL', async () => {
    await expectConstraintViolation(
      db.insert(mcpServers).values({
        workspaceId,
        name: 'Confused transport',
        transport: 'stdio',
        command: 'npx',
        url: 'https://example.com/mcp',
        createdBy: ownerUserId,
        ownerPrincipalId,
      }),
      'mcp_servers_remote_has_url',
    );

    const accepted = await db
      .insert(mcpServers)
      .values({
        workspaceId,
        name: 'Filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
        createdBy: ownerUserId,
        ownerPrincipalId,
      })
      .returning();
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.args).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/workspace',
    ]);
  });

  it('refuses a file path that climbs out of the workspace', async () => {
    await expectConstraintViolation(
      db.insert(files).values({
        workspaceId,
        path: '../etc/passwd',
        kind: 'file',
        storageKey: 'x',
        createdBy: ownerUserId,
        ownerPrincipalId,
      }),
      'files_path_no_dot_segments',
    );

    const accepted = await db
      .insert(files)
      .values({
        workspaceId,
        path: 'contracts/pricing.xlsx',
        kind: 'file',
        storageKey: 'x',
        createdBy: ownerUserId,
        ownerPrincipalId,
      })
      .returning();
    expect(accepted).toHaveLength(1);
  });

  it('refuses a file row with no object behind it, and a folder with one', async () => {
    await expectConstraintViolation(
      db.insert(files).values({
        workspaceId,
        path: 'orphan.md',
        kind: 'file',
        createdBy: ownerUserId,
        ownerPrincipalId,
      }),
      'files_storage_key_iff_file',
    );
    await expectConstraintViolation(
      db.insert(files).values({
        workspaceId,
        path: 'contracts',
        kind: 'folder',
        storageKey: 'x',
        createdBy: ownerUserId,
        ownerPrincipalId,
      }),
      'files_storage_key_iff_file',
    );

    const accepted = await db
      .insert(files)
      .values({
        workspaceId,
        path: 'contracts',
        kind: 'folder',
        createdBy: ownerUserId,
        ownerPrincipalId,
      })
      .returning();
    expect(accepted).toHaveLength(1);
  });

  it('refuses a skill whose name would not be a directory name', async () => {
    await expectConstraintViolation(
      db.insert(skills).values({
        workspaceId,
        name: 'Invoice Review',
        skillMd: '# x',
        createdBy: ownerUserId,
        ownerPrincipalId,
      }),
      'skills_name_shape',
    );

    const accepted = await db
      .insert(skills)
      .values({
        workspaceId,
        name: 'invoice-review',
        skillMd: '# x',
        createdBy: ownerUserId,
        ownerPrincipalId,
      })
      .returning();
    expect(accepted).toHaveLength(1);
  });

  it('refuses an API key whose role is outside the four of §21', async () => {
    await expectConstraintViolation(
      db.execute(
        sql`insert into ${apiKeys} (workspace_id, name, role, key_prefix, key_hash) values (${workspaceId}, 'CI', 'superuser', 'ak_live_', 'hash')`,
      ),
      'api_keys_role_valid',
    );

    const accepted = await db
      .insert(apiKeys)
      .values({
        workspaceId,
        name: 'CI',
        role: 'builder',
        keyPrefix: 'ak_live_',
        keyHash: 'a-hash-nobody-can-present',
      })
      .returning();
    expect(accepted).toHaveLength(1);
  });

  it('refuses an audit action outside the list §36 prints', async () => {
    await expectConstraintViolation(
      db.execute(
        sql`insert into ${auditEvents} (workspace_id, actor_label, action, subject_label) values (${workspaceId}, 'Ito', 'agent-exfiltrated', 'Customer Support Agent')`,
      ),
      'audit_events_action_valid',
    );

    const accepted = await db
      .insert(auditEvents)
      .values({
        workspaceId,
        actorLabel: 'Ito',
        action: 'agent-changed',
        subjectLabel: 'Customer Support Agent',
      })
      .returning();
    expect(accepted).toHaveLength(1);
  });

  it('keeps an audit line readable after the actor is deleted', async () => {
    // §36 audits "user deleted", so a trail that forbade deleting an audited user would forbid
    // the action it exists to record. The link goes NULL; the stored labels still read.
    const [actor] = await db
      .insert(users)
      .values({ email: 'ito@example.com', name: 'Ito' })
      .returning();
    if (actor === undefined) throw new Error('could not create the actor');
    await db.insert(auditEvents).values({
      workspaceId,
      actorUserId: actor.id,
      actorLabel: 'Ito',
      action: 'agent-changed',
      subjectLabel: 'Customer Support Agent',
    });

    await db.delete(users).where(eq(users.id, actor.id));

    const [row] = await db.select().from(auditEvents);
    expect(row?.actorUserId).toBeNull();
    expect(row?.actorLabel).toBe('Ito');
    expect(row?.subjectLabel).toBe('Customer Support Agent');
  });
});
