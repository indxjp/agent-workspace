import { loadEgressPolicyFromEnv } from '@agent-workspace/core';
import { createInMemoryObjectStore, openConnectionStore } from '@agent-workspace/core/storage';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import { clearApplicationContext } from '../application-context';
import {
  createAgentRunResourceLoader,
  type RunStorageConnections,
} from '../compose/resource-loader';
import { createRunPreflight } from '../compose/run-preflight';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createStorageService } from '../storage/service';
import { startRun } from './api';
import type { RunPrincipal } from './environment';
import { InMemoryRunStore } from './memory-store';
import {
  installDeliveringRunApi,
  runnableAgent,
  startPreflight,
} from './run-delivery-fixtures.test-support';

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

export const CSV = 'quarter,total\nq3,42\n';

export const connectionId = crypto.randomUUID();

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
  /** Opens the connection's read-only store; the `file://` folder when absent. */
  readonly open?: RunStorageConnections['open'];
  /** A `local-disk` runtime whose workspace root is this folder; a push-archive one when absent. */
  readonly localDiskRoot?: string;
}

function connectionName(options: StartOptions, id: string): string | undefined {
  if (options.connections !== undefined) return options.connections.get(id);
  return options.gone === true ? undefined : (options.name ?? 'acme-data');
}

function storageConnectionsFor(options: StartOptions): RunStorageConnections {
  return {
    get: (_workspaceId, id) => {
      const name = connectionName(options, id);
      return Promise.resolve(
        name === undefined
          ? null
          : { name, allowedPrefixes: ['reports', 'archive'], writeAllowed: options.writeAllowed },
      );
    },
    open:
      options.open ??
      (() =>
        openConnectionStore(
          `file://${root}`,
          { provider: 'file' },
          { writable: false, fileRoots: [root], egress: loadEgressPolicyFromEnv() },
        )),
    openWritable: () =>
      openConnectionStore(
        `file://${root}`,
        { provider: 'file' },
        { writable: true, fileRoots: [root], egress: loadEgressPolicyFromEnv() },
      ),
  };
}

function runPrincipalFor(world: {
  principalId: string;
  userId: string;
  workspaceId: string;
}): RunPrincipal {
  return {
    principalId: world.principalId,
    ownerPrincipalId: world.principalId,
    userId: world.userId,
    workspaceId: world.workspaceId,
    role: 'owner',
    scope: null,
  };
}

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
  const storageConnections = storageConnectionsFor(options);
  const bearer = crypto.randomUUID();
  const principal = runPrincipalFor(world);
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
    ...(options.localDiskRoot === undefined ? {} : { localDiskRoot: options.localDiskRoot }),
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

export async function run(options: StartOptions) {
  const { world, runs, response } = await start(options);
  expect(response.status, await response.clone().text()).toBe(202);
  const { run: started } = (await response.json()) as { run: { id: string; sessionId: string } };
  return { world, runs, started };
}

export async function expectRefused(options: StartOptions, code: string) {
  const { world, store, response } = await start(options);
  expect(response.status, await response.clone().text()).toBe(422);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe(code);
  expect((await store.listRuns(world.workspaceId, { limit: 10 })).items).toHaveLength(0);
}
export const fixture = {
  get root() {
    return root;
  },
  set root(value: typeof root) {
    root = value;
  },
};
