import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_PERMISSIONS, versionRequest } from '../agent-versions/fixtures';
import { createAgentVersion } from '../agent-versions/handlers';
import { createInMemoryAgentVersionStoreProvider } from '../agent-versions/memory-store';
import { setAgentPointer } from '../agent-versions/pointers';
import { createRunAgentReader } from '../agent-versions/session-version';
import type { StorageConnectionLookup } from '../agent-versions/storage-grants';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { connectionId, run } from './run-storage-connection.test-support';

/** Current connection names, resolved when a version is deployed or read. */
let registry = new Map<string, string>();

async function createVersionContext() {
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentProvider = createInMemoryAgentStoreProvider();
  const agents = agentProvider.forWorkspace(workspaceId);
  const provider = createInMemoryAgentVersionStoreProvider({
    agents: agentProvider,
    references: {},
    connectionExists: (_workspaceId, id) => Promise.resolve(registry.has(id)),
  });
  const store = await provider.forWorkspace(workspaceId);
  if (store === null) throw new Error('the memory store answers every workspace');
  const created = await agents.create(
    {
      name: 'General',
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the agent');
  const agentId = created.agent.id;
  const lookup: StorageConnectionLookup = (names) =>
    Promise.resolve(
      new Map(
        [...registry]
          .filter(([, name]) => names.includes(name))
          .map(([id, name]) => [
            name,
            { id, allowedPrefixes: ['reports', 'archive'], writeAllowed: false },
          ]),
      ),
    );
  const deps = { store, storageConnections: lookup };
  const actor = { principalId, userId: null, actor: 'builder key' };

  return { workspaceId, principalId, agentProvider, agents, store, agentId, deps, actor };
}

type VersionContext = Awaited<ReturnType<typeof createVersionContext>>;

async function deployVersion(
  { agents, agentId, principalId, deps, actor }: VersionContext,
  {
    number,
    prefix,
    environment,
  }: { number: number; prefix: string | null; environment: 'local' | 'production' },
) {
  const row = await agents.get(agentId);
  if (row === null) throw new Error('the agent exists');
  const saved = await createAgentVersion(
    versionRequest({
      name: row.name,
      resources: {
        files: prefix === null ? [] : [{ path: `storage://acme-data/${prefix}`, access: 'read' }],
      },
    }),
    row,
    principalId,
    deps,
  );
  expect(saved.status).toBe(201);
  for (const target of environment === 'production'
    ? (['local', 'production'] as const)
    : (['local'] as const)) {
    const moved = await setAgentPointer({ environment: target, version: number }, row, actor, deps);
    expect(moved.status).toBe(200);
  }
}

function pinnedVersionReader({ agentProvider, store, agentId }: VersionContext) {
  return createRunAgentReader({
    agents: agentProvider,
    assignments: {
      forWorkspace: () => ({
        get: () =>
          Promise.resolve({ files: [], skillIds: [], connectorIds: [], storageGrants: [] }),
        replace: () => Promise.reject(new Error('unused')),
      }),
    },
    versions: () =>
      Promise.resolve({
        findById: async (versionId) =>
          (await store.list(agentId))?.versions.find((version) => version.id === versionId) ?? null,
        resolveDefinition: (references) => store.resolveDefinition(references),
        list: (id) => store.list(id),
        agentsByName: (names) => store.agentsByName(names),
        storageGrantsOf: (versionId) => store.storageGrantsOf(versionId),
      }),
  });
}

/** Deploy production version 1 and local version 2; read grants from a pinned version. */
async function pinnedVersions(second: string | null) {
  const context = await createVersionContext();
  const { workspaceId, agentId, agents, store, actor, deps } = context;
  await deployVersion(context, { number: 1, prefix: 'reports', environment: 'production' });
  await deployVersion(context, { number: 2, prefix: second, environment: 'local' });
  const read = pinnedVersionReader(context);
  const grantsOf = async (number: number) => {
    const version = await store.find(agentId, number);
    if (version === null) throw new Error(`version ${String(number)} exists`);
    return (await read(workspaceId, agentId, version.id)).assignments.storageGrants;
  };
  return Object.assign(grantsOf, {
    /** Point `local` at version `number`, as `aw rollback` or the console does. */
    pointLocal: async (number: number) => {
      const row = await agents.get(agentId);
      if (row === null) throw new Error('the agent exists');
      return setAgentPointer({ environment: 'local', version: number }, row, actor, deps);
    },
    /** Whether the agent's current grants name the connection: what its DELETE is refused on. */
    isGranted: (id: string) => store.isConnectionGranted(id),
  });
}

async function productionGrants() {
  return (await pinnedVersions('archive'))(1);
}

export function registerVersionPinTests() {
  describe('read through the version the run is pinned to', () => {
    beforeEach(() => {
      registry = new Map([[connectionId, 'acme-data']]);
    });

    it(
      '[US-STO-12][api][run] a production version that lags local delivers its own folder, not local’s',
      usSTO12ApiRunProductionVersionThat,
    );

    it(
      '[US-STO-12][api][run] a connection renamed after the deploy is delivered under its new name',
      usSTO12ApiRunConnectionRenamedAfter,
    );

    it(
      '[US-STO-12][api][run] a connection deleted after version 1 refuses a version 1 run while a version 2 run starts',
      usSTO12ApiRunConnectionDeletedAfter,
    );

    it(
      '[US-STO-12][api][run] a connection recreated under the same name is never read by a version 1 run',
      usSTO12ApiRunConnectionRecreatedUnder,
    );

    it(
      '[US-STO-12][api][run] pointing local back at version 1 after a delete-and-recreate binds it to no connection',
      usSTO12ApiRunPointingLocalBack,
    );

    it(
      '[US-STO-12][api][run] pointing local back at version 1 restores the connection it was deployed with',
      usSTO12ApiRunPointingLocalBackCase,
    );
  });
}

async function usSTO12ApiRunProductionVersionThat() {
  const grants = await productionGrants();
  const { runs, started } = await run({ access: 'read', writeAllowed: false, grants });
  const delivered = await runs.delivered(started.id);

  expect(delivered.files).toMatchObject([
    { kind: 'directory', path: 'storage/acme-data/reports' },
    { kind: 'file', path: 'storage/acme-data/reports/2026/q3.csv' },
  ]);
}

async function usSTO12ApiRunConnectionRenamedAfter() {
  const grants = await productionGrants();
  const { runs, started } = await run({
    access: 'read',
    writeAllowed: false,
    grants,
    name: 'acme-archive',
  });
  const delivered = await runs.delivered(started.id);

  expect(delivered.files).toMatchObject([
    { kind: 'directory', path: 'storage/acme-archive/reports' },
    { kind: 'file', path: 'storage/acme-archive/reports/2026/q3.csv' },
  ]);
}

async function usSTO12ApiRunConnectionDeletedAfter() {
  const grantsOf = await pinnedVersions(null);
  registry.delete(connectionId);
  const connections = registry;

  // The delete took version 1's grant row with it, as PostgreSQL's cascade does, so the run is
  // refused while its version is read, before any connection is looked up.
  await expect(grantsOf(1)).rejects.toMatchObject({
    code: 'run_storage_grant_unavailable',
    publicMessage: expect.stringContaining('whose connection no longer exists') as string,
  });
  const { runs, started } = await run({
    access: 'read',
    writeAllowed: false,
    connections,
    grants: await grantsOf(2),
  });
  expect((await runs.delivered(started.id)).files).toEqual([]);
}

async function usSTO12ApiRunConnectionRecreatedUnder() {
  const grantsOf = await pinnedVersions(null);
  registry.delete(connectionId);
  registry.set(crypto.randomUUID(), 'acme-data');

  await expect(grantsOf(1)).rejects.toMatchObject({
    code: 'run_storage_grant_unavailable',
  });
}

async function usSTO12ApiRunPointingLocalBack() {
  const versions = await pinnedVersions(null);
  registry.delete(connectionId);
  const recreated = crypto.randomUUID();
  registry.set(recreated, 'acme-data');

  expect((await versions.pointLocal(1)).status).toBe(200);

  // Version 1 was deployed with the deleted connection: its folder is not bound again by name,
  // so the recreated connection is held by nothing and its DELETE is not refused.
  expect(await versions.isGranted(recreated)).toBe(false);
  await expect(versions(1)).rejects.toMatchObject({ code: 'run_storage_grant_unavailable' });
}

async function usSTO12ApiRunPointingLocalBackCase() {
  const versions = await pinnedVersions('archive');
  // A second connection under another name, which version 1 never named.
  registry.set(crypto.randomUUID(), 'acme-archive');

  expect((await versions.pointLocal(1)).status).toBe(200);

  expect(await versions.isGranted(connectionId)).toBe(true);
  expect(await versions(1)).toEqual([{ connectionId, prefix: 'reports', access: 'read' }]);
}
