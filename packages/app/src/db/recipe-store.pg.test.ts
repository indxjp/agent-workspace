/**
 * `recipeStoreOf` against a real PostgreSQL (issue #1513): the lease, the dedupe key, the cascade,
 * the continuation check and public codes, on an `app_t<random>` schema migrated from the
 * generated SQL. The recipe runner's own tests run over the in-memory twin; this holds the SQL to
 * the same rules.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestAppSchema, type TestAppSchema } from '../testing/pg-test-schema.js';
import { memoryRecipeStore } from '../testing/memory-recipe-store.js';
import type { RecipeStore } from './recipe-port.js';
import { recipeStoreOf } from './recipe-store.js';
import { recipeTables } from './recipe-tables.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const url = rawUrl === undefined || rawUrl.trim() === '' ? undefined : rawUrl;

if (url === undefined) {
  console.warn(
    '[db/recipe-store.pg.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so recipeStoreOf was ' +
      'NOT exercised against a real PostgreSQL. A green result without it says nothing about it.',
  );
}

const T0 = new Date('2026-11-01T00:00:00.000Z');
const later = (ms: number): Date => new Date(T0.getTime() + ms);

/** The cases both stores pass: the in-memory twin always, PostgreSQL when it is there. */
function describeRecipeStore(name: string, make: () => RecipeStore): void {
  describe(name, () => {
    const newRun = (store: RecipeStore, workspaceId = crypto.randomUUID(), dedupeKey = 'k') =>
      store.insertOrGetRun({
        workspaceId,
        recipe: 'triage-incident',
        input: { title: 'db down' },
        dedupeKey,
        startedBy: null,
        at: T0,
      });

    it('returns the existing run for a dedupe key already taken', async () => {
      const store = make();
      const workspaceId = crypto.randomUUID();
      const first = await newRun(store, workspaceId);
      const second = await newRun(store, workspaceId);
      expect(first.created).toBe(true);
      expect(second).toEqual({ run: first.run, created: false });
      expect((await newRun(store, crypto.randomUUID())).created).toBe(true);
      expect(first.run).toMatchObject({ status: 'running', input: { title: 'db down' } });
    });

    it('lets one of two claimers take the lease, and an expired lease be reclaimed', async () => {
      const store = make();
      const { run } = await newRun(store);
      const claims = await Promise.all([
        store.claimLease(run.workspaceId, run.id, 'a', T0, later(60_000)),
        store.claimLease(run.workspaceId, run.id, 'b', T0, later(60_000)),
      ]);
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      expect(
        await store.claimLease(run.workspaceId, run.id, 'c', later(30_000), later(90_000)),
      ).toBeNull();
      const reclaimed = await store.claimLease(
        run.workspaceId,
        run.id,
        'c',
        later(60_001),
        later(120_000),
      );
      expect(reclaimed?.leaseOwner).toBe('c');
      expect(await store.renewLease(run.id, 'a', later(200_000))).toBe(false);
      expect(await store.renewLease(run.id, 'c', later(200_000))).toBe(true);
      expect(await store.listResumable(run.workspaceId, later(100_000), 10)).toEqual([]);
      await store.releaseLease(run.id, 'c');
      expect(
        (await store.listResumable(run.workspaceId, later(100_000), 10)).map((row) => row.id),
      ).toEqual([run.id]);
      await store.setRunStatus(run.id, 'waiting', null, later(1));
      expect(await store.claimLease(run.workspaceId, run.id, 'd', later(1), later(2))).toBeNull();
      expect((await store.listWaiting(run.workspaceId, 10)).map((row) => row.id)).toEqual([run.id]);
    });

    it('records a step through its run, a decision and its outcome', async () => {
      const store = make();
      const { run } = await newRun(store);
      const step = await store.upsertStepRunning(run.id, 'escalate', T0);
      expect(step).toMatchObject({ status: 'running', runId: null, decision: null });
      expect(await store.upsertStepRunning(run.id, 'escalate', later(5))).toEqual(step);
      const platformRun = crypto.randomUUID();
      await store.recordStepRun(run.id, 'escalate', platformRun);
      await store.suspendStep(run.id, 'escalate');
      const continuation = crypto.randomUUID();
      await store.recordDecision(run.id, 'escalate', 'approve', continuation);
      expect(await store.findRunsByPlatformRun(run.workspaceId, continuation)).toEqual([run.id]);
      expect(await store.findRunsByPlatformRun(run.workspaceId, platformRun)).toEqual([run.id]);
      expect(await store.findRunsByPlatformRun(crypto.randomUUID(), platformRun)).toEqual([]);
      await store.completeStep(run.id, 'escalate', { paged: true }, later(10));
      expect(await store.getStep(run.id, 'escalate')).toMatchObject({
        status: 'completed',
        runId: platformRun,
        continuationRunId: continuation,
        decision: 'approve',
        output: { paged: true },
      });
    });

    it('stores a failed step as its public code only, and refuses any other text', async () => {
      const store = make();
      const { run } = await newRun(store);
      await store.upsertStepRunning(run.id, 'triage', T0);
      await expect(
        store.failStep(run.id, 'triage', 'upstream said: quota exceeded', later(1)),
      ).rejects.toThrow(RangeError);
      await expect(
        store.setRunStatus(run.id, 'failed', 'ERROR: relation "x"', later(1)),
      ).rejects.toThrow(RangeError);
      await store.failStep(run.id, 'triage', 'model_unavailable', later(1));
      await store.setRunStatus(run.id, 'failed', 'model_unavailable', later(1));
      expect((await store.getStep(run.id, 'triage'))?.error).toBe('model_unavailable');
      expect((await store.getRun(run.workspaceId, run.id))?.error).toBe('model_unavailable');
    });

    it('pages the runs of a workspace newest first', async () => {
      const store = make();
      const workspaceId = crypto.randomUUID();
      for (const key of ['a', 'b', 'c']) await newRun(store, workspaceId, key);
      const first = await store.listRuns(workspaceId, { limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await store.listRuns(workspaceId, {
        limit: 2,
        cursor: first.nextCursor ?? '',
      });
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const ids = [...first.items, ...second.items].map((run) => run.dedupeKey).sort();
      expect(ids).toEqual(['a', 'b', 'c']);
      await expect(
        store.listRuns(crypto.randomUUID(), { cursor: first.nextCursor ?? '' }),
      ).rejects.toMatchObject({
        code: 'invalid_cursor',
      });
    });

    it('filters the runs by recipe and status, and binds a cursor to its filters', async () => {
      const store = make();
      const workspaceId = crypto.randomUUID();
      for (const key of ['a', 'b', 'c']) await newRun(store, workspaceId, key);
      const other = await store.insertOrGetRun({
        workspaceId,
        recipe: 'sla-sweep',
        input: {},
        dedupeKey: 'd',
        startedBy: null,
        at: T0,
      });
      await store.setRunStatus(other.run.id, 'completed', null, later(1));
      const sweeps = await store.listRuns(workspaceId, { recipe: 'sla-sweep' });
      expect(sweeps.items.map((run) => run.dedupeKey)).toEqual(['d']);
      const running = await store.listRuns(workspaceId, { status: 'running', limit: 2 });
      expect(running.items.every((run) => run.recipe === 'triage-incident')).toBe(true);
      const rest = await store.listRuns(workspaceId, {
        status: 'running',
        limit: 2,
        cursor: running.nextCursor ?? '',
      });
      expect(rest.items).toHaveLength(1);
      await expect(
        store.listRuns(workspaceId, { status: 'completed', cursor: running.nextCursor ?? '' }),
      ).rejects.toMatchObject({ code: 'invalid_cursor' });
      expect(
        (await store.listRuns(workspaceId, { recipe: 'sla-sweep', status: 'running' })).items,
      ).toEqual([]);
    });
  });
}

describeRecipeStore('memoryRecipeStore', () => memoryRecipeStore());

describe.skipIf(url === undefined)('recipeStoreOf against real PostgreSQL', () => {
  let schema: TestAppSchema | undefined;
  const ready = (): TestAppSchema => {
    if (schema === undefined) throw new Error('the test schema was not created');
    return schema;
  };

  beforeAll(async () => {
    schema = await createTestAppSchema(url ?? '', []);
  });

  afterAll(async () => {
    await schema?.drop();
  });

  describeRecipeStore('recipeStoreOf', () =>
    recipeStoreOf({ db: ready().db, appName: ready().appName }),
  );

  it('cascades a deleted recipe run to its steps', async () => {
    const { db, appName } = ready();
    const store = recipeStoreOf({ db, appName });
    const { run } = await store.insertOrGetRun({
      workspaceId: crypto.randomUUID(),
      recipe: 'r',
      input: null,
      dedupeKey: 'cascade',
      startedBy: null,
      at: T0,
    });
    await store.upsertStepRunning(run.id, 'one', T0);
    const { recipeRuns } = recipeTables(appName);
    await db.delete(recipeRuns).where(sql`${recipeRuns.id} = ${run.id}::uuid`);
    expect(await store.listSteps(run.id)).toEqual([]);
  });

  it('refuses a continuation without a decision, or on a step without a run', async () => {
    const { db, appName } = ready();
    const store = recipeStoreOf({ db, appName });
    const { run } = await store.insertOrGetRun({
      workspaceId: crypto.randomUUID(),
      recipe: 'r',
      input: null,
      dedupeKey: 'check',
      startedBy: null,
      at: T0,
    });
    await store.upsertStepRunning(run.id, 'one', T0);
    await expect(
      store.recordDecision(run.id, 'one', 'approve', crypto.randomUUID()),
    ).rejects.toThrow();
    const { recipeSteps } = recipeTables(appName);
    await expect(
      db.execute(
        sql`UPDATE ${recipeSteps} SET "continuation_run_id" = ${crypto.randomUUID()}, "run_id" = ${crypto.randomUUID()} WHERE "recipe_run_id" = ${run.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(
        sql`UPDATE ${recipeSteps} SET "error" = ${'SELECT 1; drop table x'} WHERE "recipe_run_id" = ${run.id}::uuid`,
      ),
    ).rejects.toThrow();
    expect((await store.getStep(run.id, 'one'))?.continuationRunId).toBeNull();
  });

  it('refuses a step whose workspace is not its recipe run’s', async () => {
    const { db, appName } = ready();
    const store = recipeStoreOf({ db, appName });
    const { run } = await store.insertOrGetRun({
      workspaceId: crypto.randomUUID(),
      recipe: 'r',
      input: null,
      dedupeKey: 'tenant',
      startedBy: null,
      at: T0,
    });
    const { recipeSteps } = recipeTables(appName);
    await expect(
      db.insert(recipeSteps).values({
        workspace_id: crypto.randomUUID(),
        recipe_run_id: run.id,
        key: 'x',
        status: 'running',
      }),
    ).rejects.toThrow();
  });
});
