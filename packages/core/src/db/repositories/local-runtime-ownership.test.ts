/**
 * Issue #509 (S1-24): an API-key principal may act for a membership principal, and a local start
 * reassigns what earlier local runtime keys own to the member they act for.
 *
 * Against PostgreSQL, because the properties are the database's: the tenant-paired self FK and the
 * two CHECKs on `workspace_principals.acts_for_principal_id`, the acts-for conjunct in
 * `authenticateApiKeyHash` and `principalById`, and the one-transaction, idempotent repair across
 * the seven owner columns, which must leave hosted keys, members and actor attribution untouched.
 */
import crypto from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import { agents as agentRows } from '../schema/agents.js';
import { apiKeys } from '../schema/api-keys.js';
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
import {
  createDatabaseDirectoryRoot,
  LOCAL_RUNTIME_API_KEY_NAME_PREFIX,
  type DatabaseWorkspaceDirectory,
} from './directory.js';
import { createDatabaseMcpServerRepositoryProvider } from './mcp-servers.js';
import { createDatabaseProjectRepositoryProvider } from './projects.js';
import { createDatabaseResourceCatalogRepositoryProvider } from './resource-catalogs.js';
import { createDatabaseSessionRepositoryProvider } from './runs.js';
import { createDatabaseShareRepositoryProvider } from './shares.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { seedCatalogFile } from './catalog-fixtures.js';

const hasDatabase = (process.env['TEST_DATABASE_URL'] ?? '').trim() !== '';

/** The reserved prefix; restated, not imported, so a change to the constant fails a test below. */
const LOCAL_PREFIX = 'aw dev local runtime ';

function violation(error: unknown): { code: string; constraint: string | undefined } | null {
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

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (reason: unknown) => reason,
  );
}

function keyHash(): string {
  return crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');
}

const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;

describe('the local runtime key prefix the repair selects (issue #509, S1-24)', () => {
  it('is fixed by core and cannot be chosen by a caller', () => {
    expect(LOCAL_RUNTIME_API_KEY_NAME_PREFIX).toBe(LOCAL_PREFIX);
    // A caller-chosen prefix (an empty one matches every key, hosted ones included) would let the
    // repair backfill acts_for on hosted keys; the input names only the target member.
    expectTypeOf<
      Parameters<DatabaseWorkspaceDirectory['reassignLocalRuntimeKeyOwnership']>[0]
    >().toEqualTypeOf<{ readonly toPrincipalId: string }>();
  });
});

describe.skipIf(!hasDatabase)('local runtime key ownership (issue #509, S1-24)', () => {
  let isolated: IsolatedTestDatabase;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_s1_24_local_ownership');
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  /** A fresh workspace with an owner member and a builder member. */
  async function workspace(): Promise<{
    readonly workspaceId: string;
    readonly directory: DatabaseWorkspaceDirectory;
    readonly admin: { readonly principalId: string; readonly membershipId: string };
    readonly other: { readonly principalId: string };
  }> {
    const workspaceId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: `s124-${workspaceId.slice(0, 8)}`,
      name: 'S1-24 local ownership',
    });
    const directory = createDatabaseDirectoryRoot(isolated.db).forWorkspace(workspaceId);
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

  async function key(
    directory: DatabaseWorkspaceDirectory,
    name: string,
    actsForPrincipalId?: string,
  ): Promise<{ readonly id: string; readonly principalId: string; readonly hash: string }> {
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
  async function ownEverything(workspaceId: string, ownerPrincipalId: string): Promise<void> {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('no scope');
    const suffix = crypto.randomUUID().slice(0, 8);
    const agent = await createDatabaseAgentRepositoryProvider(isolated.db)
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
    const catalog = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scope);
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
    const connector = await createDatabaseMcpServerRepositoryProvider(isolated.db)
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
    const project = await createDatabaseProjectRepositoryProvider(isolated.db)
      .forScope(scope)
      .create({
        name: `project-${suffix}`,
        instructions: null,
        defaultAgentId: agent.agent.id,
        visibility: 'private',
        ownerPrincipalId,
      });
    const session = await createDatabaseSessionRepositoryProvider(isolated.db)
      .forScope(scope)
      .ensure({
        id: crypto.randomUUID(),
        agentId: agent.agent.id,
        projectId: project.id,
        ownerPrincipalId,
      });
    if (session.kind !== 'created') throw new Error(session.kind);
    await createDatabaseShareRepositoryProvider(isolated.db)
      .forScope(scope)
      .create({
        token: `s124_${crypto.randomUUID()}`,
        subjectType: 'agent',
        subjectId: agent.agent.id,
        subjectLabel: agent.agent.name,
        visibility: 'private',
        mode: 'definition',
        snapshot: {},
        include: {},
        budgetCapUsd: null,
        expiresAt: null,
        passphraseHash: null,
        publisherPrincipalId: ownerPrincipalId,
      });
    await createDatabaseAuditEventRepositoryProvider(isolated.db).forScope(scope).write({
      actorPrincipalId: ownerPrincipalId,
      actorLabel: 'S1-24 actor',
      action: 'agent-changed',
      subjectId: agent.agent.id,
      subjectLabel: agent.agent.name,
    });
  }

  /** How many rows each owner column holds for `principalId` in `workspaceId`. */
  async function owned(workspaceId: string, principalId: string): Promise<number[]> {
    const counts = await Promise.all([
      isolated.db
        .select({ id: agentRows.id })
        .from(agentRows)
        .where(
          and(eq(agentRows.workspaceId, workspaceId), eq(agentRows.ownerPrincipalId, principalId)),
        ),
      isolated.db
        .select({ id: sessionRows.id })
        .from(sessionRows)
        .where(
          and(
            eq(sessionRows.workspaceId, workspaceId),
            eq(sessionRows.ownerPrincipalId, principalId),
          ),
        ),
      isolated.db
        .select({ id: skillRows.id })
        .from(skillRows)
        .where(
          and(eq(skillRows.workspaceId, workspaceId), eq(skillRows.ownerPrincipalId, principalId)),
        ),
      isolated.db
        .select({ id: fileRows.id })
        .from(fileRows)
        .where(
          and(eq(fileRows.workspaceId, workspaceId), eq(fileRows.ownerPrincipalId, principalId)),
        ),
      isolated.db
        .select({ id: mcpServerRows.id })
        .from(mcpServerRows)
        .where(
          and(
            eq(mcpServerRows.workspaceId, workspaceId),
            eq(mcpServerRows.ownerPrincipalId, principalId),
          ),
        ),
      isolated.db
        .select({ id: projectRows.id })
        .from(projectRows)
        .where(
          and(
            eq(projectRows.workspaceId, workspaceId),
            eq(projectRows.ownerPrincipalId, principalId),
          ),
        ),
      isolated.db
        .select({ id: shareRows.id })
        .from(shareRows)
        .where(
          and(
            eq(shareRows.workspaceId, workspaceId),
            eq(shareRows.publisherPrincipalId, principalId),
          ),
        ),
    ]);
    return counts.map((rows) => rows.length);
  }

  async function actsForOf(principalId: string): Promise<string | null> {
    const rows = await isolated.db
      .select({ actsFor: workspacePrincipals.actsForPrincipalId })
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.id, principalId));
    const row = rows[0];
    if (row === undefined) throw new Error('no principal');
    return row.actsFor;
  }

  it('records acts_for on a new key and refuses a foreign, api-key or revoked target', async () => {
    const { workspaceId, directory, admin } = await workspace();
    const local = await key(directory, `${LOCAL_PREFIX}AAAAAAAA`, admin.principalId);
    await expect(actsForOf(local.principalId)).resolves.toBe(admin.principalId);
    const listed = (await directory.listApiKeys()).find((row) => row.id === local.id);
    expect(listed?.actsForPrincipalId).toBe(admin.principalId);

    const hosted = await key(directory, 'ci key');
    await expect(actsForOf(hosted.principalId)).resolves.toBeNull();

    const foreign = await workspace();
    for (const target of [foreign.admin.principalId, hosted.principalId, crypto.randomUUID()]) {
      await expect(
        directory.createApiKey({
          name: `${LOCAL_PREFIX}${crypto.randomUUID().slice(0, 8)}`,
          role: 'admin',
          keyPrefix: `ak_live_${crypto.randomUUID().slice(0, 8)}`,
          keyHash: keyHash(),
          expiresAt: null,
          actsForPrincipalId: target,
        }),
      ).rejects.toThrow(/act only for an active membership principal/u);
    }

    // A revoked membership principal is no target either, and nothing was inserted for it.
    await isolated.db
      .update(workspacePrincipals)
      .set({ revokedAt: sql`now()` })
      .where(eq(workspacePrincipals.id, admin.principalId));
    const before = (await directory.listApiKeys()).length;
    await expect(key(directory, `${LOCAL_PREFIX}BBBBBBBB`, admin.principalId)).rejects.toThrow(
      /act only for an active membership principal/u,
    );
    expect((await directory.listApiKeys()).length).toBe(before);
    expect(workspaceId).toBeTruthy();
  });

  it('authenticates and resolves a key with its acts-for principal, and stops once that member is gone', async () => {
    const { workspaceId, directory, admin } = await workspace();
    const root = createDatabaseDirectoryRoot(isolated.db);
    const local = await key(directory, `${LOCAL_PREFIX}CCCCCCCC`, admin.principalId);
    const hosted = await key(directory, 'hosted admin key');

    const authenticated = await root.authenticateApiKeyHash(local.hash, new Date());
    expect(authenticated?.actsForPrincipalId).toBe(admin.principalId);
    const hostedAuthenticated = await root.authenticateApiKeyHash(hosted.hash, new Date());
    expect(hostedAuthenticated?.actsForPrincipalId).toBeNull();
    await expect(root.principalById(workspaceId, local.principalId)).resolves.toMatchObject({
      kind: 'api_key',
      actsForPrincipalId: admin.principalId,
    });
    await expect(root.principalById(workspaceId, admin.principalId)).resolves.toMatchObject({
      kind: 'membership',
      actsForPrincipalId: null,
    });

    await isolated.db
      .update(workspacePrincipals)
      .set({ revokedAt: sql`now()` })
      .where(eq(workspacePrincipals.id, admin.principalId));
    await expect(root.authenticateApiKeyHash(local.hash, new Date())).resolves.toBeNull();
    await expect(root.principalById(workspaceId, local.principalId)).resolves.toBeNull();
    // A hosted key never depended on that member.
    await expect(root.authenticateApiKeyHash(hosted.hash, new Date())).resolves.not.toBeNull();
  });

  it('moves every owner column from local keys (revoked and expired included) to the member, once', async () => {
    const { workspaceId, directory, admin, other } = await workspace();
    const live = await key(directory, `${LOCAL_PREFIX}DDDDDDDD`);
    const revoked = await key(directory, `${LOCAL_PREFIX}EEEEEEEE`);
    const expired = await key(directory, `${LOCAL_PREFIX}FFFFFFFF`);
    const hosted = await key(directory, 'hosted key');
    const lookalike = await key(directory, 'aw dev local runtim_ lookalike');
    await directory.revokeApiKey(revoked.id, new Date());
    await isolated.db
      .update(apiKeys)
      .set({
        createdAt: sql`now() - interval '2 days'`,
        expiresAt: sql`now() - interval '1 day'`,
      })
      .where(eq(apiKeys.id, expired.id));
    for (const principalId of [
      live.principalId,
      revoked.principalId,
      expired.principalId,
      hosted.principalId,
      lookalike.principalId,
      other.principalId,
    ]) {
      await ownEverything(workspaceId, principalId);
    }

    const editedAt = async () =>
      (
        await Promise.all(
          [agentRows, sessionRows, skillRows, fileRows, mcpServerRows, projectRows].map((table) =>
            isolated.db
              .select({ id: table.id, updatedAt: table.updatedAt })
              .from(table)
              .where(eq(table.workspaceId, workspaceId)),
          ),
        )
      )
        .flat()
        .map((row) => `${row.id}@${row.updatedAt.toISOString()}`)
        .sort();
    const before = await editedAt();

    const first = await directory.reassignLocalRuntimeKeyOwnership({
      toPrincipalId: admin.principalId,
    });
    expect(first.reassigned).toBe(3 * 7);
    // A change of owner is not an edit: `updated_at` (what `aw push` compares) is untouched.
    expect(await editedAt()).toEqual(before);
    await expect(owned(workspaceId, admin.principalId)).resolves.toEqual([3, 3, 3, 3, 3, 3, 3]);
    for (const principalId of [live.principalId, revoked.principalId, expired.principalId]) {
      await expect(owned(workspaceId, principalId)).resolves.toEqual([0, 0, 0, 0, 0, 0, 0]);
      await expect(actsForOf(principalId)).resolves.toBe(admin.principalId);
    }
    // Hosted keys, a name that only looks like the prefix, and members keep what they own.
    for (const principalId of [hosted.principalId, lookalike.principalId, other.principalId]) {
      await expect(owned(workspaceId, principalId)).resolves.toEqual([1, 1, 1, 1, 1, 1, 1]);
    }
    await expect(actsForOf(hosted.principalId)).resolves.toBeNull();

    // Actor attribution keeps the acting key.
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('no scope');
    const audit = await createDatabaseAuditEventRepositoryProvider(isolated.db)
      .forScope(scope)
      .list();
    const actors = audit.items.map((event) => event.actorPrincipalId);
    expect(actors).toEqual(expect.arrayContaining([live.principalId, revoked.principalId]));
    expect(actors).not.toContain(admin.principalId);

    const second = await directory.reassignLocalRuntimeKeyOwnership({
      toPrincipalId: admin.principalId,
    });
    expect(second.reassigned).toBe(0);
  });

  it('moves a key that already records whom it acts for to that member, not the caller', async () => {
    const { workspaceId, directory, admin, other } = await workspace();
    const actsForOther = await key(directory, `${LOCAL_PREFIX}GGGGGGGG`, other.principalId);
    await ownEverything(workspaceId, actsForOther.principalId);
    const outcome = await directory.reassignLocalRuntimeKeyOwnership({
      toPrincipalId: admin.principalId,
    });
    expect(outcome.reassigned).toBe(7);
    await expect(owned(workspaceId, other.principalId)).resolves.toEqual([1, 1, 1, 1, 1, 1, 1]);
    await expect(owned(workspaceId, admin.principalId)).resolves.toEqual([0, 0, 0, 0, 0, 0, 0]);
    await expect(actsForOf(actsForOther.principalId)).resolves.toBe(other.principalId);
  });

  it('throws with nothing changed when the target is not an active member principal', async () => {
    const { workspaceId, directory, admin } = await workspace();
    const local = await key(directory, `${LOCAL_PREFIX}HHHHHHHH`);
    const hosted = await key(directory, 'hosted target');
    await ownEverything(workspaceId, local.principalId);
    for (const target of [hosted.principalId, crypto.randomUUID()]) {
      await expect(
        directory.reassignLocalRuntimeKeyOwnership({
          toPrincipalId: target,
        }),
      ).rejects.toThrow(/active membership principal/u);
    }
    await expect(owned(workspaceId, local.principalId)).resolves.toEqual([1, 1, 1, 1, 1, 1, 1]);
    await expect(actsForOf(local.principalId)).resolves.toBeNull();
    expect(admin.principalId).not.toBe(local.principalId);
  });

  it('refuses acts_for on a membership principal and acts_for pointing at itself', async () => {
    const { directory, admin, other } = await workspace();
    const local = await key(directory, `${LOCAL_PREFIX}IIIIIIII`);
    const onMembership = await failure(
      isolated.db
        .update(workspacePrincipals)
        .set({ actsForPrincipalId: admin.principalId })
        .where(eq(workspacePrincipals.id, other.principalId)),
    );
    expect(violation(onMembership)).toEqual({
      code: '23514',
      constraint: 'workspace_principals_acts_for_api_key_only',
    });
    const onSelf = await failure(
      isolated.db
        .update(workspacePrincipals)
        .set({ actsForPrincipalId: local.principalId })
        .where(eq(workspacePrincipals.id, local.principalId)),
    );
    expect(violation(onSelf)).toEqual({
      code: '23514',
      constraint: 'workspace_principals_acts_for_not_self',
    });
    const foreign = await workspace();
    const crossTenant = await failure(
      isolated.db
        .update(workspacePrincipals)
        .set({ actsForPrincipalId: foreign.admin.principalId })
        .where(eq(workspacePrincipals.id, local.principalId)),
    );
    expect(violation(crossTenant)).toEqual({
      code: '23503',
      constraint: 'workspace_principals_acts_for_workspace_fk',
    });
  });

  it('refuses, as a typed outcome, to delete a member a revoked local key acted for', async () => {
    const { directory, admin } = await workspace();
    const second = await directory.createUser({
      email: `second-${crypto.randomUUID()}@example.test`,
      name: 'Second owner',
      role: 'owner',
    });
    if (second.kind !== 'created') throw new Error(second.kind);
    const local = await key(directory, `${LOCAL_PREFIX}JJJJJJJJ`, admin.principalId);
    expect((await directory.revokeApiKey(local.id, new Date())).kind).toBe('revoked');
    // A refusal, never the raw `workspace_principals_acts_for_workspace_fk` violation the route
    // would otherwise answer as an unhandled 500.
    await expect(directory.deleteMembership(admin.membershipId)).resolves.toEqual({
      kind: 'membership-in-use',
      id: admin.membershipId,
      dependency: 'local-runtime-keys',
    });
    const remaining = await directory.listMemberships();
    expect(remaining.map((membership) => membership.id)).toContain(admin.membershipId);
    // The baseline: a member no local key acted for is still deleted.
    expect(await directory.deleteMembership(second.membership.id)).toEqual({
      kind: 'deleted',
      id: second.membership.id,
    });
  });
});
