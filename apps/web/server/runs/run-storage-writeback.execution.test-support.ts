import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import { encodeUstar } from '@agent-workspace/runtime/transfer';
import { expect } from 'vitest';
import {
  createAgentRunResourceLoader,
  type RunStorageConnections,
  type RunWritableConnectionStore,
} from '../compose/resource-loader';
import { createRunPreflight } from '../compose/run-preflight';
import { writeBackStorage, type StorageWriteBackAuditEvent } from '../compose/storage-writeback';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { startRun } from './api';
import type { RunPrincipal } from './environment';
import {
  installDeliveringRunApi,
  runnableAgent,
  startPreflight,
} from './run-delivery-fixtures.test-support';
import { createStorageService } from '../storage/service';
import {
  noLog,
  CSV,
  type Backend,
  text,
  filesIn,
  type World,
  SessionBusyRunStore,
  backends,
} from './run-storage-writeback.fixture.test-support';
export async function runWriteback(makeBackend: () => Promise<Backend>, options: WritebackOptions) {
  const context = await prepareWritebackStorage(makeBackend, options);
  const { bucket, state, uploads, audits, world, storage, connections, workspaceRoot } = context;
  const { bearer, storageGrants, agent, readRunAgent, preflight, principal } =
    await prepareWritebackAgent(context);
  const sessionId = randomUUID();

  const cwd = `${world.workspaceId}/${sessionId}`;

  const folder = `${cwd}/storage/acme-data/reports`;

  const post = () =>
    startRun(
      new Request(`http://web.test/api/agents/${runs.agentId}/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'summarise' }),
      }),
      runs.agentId,
    );

  const runs = installDeliveringRunApi({
    world,
    storage,
    store: new SessionBusyRunStore(),
    authenticate: (request) =>
      Promise.resolve(
        request.headers.get('authorization') === `Bearer ${bearer}` ? principal : null,
      ),
    storageGrants,
    storageConnections: connections,
    agentId: agent.id,
    sessionId,
    preflight: startPreflight(preflight),
    runnerFiles: (path) =>
      workspaceRoot === undefined && path === folder
        ? (options.tar?.(folder) ?? encodeUstar(filesIn(folder, options.after ?? {})))
        : null,
    onRun: async () => {
      // On a local-disk runtime the agent edits the extracted folder in place.
      if (workspaceRoot !== undefined) {
        for (const [name, content] of Object.entries(options.after ?? {})) {
          const target = join(workspaceRoot, folder, name);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content);
        }
      }
      await options.duringRun?.(state);
    },
    ...(workspaceRoot === undefined ? {} : { localDiskRoot: workspaceRoot }),
    storageWriteback: async (writeBack) => {
      await options.duringWriteBack?.(post);
      return writeBackStorage(writeBack, {
        readRunAgent,
        connections,
        audit: (event) => {
          audits.push(event);
          return Promise.resolve();
        },
        stillRunning: () => Promise.resolve(true),
      });
    },
  });

  const response = await post();

  expect(response.status, await response.clone().text()).toBe(202);

  const { run: started } = (await response.json()) as { run: { id: string } };

  await runs.delivered(started.id);

  return {
    text: (key: string) => text(bucket, key),
    uploads,
    labels: audits.map((event) => event.subjectLabel),
    state,
  };
}
export type WritebackRun = (
  options: Parameters<typeof runWriteback>[1],
) => ReturnType<typeof runWriteback>;

type WritebackOptions = {
  readonly access?: 'read' | 'read-write';
  /** Also grant `reports/2026` read only at launch. */
  readonly nestedReadOnly?: boolean;
  readonly after?: Readonly<Record<string, string>>;
  readonly tar?: (folder: string) => Uint8Array;
  readonly duringRun?: (world: World) => Promise<void>;
  /** Runs once the write-back has started; `post` sends the session a second message. */
  readonly duringWriteBack?: (post: () => Promise<Response>) => Promise<void>;
  /**
   * A `local-disk` runtime: the launcher extracts the folder into a workspace root on this host,
   * the agent leaves `after` there, and the write-back reads it back from disk, not `/files`.
   */
  readonly localDisk?: true;
};
function trackedConnections(state: World, uploads: string[]): RunStorageConnections {
  const backendOf = (id: string) => {
    const found = state.backends.get(id);
    if (found === undefined) throw new Error('no such connection');
    return found;
  };

  const connections: RunStorageConnections = {
    get: (_workspaceId, id) => {
      const row = state.rows.get(id);
      return Promise.resolve(row === undefined ? null : { ...row });
    },
    open: (_workspaceId, id) => backendOf(id).open(false),
    openWritable: async (_workspaceId, id): Promise<RunWritableConnectionStore> => {
      const store = await backendOf(id).open(true);
      return {
        read: (key) => store.read(key),
        write: (key, body, writeOptions) => {
          uploads.push(key);
          return store.write(key, body, writeOptions);
        },
      };
    },
  };
  return connections;
}
async function prepareWritebackStorage(
  makeBackend: () => Promise<Backend>,
  options: WritebackOptions,
) {
  const connectionId = randomUUID();

  const backend = await makeBackend();

  const workspaceRoot =
    options.localDisk === true ? await mkdtemp(join(tmpdir(), 'aw-sto12-wb-local-')) : undefined;

  if (workspaceRoot !== undefined) {
    backends.push({
      open: () => Promise.reject(new Error('the workspace root is not a connection')),
      teardown: () => rm(workspaceRoot, { recursive: true, force: true }),
    });
  }

  backends.push(backend);

  const bucket = await backend.open(true);

  await bucket.write('reports/2026/q3.csv', new Blob([CSV]).stream(), {});

  await bucket.write('reports/2026/q2.csv', new Blob(['q2,40\n']).stream(), {});

  const state: World = {
    rows: new Map([
      [connectionId, { name: 'acme-data', allowedPrefixes: ['reports'], writeAllowed: true }],
    ]),
    backends: new Map([[connectionId, backend]]),
    makeBackend: async () => {
      const made = await makeBackend();
      backends.push(made);
      return made;
    },
    agentWrites: true,
    grantAccess: options.access ?? 'read-write',
    nestedReadOnly: options.nestedReadOnly ?? false,
  };

  const uploads: string[] = [];

  const audits: StorageWriteBackAuditEvent[] = [];

  const world = {
    catalogs: createInMemoryCatalogStore(),
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    userId: randomUUID(),
  };

  const storage = createStorageService({
    catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
    objects: createInMemoryObjectStore(),
    log: noLog,
  });
  const connections = trackedConnections(state, uploads);
  return {
    connectionId,
    bucket,
    state,
    uploads,
    audits,
    world,
    storage,
    connections,
    workspaceRoot,
  };
}
type WritebackStorage = Awaited<ReturnType<typeof prepareWritebackStorage>>;
async function prepareWritebackAgent(
  context: Pick<WritebackStorage, 'connectionId' | 'state' | 'world' | 'storage' | 'connections'>,
) {
  const { connectionId, state, world, storage, connections } = context;
  const bearer = randomUUID();

  const principal: RunPrincipal = {
    principalId: world.principalId,
    ownerPrincipalId: world.principalId,
    userId: world.userId,
    workspaceId: world.workspaceId,
    role: 'owner',
    scope: null,
  };

  const grantsOf = (world: World) => [
    { connectionId, prefix: 'reports', access: world.grantAccess },
    ...(world.nestedReadOnly
      ? [{ connectionId, prefix: 'reports/2026', access: 'read' as const }]
      : []),
  ];

  const storageGrants = grantsOf(state);

  const { agents, profiles, models, discover, agent } = await runnableAgent(
    world.workspaceId,
    principal,
  );

  // The run's agent and grants as they are when read: a test may close a gate during the run.
  const readRunAgent = () =>
    Promise.resolve({
      agent: { ...agent, permissions: { ...agent.permissions, writeFiles: state.agentWrites } },
      assignments: {
        files: [],
        skillIds: [],
        connectorIds: [],
        storageGrants: grantsOf(state),
      },
      toolBundles: [],
      subagents: [],
    });

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
        storageConnections: connections,
        sizesOnly: true,
      }),
      readRunAgent,
      projectOf: () => Promise.resolve(null),
    },
  });
  return { bearer, storageGrants, agent, readRunAgent, preflight, principal };
}
