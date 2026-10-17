/**
 * The bootstrap seed — `pnpm db:seed`.
 *
 * It creates the three rows a brand-new deployment needs before anybody can do anything, and
 * nothing else:
 *
 *   1. one workspace;
 *   2. one bootstrap administrator (spec §21: "A local bootstrap administrator may be
 *      supported for initial setup") with an `owner` membership;
 *   3. the built-in **General** agent of §19.5 rule 3.
 *
 * **General is an ordinary row.** §19.5 rule 3 says it "is an ordinary row in `agents`,
 * editable and deletable like any other". So it is inserted through the same table, the same
 * columns and the same constraints a user-created agent would use. There is no `is_builtin`
 * column to set, no reserved id, and nothing anywhere in this repository branches on the name
 * "General". Its settings are §19.5's: default model (`model_connection_id` and `model` both
 * NULL), no files, no connectors, and a read-only sandbox — which in §17 Step 4's vocabulary
 * is `readFiles` and nothing else.
 *
 * **Idempotent by natural key, not by counting.** Every insert is `ON CONFLICT DO NOTHING`
 * against a real unique constraint — `workspaces.slug`, `users.email`,
 * `memberships (workspace_id, user_id)`, `agents (workspace_id, name)` — and the whole seed
 * runs in one transaction. Running it twice is a no-op; running it against a half-seeded
 * database completes it. Nothing here counts rows and infers a state from the count.
 *
 * **`BOOTSTRAP_ADMIN` is required.** There is no default administrator identity. A seed that
 * invents one creates an account nobody chose, in a product whose §21 authorization model
 * hangs off exactly this row. Spec §37 lists `BOOTSTRAP_ADMIN` among the four deployment-level
 * environment values for this reason.
 */
import { pathToFileURL } from 'node:url';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { connect, readDatabaseConfig, type Database, type DatabaseConfig } from './client.js';
import { type AgentPermissions, agents } from './schema/agents.js';
import { memberships } from './schema/memberships.js';
import { users } from './schema/users.js';
import { workspaces } from './schema/workspaces.js';
import { workspacePrincipals } from './schema/workspace-principals.js';

/** §19.5 rule 3. The name is the only thing that distinguishes this agent from any other. */
export const GENERAL_AGENT_NAME = 'General';

/** §19.5 rule 3's "read-only sandbox", in §17 Step 4's four flags. */
export const GENERAL_AGENT_PERMISSIONS: AgentPermissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

const DEFAULT_WORKSPACE_SLUG = 'default';
const DEFAULT_WORKSPACE_NAME = 'Default Workspace';

/**
 * Same shape the `users_email_shape` CHECK enforces, so the application rejects a bad address
 * with a readable message before the database rejects it with a constraint name.
 */
const BootstrapEmail = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u, 'must look like an email address');

const WorkspaceSlug = z
  .string()
  .trim()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u, 'must be a lower-case URL-safe slug');

/** What the seed will create. Everything is resolved and validated before anything is written. */
export interface SeedOptions {
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  readonly adminEmail: string;
  readonly adminName: string;
  /**
   * Create the `General` agent (default). The local runtime turns it off (issue #692): a project's
   * agents come from its own `agents/`, and an extra one has no runtime profile and fails to start.
   */
  readonly general?: boolean;
}

/**
 * Resolve the seed options from the environment, rejecting — by name — anything missing or
 * malformed. Nothing is defaulted except the workspace's own slug and name, which identify no
 * one and grant nothing.
 */
export function readSeedOptions(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SeedOptions {
  const rawAdmin = env['BOOTSTRAP_ADMIN'];
  if (rawAdmin === undefined || rawAdmin.trim() === '') {
    throw new Error(
      'BOOTSTRAP_ADMIN is not set. The seed will not invent an administrator identity: set it ' +
        'to the email address of the first workspace owner (spec §37) and run `pnpm db:seed` again.',
    );
  }
  const admin = BootstrapEmail.safeParse(rawAdmin);
  if (!admin.success) {
    throw new Error(`BOOTSTRAP_ADMIN is not a usable email address: ${admin.error.message}`);
  }
  const slug = WorkspaceSlug.safeParse(env['WORKSPACE_SLUG'] ?? DEFAULT_WORKSPACE_SLUG);
  if (!slug.success) {
    throw new Error(`WORKSPACE_SLUG is not a usable slug: ${slug.error.message}`);
  }
  const email = admin.data.toLowerCase();
  const rawWorkspaceName = env['WORKSPACE_NAME']?.trim();
  const rawAdminName = env['BOOTSTRAP_ADMIN_NAME']?.trim();
  return {
    workspaceSlug: slug.data,
    workspaceName:
      rawWorkspaceName === undefined || rawWorkspaceName === ''
        ? DEFAULT_WORKSPACE_NAME
        : rawWorkspaceName,
    adminEmail: email,
    // A display name is cosmetic; deriving it from the local part is better than inventing a
    // person's name, and the administrator can change it in the UI.
    adminName:
      rawAdminName === undefined || rawAdminName === ''
        ? (email.split('@')[0] ?? email)
        : rawAdminName,
  };
}

/** The ids the seed settled on, whether it created the rows or found them already there. */
export interface SeedResult {
  readonly workspaceId: string;
  readonly adminUserId: string;
  /** Absent when the seed was told not to create the `General` agent. */
  readonly generalAgentId?: string;
}

/**
 * Insert the bootstrap rows, or leave the existing ones untouched. Runs in one transaction:
 * either the whole bootstrap state exists afterwards or none of this attempt's part of it does.
 */
export async function seed(db: Database, options: SeedOptions): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    await tx
      .insert(workspaces)
      .values({ slug: options.workspaceSlug, name: options.workspaceName })
      .onConflictDoNothing({ target: workspaces.slug });
    const workspace = await tx.query.workspaces.findFirst({
      where: eq(workspaces.slug, options.workspaceSlug),
    });
    if (workspace === undefined) {
      throw new Error(`Seed failed: workspace "${options.workspaceSlug}" is absent after insert.`);
    }

    await tx
      .insert(users)
      .values({ email: options.adminEmail, name: options.adminName })
      .onConflictDoNothing({ target: users.email });
    const admin = await tx.query.users.findFirst({ where: eq(users.email, options.adminEmail) });
    if (admin === undefined) {
      throw new Error(`Seed failed: bootstrap administrator is absent after insert.`);
    }

    await tx
      .insert(memberships)
      .values({ workspaceId: workspace.id, userId: admin.id, role: 'owner' })
      .onConflictDoNothing({ target: [memberships.workspaceId, memberships.userId] });
    const membership = await tx.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, workspace.id), eq(memberships.userId, admin.id)),
    });
    if (membership === undefined) {
      throw new Error('Seed failed: bootstrap administrator membership is absent after insert.');
    }
    await tx
      .insert(workspacePrincipals)
      .values({
        workspaceId: workspace.id,
        kind: 'membership',
        membershipId: membership.id,
        activatedAt: membership.createdAt,
      })
      .onConflictDoNothing({
        target: [workspacePrincipals.workspaceId, workspacePrincipals.membershipId],
      });
    const principal = await tx.query.workspacePrincipals.findFirst({
      where: and(
        eq(workspacePrincipals.workspaceId, workspace.id),
        eq(workspacePrincipals.membershipId, membership.id),
      ),
    });
    if (principal === undefined) {
      throw new Error('Seed failed: bootstrap workspace principal is absent after insert.');
    }

    if (options.general === false) {
      return { workspaceId: workspace.id, adminUserId: admin.id };
    }

    await tx
      .insert(agents)
      .values({
        workspaceId: workspace.id,
        name: GENERAL_AGENT_NAME,
        instructions: '',
        permissions: GENERAL_AGENT_PERMISSIONS,
        ownerPrincipalId: principal.id,
        createdBy: admin.id,
      })
      .onConflictDoNothing({ target: [agents.workspaceId, agents.name] });
    const general = await tx.query.agents.findFirst({
      where: and(eq(agents.workspaceId, workspace.id), eq(agents.name, GENERAL_AGENT_NAME)),
    });
    if (general === undefined) {
      throw new Error(`Seed failed: the "${GENERAL_AGENT_NAME}" agent is absent after insert.`);
    }

    return { workspaceId: workspace.id, adminUserId: admin.id, generalAgentId: general.id };
  });
}

/** Open a connection, seed, close it. The form `pnpm db:seed` uses. */
export async function runSeed(
  config: DatabaseConfig = readDatabaseConfig(),
  options: SeedOptions = readSeedOptions(),
): Promise<SeedResult> {
  const { pool, db } = connect(config);
  try {
    return await seed(db, options);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const options = readSeedOptions();
  const result = await runSeed(readDatabaseConfig(), options);
  console.log(
    `db:seed — workspace "${options.workspaceSlug}" (${result.workspaceId}), ` +
      `owner ${options.adminEmail} (${result.adminUserId}), ` +
      `agent "${GENERAL_AGENT_NAME}" (${result.generalAgentId ?? 'none'})`,
  );
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  await main();
}
