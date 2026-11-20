/**
 * Shared PostgreSQL fixtures for the local runtime key ownership tests (issue #509, S1-24): a
 * fresh workspace, API keys, one row in each of the seven owner columns, and the readers that
 * observe ownership, `acts_for` and `updated_at` afterwards.
 */
import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll } from 'vitest';

import { agents as agentRows } from '../schema/agents.js';
import { files as fileRows } from '../schema/files.js';
import { mcpServers as mcpServerRows } from '../schema/mcp-servers.js';
import { projects as projectRows } from '../schema/projects.js';
import { sessions as sessionRows } from '../schema/sessions.js';
import { shares as shareRows } from '../schema/shares.js';
import { skills as skillRows } from '../schema/skills.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseAgentRepositoryProvider } from './agents.js';
import { createDatabaseAuditEventRepositoryProvider } from './audit-events.js';
import { seedCatalogFile } from './catalog-fixtures.js';
import { createDatabaseDirectoryRoot, type DatabaseWorkspaceDirectory } from './directory.js';
import { createDatabaseMcpServerRepositoryProvider } from './mcp-servers.js';
import { createDatabaseProjectRepositoryProvider } from './projects.js';
import { createDatabaseResourceCatalogRepositoryProvider } from './resource-catalogs.js';
import { createDatabaseSessionRepositoryProvider } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createDatabaseShareRepositoryProvider } from './shares.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

/** The reserved prefix; restated, not imported, so a change to the constant fails a test. */
export const LOCAL_PREFIX = 'aw dev local runtime ';

const ISOLATED_DATABASE_TIMEOUT_MS = 180_000;

/** What `owned` reports for a principal that owns one row in each of the seven owner columns. */
export const OWNS_ONE_OF_EACH = [1, 1, 1, 1, 1, 1, 1];
export const OWNS_NOTHING = [0, 0, 0, 0, 0, 0, 0];

const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;

export function violation(error: unknown): { code: string; constraint: string | undefined } | null {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
      };
    }
    current = candidate.cause;
  }
  return null;
}

export async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (reason: unknown) => reason,
  );
}

export function keyHash(): string {
  return crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');
}

interface SeededWorkspace {
  readonly workspaceId: string;
  readonly directory: DatabaseWorkspaceDirectory;
  readonly admin: { readonly principalId: string; readonly membershipId: string };
  readonly other: { readonly principalId: string };
}

interface SeededKey {
  readonly id: string;
  readonly principalId: string;
  readonly hash: string;
}

interface OwnershipFixtures {
  readonly db: IsolatedTestDatabase['db'];
  readonly workspace: () => Promise<SeededWorkspace>;
  readonly key: (
    directory: DatabaseWorkspaceDirectory,
    name: string,
    actsForPrincipalId?: string,
  ) => Promise<SeededKey>;
  readonly ownEverything: (workspaceId: string, ownerPrincipalId: string) => Promise<void>;
  readonly owned: (workspaceId: string, principalId: string) => Promise<number[]>;
  readonly actsForOf: (principalId: string) => Promise<string | null>;
  readonly editedAt: (workspaceId: string) => Promise<string[]>;
  readonly auditActors: (workspaceId: string) => Promise<(string | null)[]>;
}

/** Registers the isolated database's lifecycle on the calling describe and returns the fixtures. */
export function useOwnershipFixtures(databaseName: string): OwnershipFixtures {
  let isolated: IsolatedTestDatabase | undefined;
  const database = (): IsolatedTestDatabase => {
    if (isolated === undefined) throw new Error('the isolated database is not ready');
    return isolated;
  };

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(databaseName);
  }, ISOLATED_DATABASE_TIMEOUT_MS);

  afterAll(async () => {
    await isolated?.close();
  });

  const scopeOf = async (workspaceId: string) => {
    const scope = await createDatabaseWorkspaceScopeResolver(database().db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('no scope');
    return scope;
  };

  return {
    get db() {
      return database().db;
    },
    workspace: () => seedWorkspace(database().db),
    key: seedKey,
    ownEverything: async (workspaceId, ownerPrincipalId) =>
      seedOwnedRows(database().db, await scopeOf(workspaceId), ownerPrincipalId),
    owned: (workspaceId, principalId) => countOwned(database().db, workspaceId, principalId),
    actsForOf: (principalId) => readActsFor(database().db, principalId),
    editedAt: (workspaceId) => snapshotEditedAt(database().db, workspaceId),
    auditActors: async (workspaceId) => {
      const scope = await scopeOf(workspaceId);
      const audit = await createDatabaseAuditEventRepositoryProvider(database().db)
        .forScope(scope)
        .list();
      return audit.items.map((event) => event.actorPrincipalId);
    },
  };
}

type Db = IsolatedTestDatabase['db'];
type Scope = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createDatabaseWorkspaceScopeResolver>['forWorkspaceId']>>
>;

/** A fresh workspace with an owner member and a builder member. */
async function seedWorkspace(db: Db): Promise<SeededWorkspace> {
  const workspaceId = crypto.randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId,
    slug: `s124-${workspaceId.slice(0, 8)}`,
    name: 'S1-24 local ownership',
  });
  const directory = createDatabaseDirectoryRoot(db).forWorkspace(workspaceId);
  const admin = await directory.createUser({
    email: `admin-${workspaceId}@example.test`,
    name: 'Admin',
    role: 'owner',
  });
  const other = await directory.createUser({
    email: `builder-${workspaceId}@example.test`,
    name: 'Builder',
    role: 'builder',
  });
  if (admin.kind !== 'created' || other.kind !== 'created') throw new Error('seed failed');
  return {
    workspaceId,
    directory,
    admin: { principalId: admin.membership.principalId, membershipId: admin.membership.id },
    other: { principalId: other.membership.principalId },
  };
}

async function seedKey(
  directory: DatabaseWorkspaceDirectory,
  name: string,
  actsForPrincipalId?: string,
): Promise<SeededKey> {
  const hash = keyHash();
  const created = await directory.createApiKey({
    name,
    role: 'admin',
    keyPrefix: `ak_live_${crypto.randomUUID().slice(0, 8)}`,
    keyHash: hash,
    expiresAt: null,
    ...(actsForPrincipalId === undefined ? {} : { actsForPrincipalId }),
  });
  if (created.kind !== 'created') throw new Error(created.kind);
  return { id: created.key.id, principalId: created.key.principalId, hash };
}

/** One row in each of the seven owner columns, owned by `ownerPrincipalId`. */
async function seedOwnedRows(db: Db, scope: Scope, ownerPrincipalId: string): Promise<void> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const agent = await createDatabaseAgentRepositoryProvider(db)
    .forScope(scope)
    .create({
      name: `agent-${suffix}`,
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: PERMISSIONS,
      ownerPrincipalId,
    });
  if (agent.kind !== 'created') throw new Error(agent.kind);
  await seedCatalogRows(db, scope, suffix, ownerPrincipalId);
  await seedConnector(db, scope, suffix, ownerPrincipalId);
  const project = await createDatabaseProjectRepositoryProvider(db)
    .forScope(scope)
    .create({
      name: `project-${suffix}`,
      instructions: null,
      defaultAgentId: agent.agent.id,
      visibility: 'private',
      ownerPrincipalId,
    });
  const session = await createDatabaseSessionRepositoryProvider(db).forScope(scope).ensure({
    id: crypto.randomUUID(),
    agentId: agent.agent.id,
    projectId: project.id,
    ownerPrincipalId,
  });
  if (session.kind !== 'created') throw new Error(session.kind);
  await seedShareAndAudit(db, scope, agent.agent, ownerPrincipalId);
}

async function seedCatalogRows(
  db: Db,
  scope: Scope,
  suffix: string,
  ownerPrincipalId: string,
): Promise<void> {
  const catalog = createDatabaseResourceCatalogRepositoryProvider(db).forScope(scope);
  await seedCatalogFile(catalog, {
    path: `file-${suffix}.txt`,
    kind: 'file',
    sizeBytes: 1,
    contentType: 'text/plain',
    ownerPrincipalId,
  });
  await catalog.putSkill({
    name: `skill-${suffix}`,
    skillMd: `---\nname: skill-${suffix}\n---\n`,
    enabled: true,
    ownerPrincipalId,
  });
}

async function seedConnector(
  db: Db,
  scope: Scope,
  suffix: string,
  ownerPrincipalId: string,
): Promise<void> {
  const connector = await createDatabaseMcpServerRepositoryProvider(db)
    .forScope(scope)
    .create({
      name: `connector-${suffix}`,
      transport: 'stdio',
      command: 'node',
      args: [],
      url: null,
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
      ownerPrincipalId,
    });
  if (connector.kind !== 'created') throw new Error(connector.kind);
}

async function seedShareAndAudit(
  db: Db,
  scope: Scope,
  agent: { readonly id: string; readonly name: string },
  ownerPrincipalId: string,
): Promise<void> {
  await createDatabaseShareRepositoryProvider(db)
    .forScope(scope)
    .create({
      tokenHash: `s124_${crypto.randomUUID()}`,
      subjectType: 'agent',
      subjectId: agent.id,
      subjectLabel: agent.name,
      visibility: 'private',
      mode: 'definition',
      snapshot: {},
      include: {},
      budgetCapUsd: null,
      expiresAt: null,
      passphraseHash: null,
      publisherPrincipalId: ownerPrincipalId,
    });
  await createDatabaseAuditEventRepositoryProvider(db).forScope(scope).write({
    actorPrincipalId: ownerPrincipalId,
    actorLabel: 'S1-24 actor',
    action: 'agent-changed',
    subjectId: agent.id,
    subjectLabel: agent.name,
  });
}

type OwnedTable = PgTable & { id: PgColumn; workspaceId: PgColumn };

/** How many rows each owner column holds for `principalId` in `workspaceId`. */
async function countOwned(db: Db, workspaceId: string, principalId: string): Promise<number[]> {
  const ownedBy = (table: OwnedTable, ownerColumn: PgColumn) =>
    db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.workspaceId, workspaceId), eq(ownerColumn, principalId)));
  const counts = await Promise.all([
    ownedBy(agentRows, agentRows.ownerPrincipalId),
    ownedBy(sessionRows, sessionRows.ownerPrincipalId),
    ownedBy(skillRows, skillRows.ownerPrincipalId),
    ownedBy(fileRows, fileRows.ownerPrincipalId),
    ownedBy(mcpServerRows, mcpServerRows.ownerPrincipalId),
    ownedBy(projectRows, projectRows.ownerPrincipalId),
    ownedBy(shareRows, shareRows.publisherPrincipalId),
  ]);
  return counts.map((rows) => rows.length);
}

async function readActsFor(db: Db, principalId: string): Promise<string | null> {
  const rows = await db
    .select({ actsFor: workspacePrincipals.actsForPrincipalId })
    .from(workspacePrincipals)
    .where(eq(workspacePrincipals.id, principalId));
  const row = rows[0];
  if (row === undefined) throw new Error('no principal');
  return row.actsFor;
}

/** Every row's id and `updated_at` in the workspace, as sorted strings to compare by equality. */
async function snapshotEditedAt(db: Db, workspaceId: string): Promise<string[]> {
  const tables = [agentRows, sessionRows, skillRows, fileRows, mcpServerRows, projectRows];
  const rows = await Promise.all(
    tables.map((table) =>
      db
        .select({ id: table.id, updatedAt: table.updatedAt })
        .from(table)
        .where(eq(table.workspaceId, workspaceId)),
    ),
  );
  return rows
    .flat()
    .map((row) => `${row.id}@${row.updatedAt.toISOString()}`)
    .sort();
}
