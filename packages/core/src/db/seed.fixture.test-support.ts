import type { MembershipRoleName } from '@indx-workspace/contracts/team';
import { afterAll, beforeAll, expect } from 'vitest';

import { connect, type Database, parseDatabaseUrl } from './client.js';
import { packagedMigrationsDir, runMigrations } from './migrate.js';
import { GENERAL_AGENT_NAME, GENERAL_AGENT_PERMISSIONS } from './seed.js';
import { agents } from './schema/agents.js';
import { memberships } from './schema/memberships.js';
import {
  SECRET_NONCE_BYTES,
  SECRET_TAG_BYTES,
  SECRET_WRAPPED_DATA_KEY_BYTES,
} from './schema/secrets.js';
import { users } from './schema/users.js';
import { workspaces } from './schema/workspaces.js';
import { workspacePrincipals } from './schema/workspace-principals.js';

/**
 * Give the enclosing `describe` its own migrated connection to `rawUrl` (`TEST_DATABASE_URL`),
 * closed after the block. Returns a reader for the connection, which exists once `beforeAll` has
 * run.
 */
export function useSeedDatabase(rawUrl: string | undefined): () => Database {
  let pool: ReturnType<typeof connect>['pool'] | undefined;
  let db: Database | undefined;

  beforeAll(async () => {
    const config = { url: parseDatabaseUrl(rawUrl), maxConnections: 4 };
    await runMigrations(config, packagedMigrationsDir());
    ({ pool, db } = connect(config));
  });

  afterAll(async () => {
    await pool?.end();
  });

  return () => {
    if (db === undefined) throw new Error('the seed test database is not connected yet');
    return db;
  };
}

/**
 * Assert that a statement was rejected by a specific named database constraint.
 *
 * Drizzle wraps driver errors, so the constraint name is not in `error.message` — it is the
 * `constraint` property of a `pg` error somewhere down the `cause` chain. Matching on the
 * message text instead would pass for ANY failure of the statement, including a typo in the
 * test's own SQL, which would make this suite claim the database enforces a rule it does not.
 */
export async function expectConstraintViolation(
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

export async function createMembershipPrincipal(
  db: Database,
  workspaceId: string,
  userId: string,
  role: MembershipRoleName = 'owner',
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

/** One workspace, one user who owns a membership in it, and one ordinary General agent there. */
export interface TenantBase {
  workspaceId: string;
  userId: string;
  principalId: string;
  agentId: string;
}

export async function seedTenantBase(
  db: Database,
  slug: string,
  email: string,
): Promise<TenantBase> {
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
  if (agent === undefined) throw new Error(`could not populate the ${slug} tenant`);
  return { workspaceId: workspace.id, userId: user.id, principalId, agentId: agent.id };
}

/** An envelope whose parts are the right SIZES. Nothing here is real cryptography. */
export function envelope(ciphertext: Buffer) {
  return {
    algorithm: 'aes-256-gcm' as const,
    masterKeyId: 'test-master-key',
    wrappedDataKey: Buffer.alloc(SECRET_WRAPPED_DATA_KEY_BYTES, 1),
    wrappedDataKeyNonce: Buffer.alloc(SECRET_NONCE_BYTES, 2),
    wrappedDataKeyTag: Buffer.alloc(SECRET_TAG_BYTES, 3),
    ciphertext,
    ciphertextNonce: Buffer.alloc(SECRET_NONCE_BYTES, 5),
    ciphertextTag: Buffer.alloc(SECRET_TAG_BYTES, 6),
  };
}
