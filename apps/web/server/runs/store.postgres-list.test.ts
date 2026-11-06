/**
 * `listRuns` over a real PostgreSQL (issue #135): attribution through the session join, tenant
 * scoping, filter composition and cursor pagination that stays stable against concurrent inserts.
 */
import { describe, expect, it } from 'vitest';

import type { RunListCursor, RunListPage, RunRecord, RunStore } from './store';
import { seedListWorld, type ListWorld } from './store.postgres-list-world.test-support';
import {
  databaseConfigured,
  useRunDatabase,
  type RunDatabase,
} from './store.postgres.test-support';
import { walkPages } from './store.test-support';

const hasDatabase = databaseConfigured(process.env);

type Provider = 'openai' | 'anthropic';

const startRun = (
  store: RunStore,
  workspaceId: string,
  agentId: string,
  sessionId: string,
): Promise<RunRecord> =>
  store.create({
    engine: 'claude-agent-sdk',
    id: crypto.randomUUID(),
    workspaceId,
    agentId,
    sessionId,
  });

/** Start a run in a fresh owner session in Acme. */
async function startAcmeRun(
  store: RunStore,
  world: ListWorld,
  sessionId?: string,
): Promise<RunRecord> {
  return startRun(store, world.acmeId, world.agentId, sessionId ?? (await world.ownerSession()));
}

const snapshot = (
  store: RunStore,
  world: ListWorld,
  runId: string,
  model: string,
  provider: Provider,
): Promise<void> =>
  store.snapshotModel(runId, { connectionId: world.modelConnectionId, model, provider });

/** Agent, project and initiating user are reached through the session join. */
async function checkAttribution(store: RunStore, world: ListWorld): Promise<RunListPage> {
  const attributed = await startAcmeRun(store, world);
  const page = await store.listRuns(world.acmeId, { limit: 200 });
  expect(page.items.find((run) => run.id === attributed.id)).toMatchObject({
    agentId: world.agentId,
    projectId: world.projectId,
    initiatingUserId: world.ownerId,
  });
  return page;
}

/**
 * Bravo's run never appears in Acme's list, and Acme's own scoped repository answers the same
 * `null` for Bravo's real id as it does for one nobody used.
 *
 * The *repository* directly, scope-bound to Acme — unlike `RunStore.get()`, which this file's own
 * header documents as identifying a run by id alone across every workspace
 * (`apps/web/server/runs/api.ts`'s `findRunForPrincipal` is the caller that enforces the tenant
 * check on that port). `RunRepository.get()` is scope-bound by construction, so it is the right
 * layer to prove issue #135's "a cross-workspace run id answers like a nonexistent one" directly,
 * against the same join `listRuns` uses.
 */
async function checkTenantIsolation(
  database: RunDatabase,
  world: ListWorld,
  acmePage: RunListPage,
  bravoRunId: string,
): Promise<void> {
  const { db, core } = database;
  const acmeScope = await core
    .createDatabaseWorkspaceScopeResolver(db)
    .forWorkspaceId(world.acmeId);
  if (acmeScope === null) throw new Error('the Acme workspace did not resolve');
  const acmeRepo = core.createDatabaseRunRepositoryProvider(db).forScope(acmeScope);

  expect(acmePage.items.some((run) => run.id === bravoRunId)).toBe(false);
  expect(await acmeRepo.get(bravoRunId)).toBeNull();
  expect(await acmeRepo.get(crypto.randomUUID())).toBeNull();
}

/** Filters compose as an intersection, not a union: three near-misses, one real match. */
async function checkFiltersCompose(store: RunStore, world: ListWorld): Promise<void> {
  const matches = await startAcmeRun(store, world);
  const wrongStatus = await startAcmeRun(store, world);
  const wrongProject = await startAcmeRun(store, world, world.builderSessionId);
  const wrongProvider = await startAcmeRun(store, world);
  for (const run of [matches, wrongProject, wrongProvider]) {
    const provider = run.id === wrongProvider.id ? 'anthropic' : 'openai';
    await snapshot(store, world, run.id, 'gpt-5.1', provider);
    await store.finish(run.id, 'failed', 'boom');
  }
  // wrongStatus keeps the same provider/project but is never finished (`queued`).
  await snapshot(store, world, wrongStatus.id, 'gpt-5.1', 'openai');

  const composed = await store.listRuns(world.acmeId, {
    limit: 200,
    filter: { status: 'failed', projectId: world.projectId, provider: 'openai' },
  });
  const composedIds = composed.items.map((run) => run.id);
  expect(composedIds).toContain(matches.id);
  expect(composedIds).not.toContain(wrongStatus.id);
  expect(composedIds).not.toContain(wrongProject.id);
  expect(composedIds).not.toContain(wrongProvider.id);
}

/**
 * Cursor pagination: five fresh runs, walked two at a time, with three MORE runs created between
 * page one and page two. None of the five is seen twice, none is skipped, and none of the three
 * concurrently-inserted runs — newer than every cursor already issued — leaks into a page it was
 * never on.
 */
async function checkStablePagination(store: RunStore, world: ListWorld): Promise<void> {
  const marker = crypto.randomUUID();
  const seedMarked = async (): Promise<string> => {
    const run = await startAcmeRun(store, world);
    await snapshot(store, world, run.id, marker, 'openai');
    return run.id;
  };
  const seeded: string[] = [];
  for (let i = 0; i < 5; i += 1) seeded.push(await seedMarked());
  const collected = await walkPages<RunListCursor>(
    2,
    async (cursor) => {
      const page = await store.listRuns(world.acmeId, {
        limit: 2,
        filter: { model: marker },
        cursor,
      });
      return { ids: page.items.map((run) => run.id), nextCursor: page.nextCursor };
    },
    async (pageIndex) => {
      if (pageIndex !== 0) return;
      for (let i = 0; i < 3; i += 1) await seedMarked();
    },
  );
  expect(new Set(collected).size).toBe(collected.length);
  expect(collected.sort()).toEqual([...seeded].sort());
}

describe.skipIf(!hasDatabase)('the PostgreSQL run store', () => {
  const database = useRunDatabase();

  describe('listRuns (issue #135)', () => {
    it('carries attribution through the session join, stays tenant-scoped, composes filters, and paginates stably against concurrent inserts', async () => {
      const world = await seedListWorld(database);
      const store = database.makeStore();

      // A run in the OTHER workspace, whose id every assertion below must never see.
      const bravoRun = await startRun(
        store,
        world.bravoId,
        world.bravoAgentId,
        world.bravoSessionId,
      );
      const acmePage = await checkAttribution(store, world);
      await checkTenantIsolation(database, world, acmePage, bravoRun.id);
      await checkFiltersCompose(store, world);
      await checkStablePagination(store, world);
    });
  });
});
