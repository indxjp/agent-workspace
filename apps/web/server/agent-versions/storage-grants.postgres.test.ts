/**
 * Storing storage grants through core's PostgreSQL repository: the shared conformance scenarios
 * (`storage-grants.conformance.ts`), and what only the database proves — the connection foreign key
 * refuses to delete a connection a version still grants. A missing `TEST_DATABASE_URL` makes
 * `beforeAll` throw, so this suite fails instead of skipping.
 */
import crypto from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agentStorageGrants,
  auditEvents,
  createDatabaseAgentVersionEvaluationRepositoryProvider,
  createDatabaseAgentVersionRepositoryProvider,
  createDatabaseStorageConnectionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  storageConnections,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { FIXTURE_PERMISSIONS } from './fixtures';
import { describeStorageGrantStore, type StorageGrantHarness } from './storage-grants.conformance';
import { createRepositoryAgentVersionStoreProvider } from './store';

describe('storage grants on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_sto_506_store');
    await isolated.db.insert(workspaces).values({ id: workspaceId, slug: 'sto-store', name: 'S' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: userId + '@example.test', name: 'Owner' });
    const membershipId = crypto.randomUUID();
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  async function connect(name?: string): Promise<string> {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('the fixture workspace did not resolve');
    const id = crypto.randomUUID();
    await createDatabaseStorageConnectionRepositoryProvider(isolated.db)
      .forScope(scope)
      .create({
        id,
        name: name ?? 'acme-' + id,
        provider: 's3',
        url: 's3://acme-bucket',
        allowedPrefixes: ['reports', 'archive'],
        writeAllowed: true,
      });
    return id;
  }

  async function open(): Promise<StorageGrantHarness> {
    const provider = createRepositoryAgentVersionStoreProvider({
      repositories: createDatabaseAgentVersionRepositoryProvider(isolated.db),
      evaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db),
      scopes: createDatabaseWorkspaceScopeResolver(isolated.db),
    });
    const store = await provider.forWorkspace(workspaceId);
    if (store === null) throw new Error('the repository store resolves the fixture workspace');
    return {
      store,
      principalId,
      connections: { first: await connect(), second: await connect() },
      grantsOf: async (agentId) =>
        (
          await isolated.db
            .select({
              connectionId: agentStorageGrants.connectionId,
              prefix: agentStorageGrants.prefix,
              access: agentStorageGrants.access,
            })
            .from(agentStorageGrants)
            .where(eq(agentStorageGrants.agentId, agentId))
        ).sort((a, b) => a.prefix.localeCompare(b.prefix)),
      grantAuditsOf: async (agentId) =>
        (
          await isolated.db
            .select({ label: auditEvents.subjectLabel })
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.action, 'storage-grant-changed'),
                eq(auditEvents.subjectId, agentId),
              ),
            )
            .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))
        ).map((row) => row.label),
    };
  }

  describeStorageGrantStore('the PostgreSQL repository', open);

  // @story US-STO-12
  it('[US-STO-12][contract][sdk] the database refuses to delete a connection a version grants', async () => {
    const harness = await open();
    const created = await harness.store.createAgentWithFirstVersion({
      agent: {
        name: 'Granted agent',
        instructions: 'Read.',
        model: null,
        permissions: FIXTURE_PERMISSIONS,
        policy: null,
        references: {
          modelConnectionId: null,
          runtimeProfileId: null,
          skillIds: [],
          connectorIds: [],
          files: [],
          storageGrants: [
            { connectionId: harness.connections.first, prefix: 'reports', access: 'read' },
          ],
        },
        ownerPrincipalId: principalId,
        createdBy: null,
      },
      version: {
        summary: 'first',
        via: 'api',
        body: { surfaces: [] },
        createdByPrincipalId: principalId,
      },
      environment: 'local',
    });
    expect(created.kind).toBe('created');
    await expect(
      isolated.db
        .delete(storageConnections)
        .where(eq(storageConnections.id, harness.connections.first)),
    ).rejects.toMatchObject({
      cause: { code: '23503', constraint: 'agent_storage_grants_connection_workspace_fk' },
    });
    expect(await harness.store.isConnectionGranted(harness.connections.first)).toBe(true);
    await isolated.db
      .delete(storageConnections)
      .where(eq(storageConnections.id, harness.connections.second));
  });

  /** Version 1 granted `connection` on a new agent; `local` then moves to version 2, which grants nothing. */
  async function grantedThenReleased(harness: StorageGrantHarness, connectionId: string) {
    const created = await harness.store.createAgentWithFirstVersion({
      agent: {
        name: 'Released ' + connectionId,
        instructions: 'Read.',
        model: null,
        permissions: FIXTURE_PERMISSIONS,
        policy: null,
        references: {
          modelConnectionId: null,
          runtimeProfileId: null,
          skillIds: [],
          connectorIds: [],
          files: [],
          storageGrants: [{ connectionId, prefix: 'reports', access: 'read' }],
        },
        ownerPrincipalId: principalId,
        createdBy: null,
      },
      version: {
        summary: 'first',
        via: 'api',
        body: { surfaces: [] },
        createdByPrincipalId: principalId,
      },
      environment: 'local',
    });
    if (created.kind !== 'created') throw new Error(`the agent was not created: ${created.kind}`);
    const second = await harness.store.create(created.agent.id, {
      summary: 'second',
      via: 'api',
      body: { surfaces: [] },
      createdByPrincipalId: principalId,
    });
    if (second.kind !== 'created') throw new Error(`the version was not saved: ${second.kind}`);
    const moved = await harness.store.applyAndPoint(created.agent.id, {
      environment: 'local',
      number: second.version.number,
      reason: 'set',
      agent: {
        name: created.agent.name,
        instructions: 'Read.',
        model: null,
        permissions: FIXTURE_PERMISSIONS,
        policy: null,
        references: {
          modelConnectionId: null,
          runtimeProfileId: null,
          skillIds: [],
          connectorIds: [],
          files: [],
          storageGrants: [],
        },
      },
      audit: {
        subjectLabel: created.agent.name,
        actorPrincipalId: principalId,
        actorUserId: null,
        actorLabel: 'test',
      },
    });
    expect(moved.kind).toBe('applied');
    return { agentId: created.agent.id, versionId: created.version.id };
  }

  // @story US-STO-12
  it('[US-STO-12][contract][sdk] deleting a connection removes the grants old versions held on it', async () => {
    const harness = await open();
    const { versionId: v1 } = await grantedThenReleased(harness, harness.connections.first);
    expect(await harness.store.storageGrantsOf(v1)).toHaveLength(1);

    await isolated.db
      .delete(storageConnections)
      .where(eq(storageConnections.id, harness.connections.first));

    expect(await harness.store.storageGrantsOf(v1)).toEqual([]);
  });

  // @story US-STO-12
  it('[US-STO-12][contract][sdk] a connection recreated under the same name is not bound to an old version', async () => {
    const harness = await open();
    const name = 'recreated-' + crypto.randomUUID();
    const first = await connect(name);
    const { versionId: v1 } = await grantedThenReleased(harness, first);
    await isolated.db.delete(storageConnections).where(eq(storageConnections.id, first));
    const second = await connect(name);

    const rows = await harness.store.storageGrantsOf(v1);

    expect(second).not.toBe(first);
    expect(rows).toEqual([]);
  });

  // @story US-STO-12
  it('[US-STO-12][contract][sdk] a version saved naming a connection deleted since validation stores no row and does not fail', async () => {
    const harness = await open();
    const { agentId } = await grantedThenReleased(harness, harness.connections.second);
    const saved = await harness.store.create(agentId, {
      summary: 'racing',
      via: 'api',
      body: { surfaces: [] },
      createdByPrincipalId: principalId,
      storageGrants: [{ connectionId: crypto.randomUUID(), prefix: 'reports', access: 'read' }],
    });
    if (saved.kind !== 'created') throw new Error(`the version was not saved: ${saved.kind}`);

    expect(await harness.store.storageGrantsOf(saved.version.id)).toEqual([]);
  });
});
