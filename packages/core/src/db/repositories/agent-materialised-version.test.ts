/**
 * `agents.materialised_version_id` (issue #613) against real PostgreSQL: which writers set it,
 * which clear it, which leave it alone, what its foreign key refuses, and how migration 0040
 * backfills it from the timestamp proxy it replaces.
 */
import crypto from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveMigrationsDir, runMigrations } from '../migrate.js';
import { agentVersionPointers } from '../schema/agent-version-pointers.js';
import { agentVersions } from '../schema/agent-versions.js';
import { agents, type AgentPermissions } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseAgentResourceRepositoryProvider } from './agent-resources.js';
import {
  createDatabaseAgentVersionRepositoryProvider,
  type AgentVersionRepository,
} from './agent-versions.js';
import { createDatabaseAgentRepositoryProvider, type AgentRepository } from './agents.js';
import {
  createDatabaseDirectoryRoot,
  LOCAL_RUNTIME_API_KEY_NAME_PREFIX,
  type DatabaseWorkspaceDirectory,
} from './directory.js';
import { openDatabaseRoot } from './root.js';
import { createDatabaseRuntimeProfileRepositoryProvider } from './runtime-profiles.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations, type PostgresViolation } from './violations.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = Boolean(databaseUrl?.trim());

const READ_ONLY: AgentPermissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

describe.skipIf(!hasDatabase)('agents.materialised_version_id against real PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_agent_materialised_version');
  }, 180_000);

  afterAll(async () => isolated.close());

  interface Workspace {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly directory: DatabaseWorkspaceDirectory;
    readonly versions: AgentVersionRepository;
    readonly agents: AgentRepository;
  }

  async function workspace(): Promise<Workspace> {
    const workspaceId = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `mv-${workspaceId.slice(0, 8)}`, name: 'Materialised' });
    const directory = createDatabaseDirectoryRoot(isolated.db).forWorkspace(workspaceId);
    const owner = await directory.createUser({
      email: `owner-${workspaceId}@example.test`,
      name: 'Owner',
      role: 'owner',
    });
    if (owner.kind !== 'created') throw new Error(owner.kind);
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    return {
      workspaceId,
      principalId: owner.membership.principalId,
      directory,
      versions: createDatabaseAgentVersionRepositoryProvider(isolated.db).forScope(scope),
      agents: createDatabaseAgentRepositoryProvider(isolated.db).forScope(scope),
    };
  }

  /** Create an agent from its first version, as `aw push` does, owned by `ownerPrincipalId`. */
  async function pushed(ws: Workspace, name: string, ownerPrincipalId = ws.principalId) {
    const created = await ws.versions.createAgentWithFirstVersion({
      agent: {
        name,
        instructions: 'Be helpful.',
        model: null,
        permissions: READ_ONLY,
        policy: null,
        references: {
          modelConnectionId: null,
          runtimeProfileId: null,
          skillIds: [],
          connectorIds: [],
          files: [],
        },
        ownerPrincipalId,
        createdBy: null,
      },
      version: {
        summary: 'first',
        via: 'aw-push',
        body: { definition: { agent: { name, runtimeProfileName: null } }, surfaces: [] },
        createdByPrincipalId: ws.principalId,
      },
      environment: 'local',
    });
    if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);
    return { agentId: created.agent.id, version: created.version };
  }

  async function materialisedOf(agentId: string): Promise<string | null | undefined> {
    const rows = await isolated.db
      .select({ materialisedVersionId: agents.materialisedVersionId })
      .from(agents)
      .where(eq(agents.id, agentId));
    return rows[0]?.materialisedVersionId;
  }

  async function violationsOf(write: Promise<unknown>): Promise<readonly PostgresViolation[]> {
    try {
      await write;
    } catch (error) {
      return [...postgresViolations(error)];
    }
    throw new Error('the write was expected to be refused');
  }

  const audit = (ws: Workspace) => ({
    subjectLabel: 'an agent',
    actorPrincipalId: ws.principalId,
    actorUserId: null,
    actorLabel: 'Owner',
  });

  it('(a) creating an agent from a version materialises version 1, and the listing reports it', async () => {
    const ws = await workspace();
    const { agentId, version } = await pushed(ws, 'created');
    expect(version.number).toBe(1);
    await expect(materialisedOf(agentId)).resolves.toBe(version.id);
    await expect(ws.versions.list(agentId)).resolves.toMatchObject({
      materialisedVersionId: version.id,
    });
  });

  it('(b) applyAndPoint materialises the pointed version, again after an edit', async () => {
    const ws = await workspace();
    const { agentId } = await pushed(ws, 'applied');
    const v2 = await ws.versions.create(agentId, {
      summary: 'second',
      via: 'aw-push',
      body: { definition: { agent: { name: 'applied' } }, surfaces: [] },
      createdByPrincipalId: ws.principalId,
    });
    if (v2.kind !== 'created') throw new Error(v2.kind);
    const apply = () =>
      ws.versions.applyAndPoint(agentId, {
        reason: 'set',
        audit: audit(ws),
        environment: 'local',
        number: 2,
        agent: {
          name: 'applied',
          instructions: 'Version two.',
          model: null,
          permissions: READ_ONLY,
          policy: null,
          references: {
            modelConnectionId: null,
            runtimeProfileId: null,
            skillIds: [],
            connectorIds: [],
            files: [],
          },
        },
      });
    await expect(apply()).resolves.toMatchObject({ kind: 'applied' });
    await expect(materialisedOf(agentId)).resolves.toBe(v2.version.id);

    await ws.agents.update(agentId, { instructions: 'Edited in the UI.' });
    await expect(materialisedOf(agentId)).resolves.toBeNull();
    await expect(apply()).resolves.toMatchObject({ kind: 'applied' });
    await expect(materialisedOf(agentId)).resolves.toBe(v2.version.id);
  });

  it('(c) PATCH, PUT /policy and PUT /resources each clear it', async () => {
    const ws = await workspace();
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      ws.workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const resources = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scope);

    const patched = await pushed(ws, 'patched');
    await expect(ws.agents.update(patched.agentId, { name: 'patched-2' })).resolves.toMatchObject({
      kind: 'updated',
    });
    await expect(materialisedOf(patched.agentId)).resolves.toBeNull();

    const policed = await pushed(ws, 'policed');
    await expect(ws.agents.replacePolicy(policed.agentId, null)).resolves.toMatchObject({
      kind: 'updated',
    });
    await expect(materialisedOf(policed.agentId)).resolves.toBeNull();

    const assigned = await pushed(ws, 'assigned');
    await expect(
      resources.replace(assigned.agentId, { files: [], skillIds: [], connectorIds: [] }),
    ).resolves.toMatchObject({ kind: 'updated' });
    await expect(materialisedOf(assigned.agentId)).resolves.toBeNull();
  });

  it('(d) an owner move and the setup mark leave it alone', async () => {
    const ws = await workspace();
    const created = await ws.directory.createApiKey({
      name: `${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}MATERIAL`,
      role: 'admin',
      keyPrefix: `ak_live_${crypto.randomUUID().slice(0, 8)}`,
      keyHash: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
      expiresAt: null,
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const { agentId, version } = await pushed(ws, 'moved', created.key.principalId);

    await ws.directory.reassignLocalRuntimeKeyOwnership({ toPrincipalId: ws.principalId });
    const owners = await isolated.db
      .select({ ownerPrincipalId: agents.ownerPrincipalId })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(owners).toEqual([{ ownerPrincipalId: ws.principalId }]);
    await expect(materialisedOf(agentId)).resolves.toBe(version.id);

    const root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    try {
      await expect(root.setWorkspaceSetupAgentId(ws.workspaceId, agentId)).resolves.toBe(true);
      await expect(materialisedOf(agentId)).resolves.toBe(version.id);
      await expect(root.clearWorkspaceSetupAgentId(ws.workspaceId, agentId)).resolves.toBe(true);
      await expect(materialisedOf(agentId)).resolves.toBe(version.id);
    } finally {
      await root.close();
    }
  });

  it('(e) refuses another agent’s and another workspace’s version (agents_materialised_version_fk)', async () => {
    const ws = await workspace();
    const other = await workspace();
    const mine = await pushed(ws, 'mine');
    const sibling = await pushed(ws, 'sibling');
    const foreign = await pushed(other, 'foreign');
    for (const versionId of [sibling.version.id, foreign.version.id]) {
      await expect(
        violationsOf(
          isolated.db
            .update(agents)
            .set({ materialisedVersionId: versionId })
            .where(eq(agents.id, mine.agentId)),
        ),
      ).resolves.toEqual([{ code: '23503', constraint: 'agents_materialised_version_fk' }]);
    }
    await expect(materialisedOf(mine.agentId)).resolves.toBe(mine.version.id);
  });

  it('(f) deletes an agent that has a materialised version', async () => {
    const ws = await workspace();
    const { agentId } = await pushed(ws, 'deleted');
    await expect(ws.agents.delete(agentId)).resolves.toEqual({ kind: 'deleted' });
    await expect(materialisedOf(agentId)).resolves.toBeUndefined();
    const left = await isolated.db
      .select({ id: agentVersions.id })
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId));
    expect(left).toEqual([]);
  });

  it('(h) the default profile attaches to a materialised agent, whatever its updated_at, and skips an edited one', async () => {
    const ws = await workspace();
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      ws.workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    // A row whose `updated_at` moved without an edit: the old proxy read it as edited.
    const touched = await pushed(ws, 'touched');
    await isolated.db.execute(
      sql`update agents set updated_at = now() + interval '1 hour' where id = ${touched.agentId}`,
    );
    const edited = await pushed(ws, 'edited');
    await ws.agents.update(edited.agentId, { instructions: 'Edited in the UI.' });

    const ensured = await createDatabaseRuntimeProfileRepositoryProvider(isolated.db)
      .forScope(scope)
      .ensureWorkspaceDefault(
        {
          name: 'local',
          driver: 'local',
          runtimeConnectionId: null,
          cpu: null,
          memoryMb: null,
          diskMb: null,
          networkPolicy: 'open',
          allowedDomains: null,
          filesystem: 'read-write',
          persistPaths: null,
          timeoutSeconds: null,
          idleTimeoutSeconds: null,
          driverConfig: null,
        },
        { adoptable: () => true },
      );
    if (ensured.kind !== 'created') throw new Error(`expected created, got ${ensured.kind}`);
    const profileOf = async (agentId: string) =>
      (
        await isolated.db
          .select({ runtimeProfileId: agents.runtimeProfileId })
          .from(agents)
          .where(eq(agents.id, agentId))
      )[0]?.runtimeProfileId;
    await expect(profileOf(touched.agentId)).resolves.toBe(ensured.profile.id);
    await expect(profileOf(edited.agentId)).resolves.toBeNull();
    await expect(materialisedOf(touched.agentId)).resolves.toBe(touched.version.id);
  });
});

const FIRST_MIGRATION_OF_THIS_UNIT = '0040_record_the_materialised_version';

/**
 * (g) Migration 0040's backfill. The database is migrated as far as 0039, agents and pointers are
 * seeded with the timestamps the old proxy compared, and then 0040 runs: a row not written after
 * its `local` pointer moved is materialised from it, any other row is left `NULL`.
 */
describe.skipIf(!hasDatabase)('0040 materialised-version backfill', () => {
  let isolated: IsolatedTestDatabase;
  let priorMigrationsDir: string;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const seeded = {
    before: { agentId: crypto.randomUUID(), versionId: crypto.randomUUID(), at: '01' },
    equal: { agentId: crypto.randomUUID(), versionId: crypto.randomUUID(), at: '02' },
    after: { agentId: crypto.randomUUID(), versionId: crypto.randomUUID(), at: '03' },
  };
  const unpointed = crypto.randomUUID();

  beforeAll(async () => {
    const migrationsDir = resolveMigrationsDir();
    priorMigrationsDir = await mkdtemp(path.join(tmpdir(), 'aw-pre-0040-'));
    await mkdir(path.join(priorMigrationsDir, 'meta'));
    const journal = JSON.parse(
      await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    const entries = journal.entries.filter((entry) => entry.tag < FIRST_MIGRATION_OF_THIS_UNIT);
    expect(entries.length).toBeLessThan(journal.entries.length);
    await writeFile(
      path.join(priorMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries }),
    );
    await Promise.all(
      entries.map((entry) =>
        cp(
          path.join(migrationsDir, `${entry.tag}.sql`),
          path.join(priorMigrationsDir, `${entry.tag}.sql`),
        ),
      ),
    );
    isolated = await createIsolatedTestDatabase(
      'aw_materialised_version_migration',
      databaseUrl,
      priorMigrationsDir,
    );

    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Pre-0040 workspace' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Pre-0040 owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    // Raw SQL for `agents`: this database is migrated only as far as 0039, while the drizzle table
    // object already names `materialised_version_id`.
    const insertAgent = (agentId: string, name: string, updatedAt: string) =>
      isolated.db.execute(sql`
        insert into agents (id, workspace_id, name, instructions, permissions, owner_principal_id, updated_at)
        values (${agentId}, ${workspaceId}, ${name}, '', ${JSON.stringify(READ_ONLY)}::jsonb,
                ${principalId}, ${updatedAt}::timestamptz)
      `);
    for (const [name, row] of Object.entries(seeded)) {
      // The pointer moved on day 02; the row was last written on day `at`.
      await insertAgent(row.agentId, name, `2026-01-${row.at}T00:00:00Z`);
      await isolated.db.insert(agentVersions).values({
        id: row.versionId,
        workspaceId,
        agentId: row.agentId,
        number: 1,
        summary: 'first',
        via: 'aw-push',
        body: {},
        createdByPrincipalId: principalId,
      });
      await isolated.db.insert(agentVersionPointers).values({
        workspaceId,
        agentId: row.agentId,
        environment: 'local',
        versionId: row.versionId,
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      });
    }
    await insertAgent(unpointed, 'unpointed', '2026-01-01T00:00:00Z');

    await runMigrations({ url: isolated.url, maxConnections: 4 }, migrationsDir);
  }, 300_000);

  afterAll(async () => {
    await isolated?.close();
    if (priorMigrationsDir !== undefined) await rm(priorMigrationsDir, { recursive: true });
  });

  it('materialises a row written at or before its pointer moved, and leaves the rest NULL', async () => {
    const rows = await isolated.db
      .select({ id: agents.id, materialisedVersionId: agents.materialisedVersionId })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId));
    const byId = new Map(rows.map((row) => [row.id, row.materialisedVersionId]));
    expect(byId.get(seeded.before.agentId)).toBe(seeded.before.versionId);
    expect(byId.get(seeded.equal.agentId)).toBe(seeded.equal.versionId);
    expect(byId.get(seeded.after.agentId)).toBeNull();
    expect(byId.get(unpointed)).toBeNull();
  });
});
