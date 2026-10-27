/**
 * US-STO-12 end to end, in-process: an agent granted `storage://acme-data/reports/` on a local-folder
 * connection is started through the real `POST /api/agents/:id/runs` handler, and the runner
 * double receives the folder read-only under `storage/acme-data/reports/` (the storage design,
 * §04, §05). The connection store is the real `file://` one; no Docker or runtime is needed, so
 * the default `pnpm test` lane runs it. The grants are passed to the loader directly, so the
 * catalog is the in-memory one; PostgreSQL grant storage is covered by the agent-version tests.
 * The pinned-version cases (lagging production, rename, delete, delete-and-recreate) read the
 * grants through the real `createRunAgentReader`.
 */
// @story US-STO-12
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEgressPolicyFromEnv } from '@agent-workspace/core';
import { createInMemoryObjectStore, openConnectionStore } from '@agent-workspace/core/storage';
import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearApplicationContext } from '../application-context';
import { FIXTURE_PERMISSIONS, versionRequest } from '../agent-versions/fixtures';
import { createAgentVersion } from '../agent-versions/handlers';
import { createInMemoryAgentVersionStoreProvider } from '../agent-versions/memory-store';
import { setAgentPointer } from '../agent-versions/pointers';
import { createRunAgentReader } from '../agent-versions/session-version';
import type { StorageConnectionLookup } from '../agent-versions/storage-grants';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import {
  createAgentRunResourceLoader,
  type RunStorageConnections,
} from '../compose/resource-loader';
import { createRunPreflight } from '../compose/run-preflight';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { startRun } from './api';
import type { RunPrincipal } from './environment';
import { InMemoryRunStore } from './memory-store';
import { installDeliveringRunApi, runnableAgent, startPreflight } from './run-delivery-fixtures';
import { createStorageService } from '../storage/service';

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const CSV = 'quarter,total\nq3,42\n';
const connectionId = crypto.randomUUID();

// A `file://` connection is the folder as it is on disk: `reports/2026/q3.csv` is the key.
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aw-sto12-'));
  await mkdir(join(root, 'reports', '2026'), { recursive: true });
  await mkdir(join(root, 'other'), { recursive: true });
  await writeFile(join(root, 'reports', '2026', 'q3.csv'), CSV);
  await writeFile(join(root, 'other', 'x.txt'), 'not granted');
});

afterEach(async () => {
  clearApplicationContext();
  await rm(root, { recursive: true, force: true });
});

interface StartOptions {
  readonly access: 'read' | 'read-write';
  readonly writeAllowed: boolean;
  /** The connection was deleted after the agent was granted it. */
  readonly gone?: boolean;
  /** The folders the run reads; `reports` with `access` when absent. */
  readonly grants?: readonly {
    connectionId: string;
    prefix: string;
    access: 'read' | 'read-write';
  }[];
  /** The connection's name now; `acme-data` when absent. */
  readonly name?: string;
  /** The connections that exist now, name by id; overrides `gone` and `name` when present. */
  readonly connections?: ReadonlyMap<string, string>;
}

/** The name of connection `id` as it is now, or `undefined` when it does not exist. */
function connectionName(options: StartOptions, id: string): string | undefined {
  if (options.connections !== undefined) return options.connections.get(id);
  return options.gone === true ? undefined : (options.name ?? 'acme-data');
}

/** `POST /api/agents/:id/runs` for an agent granted `reports` on the connection, through the real preflight. */
async function start(options: StartOptions) {
  const world = {
    catalogs: createInMemoryCatalogStore(),
    workspaceId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
  };
  const storage = createStorageService({
    catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
    objects: createInMemoryObjectStore(),
    log: noLog,
  });
  const storageConnections: RunStorageConnections = {
    get: (_workspaceId, id) => {
      const name = connectionName(options, id);
      return Promise.resolve(
        name === undefined
          ? null
          : { name, allowedPrefixes: ['reports', 'archive'], writeAllowed: options.writeAllowed },
      );
    },
    open: () =>
      openConnectionStore(
        `file://${root}`,
        { provider: 'file' },
        { writable: false, fileRoots: [root], egress: loadEgressPolicyFromEnv() },
      ),
    openWritable: () =>
      openConnectionStore(
        `file://${root}`,
        { provider: 'file' },
        { writable: true, fileRoots: [root], egress: loadEgressPolicyFromEnv() },
      ),
  };
  const bearer = crypto.randomUUID();
  const principal: RunPrincipal = {
    principalId: world.principalId,
    ownerPrincipalId: world.principalId,
    userId: world.userId,
    workspaceId: world.workspaceId,
    role: 'owner',
    scope: null,
  };
  const storageGrants = options.grants ?? [
    { connectionId, prefix: 'reports', access: options.access },
  ];
  const { agents, profiles, models, discover, agent } = await runnableAgent(
    world.workspaceId,
    principal,
  );
  const preflight = createRunPreflight({
    agents,
    profiles,
    models: { models, discover },
    workspaceDefault: () => Promise.resolve(null),
    projectDefault: () => Promise.resolve(null),
    projectDefaults: () => Promise.resolve(new Map()),
    deploymentDefaultModels: {},
    policyCeiling: null,
    runFiles: {
      loader: createAgentRunResourceLoader({
        catalog: world.catalogs,
        storage,
        storageConnections,
        sizesOnly: true,
      }),
      readRunAgent: () =>
        Promise.resolve({
          agent,
          assignments: { files: [], skillIds: [], connectorIds: [], storageGrants },
          toolBundles: [],
          subagents: [],
        }),
      projectOf: () => Promise.resolve(null),
    },
  });
  const store = new InMemoryRunStore();
  const runs = installDeliveringRunApi({
    world,
    storage,
    store,
    authenticate: (request) =>
      Promise.resolve(
        request.headers.get('authorization') === `Bearer ${bearer}` ? principal : null,
      ),
    storageGrants,
    storageConnections,
    agentId: agent.id,
    preflight: startPreflight(preflight),
  });
  const response = await startRun(
    new Request(`http://web.test/api/agents/${runs.agentId}/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'summarise' }),
    }),
    runs.agentId,
  );
  return { world, runs, store, response };
}

/** A started run: the request was accepted with `202`. */
async function run(options: StartOptions) {
  const { world, runs, response } = await start(options);
  expect(response.status, await response.clone().text()).toBe(202);
  const { run: started } = (await response.json()) as { run: { id: string; sessionId: string } };
  return { world, runs, started };
}

/** A start refused before it was queued: `422` with `code`, and no run row. */
async function expectRefused(options: StartOptions, code: string) {
  const { world, store, response } = await start(options);
  expect(response.status, await response.clone().text()).toBe(422);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe(code);
  expect((await store.listRuns(world.workspaceId, { limit: 10 })).items).toHaveLength(0);
}

describe('a run granted a connection folder', () => {
  it('[US-STO-12][api][run] a file:// connection lists and reads the files already in the folder, read-only', async () => {
    const { world, runs, started } = await run({ access: 'read', writeAllowed: false });
    const delivered = await runs.delivered(started.id);
    const cwd = `${world.workspaceId}/${started.sessionId}`;

    expect(delivered.files).toEqual([
      { kind: 'directory', path: 'storage/acme-data/reports', access: 'read' },
      {
        kind: 'file',
        path: 'storage/acme-data/reports/2026/q3.csv',
        access: 'read',
        size: Buffer.byteLength(CSV),
        sha256: createHash('sha256').update(CSV).digest('hex'),
      },
    ]);
    const member = delivered.archive.find(
      (entry) => entry.path === `${cwd}/storage/acme-data/reports/2026/q3.csv`,
    );
    expect(member).toMatchObject({ type: 'file', mode: 0o444, data: Buffer.from(CSV) });
    expect(delivered.archive.map((entry) => entry.path).join('\n')).not.toMatch(/other/u);
  });

  it('[US-STO-12][api][run] a read-write grant on a read-only connection is delivered read-only', async () => {
    const { runs, started } = await run({ access: 'read-write', writeAllowed: false });
    const delivered = await runs.delivered(started.id);
    expect(delivered.files).toMatchObject([{ access: 'read' }, { access: 'read' }]);
  });

  it('[US-STO-12][api][run] a read grant on a writable connection, to an agent that may write, is delivered 0444', async () => {
    const { world, runs, started } = await run({ access: 'read', writeAllowed: true });
    const delivered = await runs.delivered(started.id);
    const member = delivered.archive.find(
      (entry) =>
        entry.path ===
        `${world.workspaceId}/${started.sessionId}/storage/acme-data/reports/2026/q3.csv`,
    );
    expect(delivered.files).toMatchObject([{ access: 'read' }, { access: 'read' }]);
    expect(member).toMatchObject({ type: 'file', mode: 0o444 });
  });

  it('[US-STO-12][api][run] a read-write grant on a writable connection is delivered writable', async () => {
    const { world, runs, started } = await run({ access: 'read-write', writeAllowed: true });
    const delivered = await runs.delivered(started.id);
    const member = delivered.archive.find(
      (entry) =>
        entry.path ===
        `${world.workspaceId}/${started.sessionId}/storage/acme-data/reports/2026/q3.csv`,
    );
    expect(delivered.files).toMatchObject([{ access: 'read-write' }, { access: 'read-write' }]);
    expect(member).toMatchObject({ type: 'file', mode: 0o644 });
  });

  it('[US-STO-12][api][run] a folder over the run limit answers 422 run_files_too_large before the run is queued', async () => {
    // A sparse file: the listing reports its size and no byte is read before the refusal.
    await writeFile(join(root, 'reports', '2026', 'big.bin'), '');
    await truncate(join(root, 'reports', '2026', 'big.bin'), RUN_FILES_MAX_BYTES + 1);
    await expectRefused({ access: 'read', writeAllowed: false }, 'run_files_too_large');
  });

  it('[US-STO-12][api][run] a connection that is gone answers 422 run_storage_grant_unavailable before the run is queued', async () => {
    await expectRefused(
      { access: 'read', writeAllowed: false, gone: true },
      'run_storage_grant_unavailable',
    );
  });

  describe('read through the version the run is pinned to', () => {
    /** The connections that exist now, name by id; the deploy resolves `storage://` names against it. */
    let registry = new Map<string, string>();
    beforeEach(() => {
      registry = new Map([[connectionId, 'acme-data']]);
    });

    /**
     * Version 1 (`reports`) is on production, version 2 (`second`, or no folder when `null`) on
     * local; answers what a run pinned to version `number` reads.
     */
    async function pinnedVersions(second: string | null) {
      const workspaceId = crypto.randomUUID();
      const principalId = crypto.randomUUID();
      const agentProvider = createInMemoryAgentStoreProvider();
      const agents = agentProvider.forWorkspace(workspaceId);
      const provider = createInMemoryAgentVersionStoreProvider({
        agents: agentProvider,
        references: {},
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
      const deploy = async (
        number: number,
        prefix: string | null,
        environment: 'local' | 'production',
      ) => {
        const row = await agents.get(created.agent.id);
        if (row === null) throw new Error('the agent exists');
        const saved = await createAgentVersion(
          versionRequest({
            name: row.name,
            resources: {
              files:
                prefix === null ? [] : [{ path: `storage://acme-data/${prefix}`, access: 'read' }],
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
          const moved = await setAgentPointer(
            { environment: target, version: number },
            row,
            actor,
            deps,
          );
          expect(moved.status).toBe(200);
        }
      };
      await deploy(1, 'reports', 'production');
      await deploy(2, second, 'local');

      const read = createRunAgentReader({
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
              (await store.list(created.agent.id))?.versions.find(
                (version) => version.id === versionId,
              ) ?? null,
            resolveDefinition: (references) => store.resolveDefinition(references),
            list: (id) => store.list(id),
            agentsByName: (names) => store.agentsByName(names),
            storageGrantsOf: (versionId) => store.storageGrantsOf(versionId),
          }),
      });
      return async (number: number) => {
        const version = await store.find(created.agent.id, number);
        if (version === null) throw new Error(`version ${String(number)} exists`);
        return (await read(workspaceId, created.agent.id, version.id)).assignments.storageGrants;
      };
    }

    /** What a production run (version 1) reads while local is on version 2 (`archive`). */
    async function productionGrants() {
      return (await pinnedVersions('archive'))(1);
    }

    it('[US-STO-12][api][run] a production version that lags local delivers its own folder, not local’s', async () => {
      const grants = await productionGrants();
      const { runs, started } = await run({ access: 'read', writeAllowed: false, grants });
      const delivered = await runs.delivered(started.id);

      expect(delivered.files).toMatchObject([
        { kind: 'directory', path: 'storage/acme-data/reports' },
        { kind: 'file', path: 'storage/acme-data/reports/2026/q3.csv' },
      ]);
    });

    it('[US-STO-12][api][run] a connection renamed after the deploy is delivered under its new name', async () => {
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
    });

    it('[US-STO-12][api][run] a connection deleted after version 1 refuses a version 1 run while a version 2 run starts', async () => {
      const grantsOf = await pinnedVersions(null);
      registry.delete(connectionId);
      const connections = registry;

      await expectRefused(
        { access: 'read', writeAllowed: false, connections, grants: await grantsOf(1) },
        'run_storage_grant_unavailable',
      );
      const { runs, started } = await run({
        access: 'read',
        writeAllowed: false,
        connections,
        grants: await grantsOf(2),
      });
      expect((await runs.delivered(started.id)).files).toEqual([]);
    });

    it('[US-STO-12][api][run] a connection recreated under the same name is never read by a version 1 run', async () => {
      const grantsOf = await pinnedVersions(null);
      registry.delete(connectionId);
      registry.set(crypto.randomUUID(), 'acme-data');

      await expectRefused(
        { access: 'read', writeAllowed: false, connections: registry, grants: await grantsOf(1) },
        'run_storage_grant_unavailable',
      );
    });
  });
});
