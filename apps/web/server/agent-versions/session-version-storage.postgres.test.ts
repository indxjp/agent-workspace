/**
 * A run reads the storage grants of its own version (the storage design, §05) on PostgreSQL: a
 * production version that lags `local` keeps its folder, a connection deleted after a version was
 * deployed makes that version fail closed, and a connection recreated under the same name is never
 * bound to an old version. A missing `TEST_DATABASE_URL` makes `beforeAll` throw, so this suite
 * fails instead of skipping.
 */
// @story US-STO-12
import crypto from 'node:crypto';

import {
  createDatabaseAgentRepositoryProvider,
  createDatabaseAgentResourceRepositoryProvider,
  createDatabaseAgentVersionEvaluationRepositoryProvider,
  createDatabaseAgentVersionRepositoryProvider,
  createDatabaseStorageConnectionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRepositoryAgentResourceStoreProvider } from '../agents/resource-store';
import { createRepositoryAgentStoreProvider } from '../agents/store';
import { FIXTURE_PERMISSIONS, versionRequest, type FixtureEdits } from './fixtures';
import { createAgentVersion } from './handlers';
import { setAgentPointer } from './pointers';
import { createRunAgentReader } from './session-version';
import { storageConnectionLookup } from './storage-grants';
import { createRepositoryAgentVersionStoreProvider } from './store';

describe('a run reads its own version’s storage grants (PostgreSQL)', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_sto_507_version_grants');
    await isolated.db.insert(workspaces).values({ id: workspaceId, slug: 'sto-507', name: 'S' });
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

  async function open() {
    const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
    const scope = await scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('the fixture workspace did not resolve');
    const agentRepository = createDatabaseAgentRepositoryProvider(isolated.db);
    const agentVersions = createDatabaseAgentVersionRepositoryProvider(isolated.db).forScope(scope);
    const connections = createDatabaseStorageConnectionRepositoryProvider(isolated.db).forScope(
      scope,
    );
    const store = await createRepositoryAgentVersionStoreProvider({
      repositories: createDatabaseAgentVersionRepositoryProvider(isolated.db),
      evaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db),
      scopes,
    }).forWorkspace(workspaceId);
    if (store === null) throw new Error('the repository store resolves the fixture workspace');
    const storageConnections = storageConnectionLookup(connections);

    const created = await agentRepository.forScope(scope).create({
      name: 'Grants ' + crypto.randomUUID(),
      instructions: 'Before any version.',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
      createdBy: userId,
      ownerPrincipalId: principalId,
    });
    if (created.kind !== 'created') throw new Error(`agent seed failed: ${created.kind}`);
    const agentId = created.agent.id;

    const connect = async (name: string): Promise<string> => {
      const id = crypto.randomUUID();
      await connections.create({
        id,
        name,
        provider: 's3',
        url: 's3://acme-bucket',
        allowedPrefixes: ['reports', 'archive'],
        writeAllowed: false,
      });
      return id;
    };

    /** Save the next version and point each of `environments` at it; answers its id. */
    const push = async (
      edits: FixtureEdits,
      environments: readonly ('local' | 'production')[] = ['local'],
    ): Promise<string> => {
      const row = await agentRepository.forScope(scope).get(agentId);
      if (row === null) throw new Error('the agent exists');
      const saved = await createAgentVersion(
        versionRequest({ name: row.name, ...edits }),
        row,
        principalId,
        { store, storageConnections },
      );
      if (saved.status !== 201) throw new Error(`the version saves: ${JSON.stringify(saved)}`);
      const { id: versionId, number } = saved.body as { id: string; number: number };
      for (const environment of environments) {
        const moved = await setAgentPointer(
          { environment, version: number },
          (await agentRepository.forScope(scope).get(agentId)) ?? row,
          { principalId, userId, actor: 'owner' },
          { store, storageConnections },
        );
        if (moved.status !== 200) throw new Error(`the pointer moves: ${JSON.stringify(moved)}`);
      }
      return versionId;
    };

    const read = createRunAgentReader({
      agents: createRepositoryAgentStoreProvider({ repositories: agentRepository, scopes }),
      assignments: createRepositoryAgentResourceStoreProvider({
        repositories: createDatabaseAgentResourceRepositoryProvider(isolated.db),
        scopes,
      }),
      versions: () => Promise.resolve(agentVersions),
    });
    return {
      connections,
      connect,
      push,
      readVersion: (versionId: string) => read(workspaceId, agentId, versionId),
    };
  }

  const folder = (name: string, prefix: string): FixtureEdits => ({
    resources: { files: [{ path: `storage://${name}/${prefix}`, access: 'read' }] },
  });

  it('[US-STO-12][unit][run] a production version that lags local delivers its own folder', async () => {
    const h = await open();
    const name = 'acme-' + crypto.randomUUID();
    const connectionId = await h.connect(name);
    const v1 = await h.push(folder(name, 'reports'), ['local', 'production']);
    const v2 = await h.push(folder(name, 'archive'));

    expect((await h.readVersion(v1)).assignments.storageGrants).toEqual([
      { connectionId, prefix: 'reports', access: 'read' },
    ]);
    expect((await h.readVersion(v2)).assignments.storageGrants).toEqual([
      { connectionId, prefix: 'archive', access: 'read' },
    ]);
  }, 60_000);

  it('[US-STO-12][unit][run] a renamed connection keeps the stored id, so the version still runs', async () => {
    const h = await open();
    const name = 'acme-' + crypto.randomUUID();
    const connectionId = await h.connect(name);
    const v1 = await h.push(folder(name, 'reports'));

    const renamed = await h.connections.update(connectionId, { name: 'renamed-' + name });
    expect(renamed.kind).toBe('updated');

    expect((await h.readVersion(v1)).assignments.storageGrants).toEqual([
      { connectionId, prefix: 'reports', access: 'read' },
    ]);
  }, 60_000);

  it('[US-STO-12][unit][run] a connection deleted after version 1 refuses version 1 while version 2 runs', async () => {
    const h = await open();
    const name = 'acme-' + crypto.randomUUID();
    const connectionId = await h.connect(name);
    const v1 = await h.push(folder(name, 'reports'));
    const v2 = await h.push({});
    expect(await h.connections.delete(connectionId)).not.toBeNull();

    await expect(h.readVersion(v1)).rejects.toMatchObject({
      code: 'run_storage_grant_unavailable',
      publicMessage: expect.stringContaining('whose connection no longer exists') as string,
    });
    expect((await h.readVersion(v2)).assignments.storageGrants).toEqual([]);
  }, 60_000);

  it('[US-STO-12][unit][run] a connection deleted and recreated under the same name is not bound to version 1', async () => {
    const h = await open();
    const name = 'acme-' + crypto.randomUUID();
    const first = await h.connect(name);
    const v1 = await h.push(folder(name, 'reports'));
    await h.push({});
    await h.connections.delete(first);
    const second = await h.connect(name);
    expect(second).not.toBe(first);

    await expect(h.readVersion(v1)).rejects.toMatchObject({
      code: 'run_storage_grant_unavailable',
    });
  }, 60_000);
});
