/**
 * Test support: what a started run receives, observed at the runner's door (the storage design,
 * §04 "How a run gets its files"). The real `POST /api/agents/:id/runs` handler, launcher, input
 * archive and resource loader run; the runner is a double that records the `/files` archive and the
 * `/run` body. Compose is reduced to the field these tests read, `resources.files`, built by
 * `run-request.ts`'s own functions. No route imports it, and it imports no test-only module: each
 * test file builds its {@link RunWorld} on both catalogs.
 */
import { streamToBytes } from '@agent-workspace/core/storage';
import { decodeUstar } from '@agent-workspace/runtime/transfer';

import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { installTestDomains, installTestRunApi } from '../application-context-fixtures';
import {
  createAgentRunResourceLoader,
  type RunStorageConnections,
} from '../compose/resource-loader';
import type { RunPreflight } from '../compose/run-preflight';
import { attachedRunFiles, narrowedToFileScope } from '../compose/run-request';
import type { RuntimeLaunchTarget } from '../compose/runtime-profile';
import type { StorageWriteBackRun } from '../compose/storage-writeback';
import { createRuntimeWorkspaceLifecycle } from '../compose/workspace-lifecycle';
import { createInMemoryModelsStoreProvider } from '../models/memory-store';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';
import { createInMemoryRuntimeProfileStoreProvider } from '../runtimes/memory-store';
import type { StorageService } from '../storage/service';
import type { LaunchContext, RunApiEnvironment, RunPrincipal } from './environment';
import { createRunnerLauncher } from './launcher';
import type { RunStore } from './store';

/** One workspace with an owner who saves files; the catalog is in memory or on PostgreSQL. */
export interface RunWorld {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
}

/** What the runner double received for one run. */
interface Delivered {
  /** The `/run` body's `resources.files`: the references the runner checks. */
  readonly files: readonly unknown[];
  /** The `/files` archive's members, read whole: these archives are a few bytes. */
  readonly archive: ReturnType<typeof decodeUstar>;
}

const TARGET = {
  driver: 'docker',
  runnerUrl: 'http://runner.test',
  workspaceRoot: '/workspace',
  fileTransfer: 'push-archive',
} as RuntimeLaunchTarget;

const MODEL = 'claude-sonnet-4-5';

/**
 * An agent of `workspaceId` the rest of the run-start preflight accepts: a docker runtime profile
 * and a model its connection offers. The stores are in memory; discovery answers without a network.
 */
export async function runnableAgent(workspaceId: string, principal: RunPrincipal) {
  const models = createInMemoryModelsStoreProvider([workspaceId]);
  const connection = await models.forWorkspace(workspaceId).create({
    name: 'anthropic default',
    provider: 'anthropic',
    apiKey: 'sk-test',
    config: {},
  });
  if (connection.kind !== 'created') throw new Error('fixture connection');
  const profiles = createInMemoryRuntimeProfileStoreProvider();
  const profile = await profiles.forWorkspace(workspaceId).create({
    name: 'docker default',
    driver: 'docker',
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
  });
  if (profile.kind !== 'created') throw new Error('fixture profile');
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(workspaceId).create(
    {
      name: 'General',
      instructions: '',
      modelConnectionId: connection.connection.id,
      model: MODEL,
      runtimeProfileId: profile.profile.id,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    },
    { principalId: principal.principalId, userId: principal.userId },
  );
  if (created.kind !== 'created') throw new Error('fixture agent');
  const discover = () =>
    Promise.resolve({
      ok: true as const,
      stale: false,
      models: [
        {
          connectionId: connection.connection.id,
          providerModelId: MODEL,
          displayName: 'Claude Sonnet 4.5',
          capabilities: {
            streaming: true,
            toolUse: true,
            thinking: true,
            promptCaching: false,
            structuredOutput: true,
            contextManagement: true,
            webSearch: true,
            tokenCounting: false,
          },
        },
      ],
    });
  return { agents, profiles, models, discover, agent: created.agent };
}

/** The run API's preflight as `runs.start` calls it, answered by `preflight` for an unpinned run. */
export function startPreflight(
  preflight: RunPreflight,
): NonNullable<RunApiEnvironment['preflight']> {
  return (principal, ref, sessionId, modelOverride, _version, attachmentCount, _audio, files) =>
    preflight.check({
      workspaceId: principal.workspaceId,
      agentId: ref.id,
      sessionId,
      modelOverride,
      ...(attachmentCount === undefined ? {} : { attachmentCount }),
      files: { agentVersionId: null, attachments: files?.attachments ?? [] },
    });
}

/**
 * Serve the run API for `world`: `authenticate` names the caller, the agent is granted `grants`,
 * and a new run opens `sessionId` (a fresh id when absent). Also wires the agents domain. The suite
 * passes the run store, so only a `*.test.ts` file constructs an in-memory one.
 */
export function installDeliveringRunApi(options: {
  readonly world: RunWorld;
  readonly storage: StorageService;
  readonly store: RunStore;
  readonly authenticate: (request: Request) => Promise<RunPrincipal | null>;
  readonly grants?: readonly { readonly fileId: string; readonly access: 'read' }[];
  readonly sessionId?: string;
  /** Connection folders the agent is granted, read through `storageConnections`. */
  readonly storageGrants?: readonly {
    readonly connectionId: string;
    readonly prefix: string;
    readonly access: 'read' | 'read-write';
  }[];
  readonly storageConnections?: RunStorageConnections;
  /** The agent's id; a fresh one when absent. */
  readonly agentId?: string;
  /** The run-start preflight; absent, every run is queued. */
  readonly preflight?: RunApiEnvironment['preflight'];
  /**
   * The run may write files. The `/run` body then names its `cwd`, and the runner double answers
   * `GET /files?path=` from `runnerFiles` (a tar), or the runner's `404 file_not_found` when that returns `null`.
   */
  readonly runnerFiles?: (path: string) => Uint8Array | null;
  /**
   * Saves the completed run's read-write storage folders, as the composition root wires it: with
   * the folders compose delivered writable.
   */
  readonly storageWriteback?: (run: StorageWriteBackRun) => Promise<unknown>;
  /** Called when the runner double answers `/run`, before the run's stream is relayed. */
  readonly onRun?: () => Promise<void>;
}): { readonly agentId: string; delivered(runId: string): Promise<Delivered> } {
  const { world, storage, store } = options;
  const agentId = options.agentId ?? crypto.randomUUID();
  const loader = createAgentRunResourceLoader({
    catalog: world.catalogs,
    storage,
    ...(options.storageConnections === undefined
      ? {}
      : { storageConnections: options.storageConnections }),
  });
  // The agent may write files, so a read-write storage grant is delivered writable.
  const granted = (context: LaunchContext) =>
    loader.load(
      context.principal.workspaceId,
      {
        files: options.grants ?? [],
        skillIds: [],
        connectorIds: [],
        storageGrants: options.storageGrants ?? [],
      },
      null,
      { readFiles: true, writeFiles: true, runCommands: false, unrestrictedNetwork: false },
    );
  const received = new Map<string, Delivered>();
  const { storageWriteback } = options;
  const deliveredFolders = new WeakMap<LaunchContext, StorageWriteBackRun['folders']>();
  // A launch is over only once it has settled, after its write-back and its terminal status.
  const settled = new Set<string>();
  // The `/files` archive comes just before its `/run` body, which names the run; one run at a time.
  let archive: Delivered['archive'] = [];
  const runner = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    const pathname = new URL(request.url).pathname;
    if (pathname === '/files' && request.method === 'GET') {
      const tar =
        options.runnerFiles?.(new URL(request.url).searchParams.get('path') ?? '') ?? null;
      return tar === null
        ? new Response('{"error":"file_not_found"}', {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(tar.slice(), { headers: { 'Content-Type': 'application/x-tar' } });
    }
    if (pathname === '/files') {
      archive = decodeUstar(await streamToBytes(request.body ?? new Blob().stream()));
      return new Response(null, { status: 204 });
    }
    if (pathname === '/run') {
      const body = (await request.json()) as {
        runId: string;
        resources: { files: readonly unknown[] };
      };
      received.set(body.runId, { files: body.resources.files, archive });
      archive = [];
      await options.onRun?.();
      return new Response('event: run-done\ndata: {}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return new Response(null, { status: 404 });
  };
  // The owner made the agent and every member is granted it, so any role may run it (§21).
  const agent = { id: agentId, ownerPrincipalId: world.principalId };
  installTestDomains({
    agents: {
      agents: {
        forWorkspace: () => ({
          get: (id: string) => Promise.resolve(id === agentId ? agent : null),
        }),
      } as never,
      agentGrants: { forWorkspace: () => ({ hasGrant: () => Promise.resolve(true) }) } as never,
      resolveWorkspace: () =>
        Promise.resolve({ kind: 'workspace', workspaceId: world.workspaceId }),
    },
  });
  installTestRunApi({
    authenticate: options.authenticate,
    findAgent: (principal, id) =>
      Promise.resolve(
        id === agentId
          ? { id, workspaceId: principal.workspaceId, engine: 'claude-agent-sdk' }
          : null,
      ),
    openSession: (_principal, agent) =>
      Promise.resolve({
        id: options.sessionId ?? crypto.randomUUID(),
        agentId: agent.id,
        engine: null,
      }),
    ownsRun: () => Promise.resolve(true),
    store,
    ...(options.preflight === undefined ? {} : { preflight: options.preflight }),
    launch: createRunnerLauncher({
      store,
      runtime: { resolve: () => Promise.resolve(TARGET) },
      workspaceLifecycle: createRuntimeWorkspaceLifecycle({
        storage,
        resources: loader,
        granted,
      }),
      // `resources.files` as `run-request.ts` composes it: the grants within `fileScope`, then the
      // attachments, checked against the run limit.
      buildRunRequest: async (context) => {
        const selection = await granted(context);
        if (selection.storageFolders !== undefined) {
          deliveredFolders.set(context, selection.storageFolders);
        }
        return {
          runId: context.run.id,
          ...(options.runnerFiles === undefined
            ? {}
            : {
                cwd: `${TARGET.workspaceRoot}/${context.principal.workspaceId}/${context.session.id}`,
                portable: { permissions: { writeFiles: true } },
              }),
          resources: {
            files: await attachedRunFiles(
              context,
              narrowedToFileScope(selection, context.fileScope),
              loader,
            ),
          },
        };
      },
      fetch: runner,
      ...(storageWriteback === undefined
        ? {}
        : {
            storageWriteback: (run) =>
              storageWriteback({ ...run, folders: deliveredFolders.get(run.context) ?? new Map() }),
          }),
      onLaunchSettled: (context) => settled.add(context.run.id),
    }),
  });

  return {
    agentId,
    async delivered(runId) {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const run = await store.get(runId);
        if (run?.endedAt != null && settled.has(runId)) {
          if (run.status !== 'completed') {
            throw new Error(`the run ended ${run.status}: ${JSON.stringify(run.error)}`);
          }
          return received.get(runId) ?? { files: [], archive: [] };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('the run never reached a terminal status');
    },
  };
}
