/**
 * Keyset pagination over a real PostgreSQL (issue #135, round 2 finding 1), and the session and
 * approval cases that ride on the same `seedWorkspace` fixture.
 */
import { describe, expect, it } from 'vitest';

import { SessionBusyError, type RunListCursor, type RunRecord } from './store';
import {
  databaseConfigured,
  useRunDatabase,
  type RunDatabase,
} from './store.postgres.test-support';
import { listOverHttp, walkPages } from './store.test-support';

const hasDatabase = databaseConfigured(process.env);

const newIds = (count: number): string[] =>
  Array.from({ length: count }, () => crypto.randomUUID());

/** Insert `ids` as runs of one session with identical `created_at` (one multi-row INSERT). */
async function insertRunsSharingOneInstant(
  database: RunDatabase,
  target: { workspaceId: string; sessionId: string },
  ids: readonly string[],
  model: string,
): Promise<void> {
  const { workspaceId, sessionId } = target;
  await database.db
    .insert(database.core.runs)
    .values(ids.map((id) => ({ id, workspaceId, sessionId, model })));
}

/**
 * Walk `workspaceId`'s runs of `model` over HTTP at `limit=2`, after inserting three runs and
 * deleting `deleted` between page one and page two.
 */
async function walkOverHttpWhileWriting(
  database: RunDatabase,
  target: { workspaceId: string; sessionId: string },
  model: string,
  deleted: string,
): Promise<{ collected: string[]; inserted: string[] }> {
  const { workspaceId, sessionId } = target;
  const inserted: string[] = [];
  const collected = await walkPages<string>(
    2,
    (cursor) => listOverHttp(`limit=2&model=${model}`, cursor),
    async (pageIndex) => {
      if (pageIndex !== 0) return;
      for (let i = 0; i < 3; i += 1) {
        const id = crypto.randomUUID();
        await database.db.insert(database.core.runs).values({ id, workspaceId, sessionId, model });
        inserted.push(id);
      }
      await database.db.execute(`delete from runs where id = '${deleted}'`);
    },
  );
  return { collected, inserted };
}

function describeSharedInstant(database: RunDatabase): void {
  describe('listRuns (issue #135)', () => {
    /**
     * Round 2 finding 1: a keyset cursor boundary held as a JS `Date` truncates
     * `runs.created_at`'s microsecond precision to milliseconds, so the predicate compares a
     * rounded boundary against full-precision rows and silently drops every row that shares the
     * boundary's millisecond without sharing its microseconds — including two rows that are the
     * *same* instant, which any multi-row `INSERT` produces (`now()` is fixed for one statement).
     * `RunRepository.listRuns` now mints and reads the boundary as the database's own text, never
     * a `Date` — reverting that (restoring `cursor.createdAt`/`last.createdAt` as `Date`, and the
     * plain `lt`/`eq` comparison against it) makes this test fail with fewer than 6 ids collected.
     */
    it('keyset pagination does not skip runs sharing one created_at instant (round 2 finding 1: same-statement insert)', async () => {
      const { workspaceId, sessionId } = await database.seedWorkspace();
      const store = database.makeStore();

      const marker = crypto.randomUUID();
      const ids = newIds(6);
      // One multi-row INSERT: PostgreSQL's `now()` is fixed for the whole statement, so every row
      // gets the identical `created_at`, to the microsecond.
      await insertRunsSharingOneInstant(database, { workspaceId, sessionId }, ids, marker);
      const inserted = await database.db.query.runs.findMany({
        where: (row, { eq }) => eq(row.model, marker),
      });
      expect(new Set(inserted.map((row) => row.createdAt.getTime())).size).toBe(1);

      const listRuns = store.listRuns.bind(store);
      const collected = await walkPages<RunListCursor>(2, async (cursor) => {
        const page = await listRuns(workspaceId, { limit: 2, filter: { model: marker }, cursor });
        return { ids: page.items.map((run) => run.id), nextCursor: page.nextCursor };
      });
      expect(new Set(collected).size).toBe(collected.length);
      expect(collected.sort()).toEqual([...ids].sort());
    });

    /**
     * The same defect (round 2 finding 1), reached through the application's own concurrency
     * path rather than a hand-built multi-row `INSERT`: 40 separate `RunRepository.create()`
     * calls, each its own transaction, routinely collide two or more runs onto the same
     * millisecond — the verifier's evidence lost 14 of 40 runs at `limit=1` before this fix.
     */
    it('keyset pagination does not skip runs created by concurrent RunRepository.create() calls (round 2 finding 1: Promise.all)', async () => {
      const { workspaceId, userId, principalId, agentId } = await database.seedWorkspace();
      const store = database.makeStore();

      // One session per run: a session takes one run at a time.
      const ids = newIds(40);
      await database.db
        .insert(database.core.sessions)
        .values(
          ids.map((id) => ({ id, workspaceId, userId, agentId, ownerPrincipalId: principalId })),
        );
      await Promise.all(
        ids.map((id) =>
          store.create({ engine: 'claude-agent-sdk', id, workspaceId, agentId, sessionId: id }),
        ),
      );

      const listRuns = store.listRuns.bind(store);
      const collected = await walkPages<RunListCursor>(1, async (cursor) => {
        const page = await listRuns(workspaceId, { limit: 1, cursor });
        return { ids: page.items.map((run) => run.id), nextCursor: page.nextCursor };
      });
      expect(new Set(collected).size).toBe(collected.length);
      expect(collected.sort()).toEqual([...ids].sort());
    });
  });
}

function describeSessionsAndCursor(database: RunDatabase): void {
  describe('listRuns (issue #135)', () => {
    it('refuses a second open run on one session, and admits one once the first has ended', async () => {
      const { workspaceId, agentId, sessionId } = await database.seedWorkspace();
      const store = database.makeStore();
      const start = (id: string): Promise<RunRecord> =>
        store.create({ engine: 'claude-agent-sdk', id, workspaceId, agentId, sessionId });
      const first = await start(crypto.randomUUID());
      await expect(start(crypto.randomUUID())).rejects.toBeInstanceOf(SessionBusyError);
      await store.finish(first.id, 'completed', null);
      await expect(start(crypto.randomUUID())).resolves.toMatchObject({ status: 'queued' });
    });

    it('serves a run core holds at awaiting_approval, with the call it waits on', async () => {
      const { workspaceId, agentId, sessionId } = await database.seedWorkspace();
      const store = database.makeStore();
      const run = await store.create({
        engine: 'claude-agent-sdk',
        id: crypto.randomUUID(),
        workspaceId,
        agentId,
        sessionId,
      });
      await store.markRunning(run.id);
      const { core, db } = database;
      const scope = await core.createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
      if (scope === null) throw new Error('fixture workspace did not resolve');
      const paused = await core
        .createDatabaseRunRepositoryProvider(db)
        .forScope(scope)
        .awaitApproval(run.id, { toolName: 'send_email', canonicalCall: '{}' });
      expect(paused.kind).toBe('moved');

      await expect(store.get(run.id)).resolves.toMatchObject({
        status: 'awaiting_approval',
        pendingApproval: { toolName: 'send_email', canonicalCall: '{}' },
      });
    });

    /**
     * The same defect again, this time through the HTTP route's base64url-encoded cursor
     * (`list-query.ts`'s `encodeRunListCursor`/`decodeRunListCursor`) rather than the repository's cursor
     * object directly — round 2 finding 1 named `api.ts:334`'s `toISOString()` as an independent
     * place the same truncation happened, on every cursor this route ever handed a client.
     */
    it('GET /api/runs does not skip runs sharing one created_at instant, through the encoded HTTP cursor (round 2 finding 1)', async () => {
      const { workspaceId, userId, sessionId } = await database.seedWorkspace();
      const marker = crypto.randomUUID();
      const ids = newIds(6);
      await insertRunsSharingOneInstant(database, { workspaceId, sessionId }, ids, marker);

      await database.asOwnerOf(workspaceId, userId, database.makeStore(), async () => {
        const collected = await walkPages<string>(2, (cursor) =>
          listOverHttp(`limit=2&model=${marker}`, cursor),
        );
        expect(new Set(collected).size).toBe(collected.length);
        expect(collected.sort()).toEqual([...ids].sort());
      });
    });
  });
}

function describeConcurrentWrites(database: RunDatabase): void {
  describe('listRuns (issue #135)', () => {
    /**
     * The task card's verifier attack 2, verbatim: "page with `limit=2`, and between page one and
     * page two insert three new runs and delete one from page two. Assert no item is returned
     * twice and no pre-existing item is skipped." The delete is a raw `delete from runs` through
     * `db.execute`, the same way the microsecond test below sets `created_at` — neither
     * `RunRepository` nor `RunStore` deletes runs, and the attack needs no API for it. Once with
     * seven distinct instants, once with seven rows sharing one instant (a single multi-row
     * INSERT), so the row deleted is chosen from the `(created_at desc, id desc)` order in both
     * shapes a keyset boundary can take.
     */
    it.each([
      ['distinct created_at instants', false],
      ['one shared created_at instant', true],
    ])(
      'GET /api/runs at limit=2 survives three inserts and one delete between page one and page two (%s)',
      async (_shape, sameInstant) => {
        const { workspaceId, userId, sessionId } = await database.seedWorkspace();
        const marker = crypto.randomUUID();
        const ids = newIds(7);
        const t0 = Date.parse('2026-04-01T00:00:00.000Z');
        await database.db.insert(database.core.runs).values(
          ids.map((id, index) => ({
            id,
            workspaceId,
            sessionId,
            model: marker,
            ...(sameInstant ? {} : { createdAt: new Date(t0 + index * 1_000) }),
          })),
        );
        // The order the list serves: newest first, then id descending. Page one is the first two
        // rows of it; the row deleted mid-walk is the first row page two would have shown.
        const ordered = sameInstant ? [...ids].sort().reverse() : [...ids].reverse();
        const deleted = ordered[2];
        if (deleted === undefined) throw new Error('seven runs have a third');

        await database.asOwnerOf(workspaceId, userId, database.makeStore(), async () => {
          const { collected, inserted } = await walkOverHttpWhileWriting(
            database,
            { workspaceId, sessionId },
            marker,
            deleted,
          );
          expect(collected.slice(0, 2)).toEqual(ordered.slice(0, 2));
          expect(new Set(collected).size).toBe(collected.length);
          expect(collected).not.toContain(deleted);
          for (const id of inserted) expect(collected).not.toContain(id);
          expect([...collected].sort()).toEqual(ids.filter((id) => id !== deleted).sort());
        });
      },
    );
  });
}

describe.skipIf(!hasDatabase)('the PostgreSQL run store', () => {
  const database = useRunDatabase();
  describeSharedInstant(database);
  describeSessionsAndCursor(database);
  describeConcurrentWrites(database);
});
