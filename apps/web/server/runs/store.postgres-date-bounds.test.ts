/**
 * The derived values the list renders, and the `from`/`to` date bounds, against a real PostgreSQL
 * (issue #135, #134, round 4 findings 1 and 2).
 */
import { describe, expect, it } from 'vitest';

import { listRuns as listRunsOverHttp, readRun as readRunOverHttp } from './api';
import {
  databaseConfigured,
  useRunDatabase,
  type RunChain,
  type RunDatabase,
} from './store.postgres.test-support';
import { setMicrosecondInstants } from './store.postgres-range.test-support';
import { listOverHttp, listOverHttpStatus } from './store.test-support';

const hasDatabase = databaseConfigured(process.env);

type JsonObject = Record<string, unknown>;

/** Insert one completed run whose every counter is non-zero and distinct. */
async function insertDerivedRun(
  database: RunDatabase,
  chain: RunChain,
  id: string,
  model: string,
): Promise<string> {
  const { db, core } = database;
  const modelConnectionId = crypto.randomUUID();
  await db.insert(core.modelConnections).values({
    id: modelConnectionId,
    workspaceId: chain.workspaceId,
    name: 'Derived fixture connection',
    provider: 'openai',
    config: {},
  });
  await db.insert(core.runs).values({
    id,
    workspaceId: chain.workspaceId,
    sessionId: chain.sessionId,
    status: 'completed',
    provider: 'openai',
    model,
    modelConnectionId,
    createdAt: new Date('2026-09-12T05:00:00.000Z'),
    startedAt: new Date('2026-09-12T05:00:01.000Z'),
    endedAt: new Date('2026-09-12T05:00:24.456Z'),
    inputTokens: 10,
    outputTokens: 20,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 4,
    toolCalls: 5,
    costUsd: '0.123456',
    priceTableVersion: 'v1',
    accountingState: 'complete',
  });
  return modelConnectionId;
}

/** The detail body is the list item plus its tree (ADR-0104): one `parent_run_id` read, here empty. */
function expectTreeOverItem(run: JsonObject, listed: JsonObject | undefined): void {
  const { children, treeCost, ...item } = run;
  expect(listed).toEqual(item);
  expect({ children, treeCost }).toEqual({
    children: [],
    treeCost: { amount: (item['cost'] as { amount: string }).amount, currency: 'USD' },
  });
}

function describeDerivedValues(database: RunDatabase): void {
  describe('listRuns (issue #135)', () => {
    /**
     * Issue #135's "duration and total tokens are deterministic derived values" and #134's
     * `accounting_state`, on a row whose every counter is non-zero and distinct, read back
     * through the repository and rendered by the route (round 4 finding 1). The list item is the
     * detail body, byte for byte.
     */
    it('GET /api/runs and GET /api/runs/:id render the same exact derived duration, total tokens and accounting state from real columns', async () => {
      const chain = await database.seedWorkspace();
      const { workspaceId, userId } = chain;
      const id = crypto.randomUUID();
      const model = crypto.randomUUID();
      const modelConnectionId = await insertDerivedRun(database, chain, id, model);

      await database.asOwnerOf(workspaceId, userId, database.makeStore(), async () => {
        const list = await listRunsOverHttp(new Request(`http://web/api/runs?model=${model}`));
        expect(list.status).toBe(200);
        const { runs } = (await list.json()) as { runs: JsonObject[] };
        expect(runs.map((run) => run['id'])).toEqual([id]);
        const detail = await readRunOverHttp(new Request(`http://web/api/runs/${id}`), id);
        expect(detail.status).toBe(200);
        const { run } = (await detail.json()) as { run: JsonObject };
        expectTreeOverItem(run, runs[0]);
        expect(run).toMatchObject({
          id,
          workspaceId,
          initiatingUserId: userId,
          status: 'completed',
          startedAt: '2026-09-12T05:00:01.000Z',
          endedAt: '2026-09-12T05:00:24.456Z',
          durationMs: 23_456,
          provider: 'openai',
          model,
          modelConnectionId,
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 4,
            totalTokens: 37,
            toolCalls: 5,
          },
          cost: { amount: '0.123456', currency: 'USD', priceTableVersion: 'v1' },
          accountingState: 'complete',
          accountingError: null,
        });
      });
    });
  });
}

const REFUSED_BOUNDS = [
  '+275760-09-13T00:00:00.000Z',
  '-271821-04-20T00:00:00.000Z',
  '-000001-01-01T00:00:00.000Z',
  '0000-01-01T00:00:00Z',
  '2026-09-13T00:00:00',
  '1',
  '2026',
  'Sep 12 2026',
  '2026-09-12T00:00:00.0999Z',
  '9999-12-31T23:59:00-00:01',
];

function describeRefusedBounds(database: RunDatabase): void {
  describe('listRuns (issue #135)', () => {
    /**
     * Round 4 finding 2: `from`/`to` were gated by `new Date(text)`, so a value JavaScript reads
     * and PostgreSQL refuses — a signed six-digit year, year 0 — threw out of the query as a
     * `500`, and the round-3 `createdTo + 1 ms` shift, done in JS, pushed the legal
     * `to=9999-12-31T23:59:59.999Z` into year 10000 and the same `500`. The refusals are asserted
     * as the documented `400`, by name, and the year-0001/9999 edges as `200` from the real query
     * — never "anything but 500".
     *
     * The last two probes are the parsing edges `api.test.ts` pins in memory, repeated here
     * because this is where the thrown query would surface. `.0999Z` is a fourth fractional digit
     * that does *not* roll the second, so it is refused by the digit rule of `RUN_LIST_BOUND`
     * alone — unlike `.1234Z`, which the calendar read-back would refuse anyway.
     * `9999-12-31T23:59:00-00:01` lands, after its offset, on exactly `10000-01-01T00:00:00.000Z`:
     * one instant past `LATEST_RUN_LIST_BOUND`, and the value `toISOString` would bind as
     * `+010000-01-01T00:00:00.000Z` if the bound ever moved past it.
     */
    it.each(REFUSED_BOUNDS)(
      'from=%j, and to= the same, is 400 invalid_from / invalid_to, never a thrown query',
      async (value) => {
        const { workspaceId, userId } = await database.seedWorkspace();
        await database.asOwnerOf(workspaceId, userId, database.makeStore(), async () => {
          const encoded = encodeURIComponent(value);
          expect(await listOverHttpStatus(`limit=1&from=${encoded}`)).toEqual({
            status: 400,
            code: 'invalid_from',
          });
          expect(await listOverHttpStatus(`limit=1&to=${encoded}`)).toEqual({
            status: 400,
            code: 'invalid_to',
          });
        });
      },
    );
  });
}

function describeBoundEdges(database: RunDatabase): void {
  describe('listRuns (issue #135)', () => {
    it('from/to at the year-0001 and year-9999 edges reach the real query and answer 200', async () => {
      const { workspaceId, userId, sessionId } = await database.seedWorkspace();
      const model = crypto.randomUUID();
      const lastMs = crypto.randomUUID();
      const firstMs = crypto.randomUUID();
      // A run in the last millisecond PostgreSQL's `toISOString` binding can name, and one in the
      // first: the `to` bound at `.999Z` must include the former even though the millisecond
      // after it is year 10000.
      await database.db.insert(database.core.runs).values([
        { id: lastMs, workspaceId, sessionId, model },
        { id: firstMs, workspaceId, sessionId, model },
      ]);
      await setMicrosecondInstants(database, '9999-12-31T23:59:59', { '999999': lastMs });
      await setMicrosecondInstants(database, '0001-01-01T00:00:00', { '000000': firstMs });
      await database.asOwnerOf(workspaceId, userId, database.makeStore(), async () => {
        const top = encodeURIComponent('9999-12-31T23:59:59.999Z');
        const bottom = encodeURIComponent('0001-01-01T00:00:00Z');
        const idsFor = async (bounds: string): Promise<string[]> =>
          (await listOverHttp(`model=${model}&${bounds}`)).ids;
        expect(await idsFor(`to=${top}`)).toEqual([lastMs, firstMs]);
        expect(await idsFor(`from=${top}`)).toEqual([lastMs]);
        expect(await idsFor(`from=${bottom}`)).toEqual([lastMs, firstMs]);
        expect(await idsFor(`to=${bottom}`)).toEqual([firstMs]);
        expect(await idsFor(`from=${bottom}&to=${top}`)).toEqual([lastMs, firstMs]);
      });
    });

    /**
     * `parseRunListBound` right-pads a short fractional part before reading it as milliseconds, so
     * `from=…00.5Z` and `from=…00.50Z` both mean 500 ms and not 5 ms or 50 ms. Asserted here at
     * the precision `runs.created_at` actually holds: the `.499999` row is *below* a 500 ms bound
     * by a microsecond and must be excluded by `from`, while `to` keeps all three, because the
     * repository turns an inclusive `to` into `created_at < to + interval '1 millisecond'`. The
     * `.005000` row is what separates 500 ms from 5 ms in the `to` direction — without it, both
     * readings of the bound keep the same rows.
     */
    it('reads a one- and a two-digit from/to fraction as tenths and hundredths of a second, against microsecond created_at', async () => {
      const { workspaceId, userId, sessionId } = await database.seedWorkspace();
      const model = crypto.randomUUID();
      const at = {
        '005000': crypto.randomUUID(),
        '499999': crypto.randomUUID(),
        '500000': crypto.randomUUID(),
      };
      await database.db
        .insert(database.core.runs)
        .values(Object.values(at).map((id) => ({ id, workspaceId, sessionId, model })));
      await setMicrosecondInstants(database, '2026-05-01T08:00:00', at);

      await database.asOwnerOf(workspaceId, userId, database.makeStore(), async () => {
        for (const spelling of ['2026-05-01T08:00:00.5Z', '2026-05-01T08:00:00.50Z']) {
          const bound = encodeURIComponent(spelling);
          expect((await listOverHttp(`model=${model}&from=${bound}`)).ids).toEqual([at['500000']]);
          expect((await listOverHttp(`model=${model}&to=${bound}`)).ids).toEqual([
            at['500000'],
            at['499999'],
            at['005000'],
          ]);
        }
      });
    });
  });
}

describe.skipIf(!hasDatabase)('the PostgreSQL run store', () => {
  const database = useRunDatabase();
  describeDerivedValues(database);
  describeRefusedBounds(database);
  describeBoundEdges(database);
});
