/**
 * The storage design, §04: "A total over the cap answers 422 run_files_too_large before any sandbox
 * is created." Driven through the real `POST /api/agents/:id/runs` handler with the real preflight,
 * whose files total reads catalog row sizes only, on both catalogs.
 */
// @story US-STO-06
import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { clearApplicationContext } from '../application-context';
import { installTestDomains, installTestRunApi } from '../application-context-fixtures';
import { createAgentRunResourceLoader } from '../compose/resource-loader';
import { createRunPreflight } from '../compose/run-preflight';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../resources/catalog-store';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { startRun } from './api';
import type { AgentRef, RunPrincipal, SessionRef } from './environment';
import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import { runnableAgent, startPreflight } from './run-delivery-fixtures';

const MiB = 1024 * 1024;

interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly principal: RunPrincipal;
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL case is never skipped.
  isolated = await createIsolatedTestDatabase('aw_run_files_start');
}, 180_000);

afterAll(async () => isolated?.close());

afterEach(clearApplicationContext);

function principalOf(workspaceId: string, principalId: string, userId: string): RunPrincipal {
  return {
    principalId,
    ownerPrincipalId: principalId,
    userId,
    workspaceId,
    role: 'owner',
    scope: null,
  };
}

function memoryWorld(): Promise<World> {
  return Promise.resolve({
    catalogs: createInMemoryCatalogStore(),
    principal: principalOf(crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()),
  });
}

async function postgresWorld(): Promise<World> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'start' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  return {
    catalogs: createResourceCatalogStoreProvider({
      repositories: createDatabaseResourceCatalogRepositoryProvider(db),
      scopes: createDatabaseWorkspaceScopeResolver(db),
    }),
    principal: principalOf(workspaceId, principalId, userId),
  };
}

/**
 * A granted folder of eight 15 MiB rows (120 MiB, under the cap) and a 9 MiB file to attach, which
 * takes the run over it. Rows only: no object holds any of these bytes.
 */
async function seedRows(world: World) {
  const catalog = await world.catalogs.forWorkspace(world.principal.workspaceId);
  const row = (path: string, kind: 'file' | 'folder', sizeBytes: number) => ({
    path,
    kind,
    storageKey: kind === 'folder' ? null : path,
    sizeBytes,
    contentType: kind === 'folder' ? null : 'application/octet-stream',
    ownerPrincipalId: world.principal.ownerPrincipalId,
  });
  const folder = await catalog.putFile(row('big', 'folder', 0));
  for (let index = 0; index < 8; index += 1) {
    await catalog.putFile(row(`big/part-${String(index)}.bin`, 'file', 15 * MiB));
  }
  const attachment = await catalog.putFile(row('notes/extra.bin', 'file', 9 * MiB));
  return { folderId: folder.id, attachmentId: attachment.id, total: 129 * MiB };
}

function defineSuite(name: string, setup: () => Promise<World>) {
  describe(`runs.start on the ${name}`, () => {
    it('[US-STO-06][api][run] a run over the files cap answers 422 run_files_too_large before it is queued', async () => {
      const world = await setup();
      const { workspaceId } = world.principal;
      const { folderId, attachmentId, total } = await seedRows(world);
      const { agents, profiles, models, discover, agent } = await runnableAgent(
        workspaceId,
        world.principal,
      );
      // The preflight reads rows only: a byte read or a listing of the store fails the test.
      const storage = {
        open: vi.fn(() => Promise.reject(new Error('the preflight opened bytes'))),
        list: vi.fn(() => Promise.reject(new Error('the preflight listed the store'))),
      };
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
            sizesOnly: true,
          }),
          readRunAgent: () =>
            Promise.resolve({
              agent,
              assignments: {
                files: [{ fileId: folderId, access: 'read' }],
                skillIds: [],
                connectorIds: [],
                storageGrants: [],
              },
              toolBundles: [],
              subagents: [],
            }),
          projectOf: () => Promise.resolve(null),
        },
      });

      installTestDomains({
        agents: {
          agents,
          resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId }),
        },
        files: {
          kind: 'serving',
          runtime: {
            resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId }),
            store: {} as never,
            catalog: world.catalogs,
          },
        },
      });
      const store = new InMemoryRunStore();
      const resolve = vi.fn(() => Promise.reject(new Error('a runtime was resolved')));
      const buildRunRequest = vi.fn(() => Promise.reject(new Error('a run was composed')));
      const openSession = vi.fn((_p: RunPrincipal, ref: AgentRef) =>
        Promise.resolve<SessionRef | null>({
          id: crypto.randomUUID(),
          agentId: ref.id,
          engine: null,
        }),
      );
      installTestRunApi({
        authenticate: () => Promise.resolve(world.principal),
        findAgent: (principal, agentId) =>
          Promise.resolve(
            agentId === agent.id
              ? { id: agent.id, workspaceId: principal.workspaceId, engine: 'claude-agent-sdk' }
              : null,
          ),
        openSession,
        ownsRun: () => Promise.resolve(true),
        store,
        launch: createRunnerLauncher({ store, runtime: { resolve }, buildRunRequest }),
        preflight: startPreflight(preflight),
      });

      const response = await startRun(
        new Request(`http://web/api/agents/${agent.id}/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'summarise', attachments: [{ fileId: attachmentId }] }),
        }),
        agent.id,
      );

      expect(response.status).toBe(422);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('run_files_too_large');
      expect(body.error.message).toContain(String(total));
      expect(body.error.message).toContain(String(RUN_FILES_MAX_BYTES));
      expect((await store.listRuns(workspaceId, { limit: 10 })).items).toHaveLength(0);
      expect(openSession).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(buildRunRequest).not.toHaveBeenCalled();
      expect(storage.open).not.toHaveBeenCalled();
    });
  });
}

defineSuite('in-memory catalog', memoryWorld);
defineSuite('PostgreSQL catalog', postgresWorld);
