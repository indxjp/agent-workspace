/**
 * Round 3 (findings 1, 2, 3): **one run per predicate, differing from `base` in exactly that
 * predicate's column** (`store.postgres-differential-world.ts`), so that each
 * `RunRepository.listRuns` predicate and each `parseRunListQuery` assignment has one named test
 * that fails, on real PostgreSQL, when that predicate or assignment is deleted.
 *
 * The rounds before this one proved the filters *composed* (three near-misses, one match), which a
 * mutant that drops one predicate can survive whenever another predicate already excludes the same
 * near-miss — the verifier's `wrongStatus` was also wrong-provider. Here nothing is excluded twice.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import type { ListRunsInput, RunListCursor, RunListPage } from './store';
import {
  everyDifference,
  seedDifferentialFixture,
  type DifferentialFixture,
  type Difference,
} from './store.postgres-differential-world.test-support';
import { checkRangeAroundOwnRenderedBound } from './store.postgres-range.test-support';
import {
  databaseConfigured,
  useRunDatabase,
  type RunDatabase,
} from './store.postgres.test-support';
import { listOverHttp, listOverHttpStatus, walkPages } from './store.test-support';
import type { TokenScope } from '../rbac/core/token-scope';

const hasDatabase = databaseConfigured(process.env);

type RunFilter = NonNullable<ListRunsInput['filter']>;

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

/** Every fixture run except the ones named — what a correct single filter returns. */
const allExcept = (fixture: DifferentialFixture, ...excluded: readonly Difference[]): string[] =>
  sorted(
    everyDifference
      .filter((difference) => !excluded.includes(difference))
      .map((difference) => fixture.runs[difference]),
  );

/**
 * One row per repository predicate, in `listRuns`'s own order, named by the filter field it
 * reads. The filter names the value `base` has, so a correct predicate excludes exactly the one run
 * that differs in that column and nothing else; a deleted predicate lets that run back in.
 */
const REPOSITORY_PREDICATES: ReadonlyArray<{
  readonly predicate: string;
  readonly filter: (fixture: DifferentialFixture) => RunFilter;
  readonly excludes: Difference;
}> = [
  { predicate: 'status', filter: () => ({ status: 'failed' }), excludes: 'otherStatus' },
  { predicate: 'agentId', filter: ({ agentId }) => ({ agentId }), excludes: 'otherAgent' },
  {
    predicate: 'projectId',
    filter: ({ projectId }) => ({ projectId }),
    excludes: 'otherProject',
  },
  { predicate: 'provider', filter: () => ({ provider: 'openai' }), excludes: 'otherProvider' },
  { predicate: 'model', filter: ({ model }) => ({ model }), excludes: 'otherModel' },
  { predicate: 'createdFrom', filter: ({ t0 }) => ({ createdFrom: t0 }), excludes: 'earlier' },
  { predicate: 'createdTo', filter: ({ t0 }) => ({ createdTo: t0 }), excludes: 'later' },
  {
    predicate: 'initiatingUserId',
    filter: ({ ownerId }) => ({ initiatingUserId: ownerId }),
    excludes: 'otherUser',
  },
  {
    predicate: 'ownerPrincipalId',
    filter: ({ ownerPrincipalId }) => ({ ownerPrincipalId }),
    excludes: 'otherUser',
  },
];

/**
 * One row per `parseRunListQuery` filter assignment, named by the query parameter it copies onto
 * `filter`. Each query names the value `base` has, so the assignment it exercises excludes exactly
 * one run; an assignment deleted from `api.ts` (the parameter validated but never copied onto
 * `filter`) lets it back in.
 */
const QUERY_ASSIGNMENTS: ReadonlyArray<{
  readonly assignment: string;
  readonly query: (fixture: DifferentialFixture) => string;
  readonly excludes: Difference;
}> = [
  { assignment: 'status=', query: () => 'status=failed', excludes: 'otherStatus' },
  { assignment: 'agent=', query: ({ agentId }) => `agent=${agentId}`, excludes: 'otherAgent' },
  {
    assignment: 'project=',
    query: ({ projectId }) => `project=${projectId}`,
    excludes: 'otherProject',
  },
  { assignment: 'provider=', query: () => 'provider=openai', excludes: 'otherProvider' },
  { assignment: 'model=', query: ({ model }) => `model=${model}`, excludes: 'otherModel' },
  {
    assignment: 'from=',
    query: ({ t0 }) => `from=${t0.toISOString()}`,
    excludes: 'earlier',
  },
  { assignment: 'to=', query: ({ t0 }) => `to=${t0.toISOString()}`, excludes: 'later' },
  {
    assignment: 'user= (grant any)',
    query: ({ ownerId }) => `user=${ownerId}`,
    excludes: 'otherUser',
  },
];

/**
 * Round 3 finding 4: a cursor whose `createdAt` JavaScript's `Date` accepts but PostgreSQL does
 * not used to pass `decodeRunListCursor` and throw out of the query as a `500`. Every probe here is
 * the verifier's; the assertion is the documented `400 invalid_cursor`, never "anything but 500".
 */
const REFUSED_CURSOR_INSTANTS = [
  '1',
  '2026',
  'Sep 12 2026',
  '12/31/2026',
  '2026-09-12',
  '2026-09-12T00:00:00Z',
  '2026-09-12T00:00:00.123456789Z',
  '+275760-09-13T00:00:00.000Z',
  '-000001-01-01T00:00:00.000Z',
  '2026-09-12T00:00:00.000+05:30',
  '2026-09-12 00:00:00 GMT+0900',
  'Thu, 01 Jan 1970 00:00:00 GMT',
  '2026-09-12T24:00:00.000000Z',
  '2026-02-30T00:00:00.000000Z',
  '2026-13-01T00:00:00.000000Z',
  '2026-09-12T23:59:60.000000Z',
  '0000-01-01T00:00:00.000000Z',
  '0000-01-01T00:00:00Z',
];

/** The shapes the two stores actually mint, as the positive control. */
const MINTED_CURSOR_SHAPES = [
  ['the repository (six fractional digits)', '2026-03-01T12:00:00.000000Z'],
  ['InMemoryRunStore (three fractional digits)', '2026-03-01T12:00:00.000Z'],
  ['PostgreSQL year 1', '0001-01-01T00:00:00.000000Z'],
];

const encodeCursor = (createdAt: string, id: string): string =>
  Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');

interface DifferentialSuite {
  fixture(): DifferentialFixture;
  /** The fixture's `RunStore.listRuns` for its own workspace. */
  list(input: ListRunsInput): Promise<RunListPage>;
  listIds(input: ListRunsInput): Promise<string[]>;
  /** Install the fixture store behind the route as `principal`, run `body`, uninstall. */
  asPrincipal(
    principal: { readonly userId: string; readonly role: 'owner' | 'builder' },
    body: () => Promise<void>,
    scope?: TokenScope | null,
  ): Promise<void>;
  asOwner(body: () => Promise<void>): Promise<void>;
}

function useDifferentialSuite(database: RunDatabase): DifferentialSuite {
  let seeded: DifferentialFixture | undefined;
  beforeAll(async () => {
    seeded = await seedDifferentialFixture(database);
  });
  const fixture = (): DifferentialFixture => {
    if (seeded === undefined) throw new Error('the differential fixture was not seeded');
    return seeded;
  };
  const list = (input: ListRunsInput): Promise<RunListPage> =>
    fixture().store.listRuns(fixture().workspaceId, input);
  const asPrincipal: DifferentialSuite['asPrincipal'] = (principal, body, scope = null) =>
    database.withRunApi(fixture().workspaceId, principal, fixture().store, scope, body);
  return {
    fixture,
    list,
    listIds: async (input) => sorted((await list(input)).items.map((run) => run.id)),
    asPrincipal,
    asOwner: (body) => asPrincipal({ userId: fixture().ownerId, role: 'owner' }, body),
  };
}

function describeRepositoryPredicates(suite: DifferentialSuite): void {
  describe('RunRepository.listRuns', () => {
    it('tenant: an unfiltered list is every run in the workspace and nothing from another', async () => {
      const fixture = suite.fixture();
      const ids = await suite.listIds({ limit: 200 });
      expect(ids).toEqual(allExcept(fixture));
      expect(ids).not.toContain(fixture.otherWorkspaceRun);
    });

    it.each(REPOSITORY_PREDICATES)(
      'the $predicate predicate excludes exactly the run that differs in that column',
      async ({ filter, excludes }) => {
        const fixture = suite.fixture();
        const ids = await suite.listIds({ limit: 200, filter: filter(fixture) });
        expect(ids).toEqual(allExcept(fixture, excludes));
        expect(ids).not.toContain(fixture.runs[excludes]);
      },
    );
  });
}

function describeRepositoryPaging(suite: DifferentialSuite): void {
  describe('RunRepository.listRuns', () => {
    it('every predicate at once is the intersection: exactly `base`', async () => {
      const fixture = suite.fixture();
      const ids = await suite.listIds({
        limit: 200,
        filter: {
          status: 'failed',
          agentId: fixture.agentId,
          projectId: fixture.projectId,
          provider: 'openai',
          model: fixture.model,
          createdFrom: fixture.t0,
          createdTo: fixture.t0,
          initiatingUserId: fixture.ownerId,
          ownerPrincipalId: fixture.ownerPrincipalId,
        },
      });
      expect(ids).toEqual([fixture.runs.base]);
    });

    it('limit: a page is exactly `limit` rows, and `hasMore` is answered by the extra row', async () => {
      const page = await suite.list({ limit: 4 });
      expect(page.items).toHaveLength(4);
      expect(page.nextCursor).not.toBeNull();
      const whole = await suite.list({ limit: everyDifference.length });
      expect(whole.items).toHaveLength(everyDifference.length);
      expect(whole.nextCursor).toBeNull();
    });

    it('cursor: pages at limit 4 are disjoint, exactly 4 long until the last, and cover the workspace', async () => {
      const pages: string[][] = [];
      const collected = await walkPages<RunListCursor>(4, async (cursor) => {
        const page = await suite.list({ limit: 4, cursor });
        const ids = page.items.map((run) => run.id);
        pages.push(ids);
        return { ids, nextCursor: page.nextCursor };
      });
      expect(pages.map((page) => page.length)).toEqual([4, 4, 1]);
      expect(new Set(collected).size).toBe(collected.length);
      expect(sorted(collected)).toEqual(allExcept(suite.fixture()));
    });
  });
}

function describeHttpFilters(suite: DifferentialSuite): void {
  describe('GET /api/runs over the repository store', () => {
    it.each(QUERY_ASSIGNMENTS)(
      '$assignment as an Owner excludes exactly the run that differs in that column',
      async ({ query, excludes }) => {
        const fixture = suite.fixture();
        await suite.asOwner(async () => {
          const { ids } = await listOverHttp(`limit=200&${query(fixture)}`);
          expect(sorted(ids)).toEqual(allExcept(fixture, excludes));
          expect(ids).not.toContain(fixture.runs[excludes]);
        });
      },
    );

    it("filter.agentIds = the app-backend scope's bound agents (ADR-0161, #1530): an Owner's list through an app backend is only the bound agent's runs, on real PostgreSQL", async () => {
      const fixture = suite.fixture();
      const appBackend: TokenScope = {
        kind: 'app-backend',
        id: crypto.randomUUID(),
        agentIds: [fixture.agentId.toUpperCase()],
      };
      await suite.asPrincipal(
        { userId: fixture.ownerId, role: 'owner' },
        async () => {
          const { ids } = await listOverHttp('limit=200');
          expect(sorted(ids)).toEqual(allExcept(fixture, 'otherAgent'));
          expect(await listOverHttpStatus(`agent=${crypto.randomUUID()}`)).toEqual({
            status: 403,
            code: 'token_out_of_scope',
          });
        },
        appBackend,
      );
    });

    it("filter.ownerPrincipalId = principal.principalId (grant own): a Builder's unfiltered list is only their exact principal's run, on real PostgreSQL", async () => {
      const fixture = suite.fixture();
      await suite.asPrincipal({ userId: fixture.builderId, role: 'builder' }, async () => {
        const { ids } = await listOverHttp('limit=200');
        expect(ids).toEqual([fixture.runs.otherUser]);
      });
    });
  });
}

function describeHttpPaging(suite: DifferentialSuite): void {
  describe('GET /api/runs over the repository store', () => {
    it('limit = Number(rawLimit): `limit=4` serves exactly 4 runs and a next cursor', async () => {
      await suite.asOwner(async () => {
        const page = await listOverHttp('limit=4');
        expect(page.ids).toHaveLength(4);
        expect(page.nextCursor).not.toBeNull();
      });
    });

    it('cursor: the decoded cursor reaches the store, so pages at limit 4 are disjoint and cover the workspace', async () => {
      await suite.asOwner(async () => {
        const pages: string[][] = [];
        const collected = await walkPages<string>(4, async (cursor) => {
          const page = await listOverHttp('limit=4', cursor);
          pages.push(page.ids);
          return page;
        });
        expect(pages.map((page) => page.length)).toEqual([4, 4, 1]);
        expect(new Set(collected).size).toBe(collected.length);
        expect(sorted(collected)).toEqual(allExcept(suite.fixture()));
      });
    });
  });
}

function describeHttpCursors(suite: DifferentialSuite): void {
  describe('GET /api/runs over the repository store', () => {
    it.each(REFUSED_CURSOR_INSTANTS)(
      'a cursor whose createdAt is %j is 400 invalid_cursor, never a thrown query',
      async (createdAt) => {
        await suite.asOwner(async () => {
          const cursor = encodeCursor(createdAt, suite.fixture().runs.base);
          const outcome = await listOverHttpStatus(`limit=1&cursor=${encodeURIComponent(cursor)}`);
          expect(outcome).toEqual({ status: 400, code: 'invalid_cursor' });
        });
      },
    );

    it.each(MINTED_CURSOR_SHAPES)(
      'a cursor in the shape %s mints is accepted and applied by the real query',
      async (_shape, createdAt) => {
        await suite.asOwner(async () => {
          // The boundary is `base`'s own `(created_at, id)`, so the page is every run strictly
          // before it in `(created_at desc, id desc)` order — no throw, no 500, a real answer.
          const fixture = suite.fixture();
          const { ids } = await listOverHttp(
            'limit=200',
            encodeCursor(createdAt, fixture.runs.base),
          );
          expect(ids).not.toContain(fixture.runs.base);
          expect(ids).not.toContain(fixture.runs.later);
        });
      },
    );
  });
}

describe.skipIf(!hasDatabase)('the PostgreSQL run store', () => {
  const database = useRunDatabase();

  describe('listRuns (issue #135)', () => {
    describe('every predicate and every query assignment, one at a time (round 3)', () => {
      const suite = useDifferentialSuite(database);
      describeRepositoryPredicates(suite);
      describeRepositoryPaging(suite);
      describeHttpFilters(suite);
      describeHttpPaging(suite);
      describeHttpCursors(suite);

      /**
       * Round 3 finding 5: `to` is inclusive at the precision the API renders, and round 4
       * finding 4: exclusive of the very next millisecond. Four runs at `.122999`, `.123000`,
       * `.123999` and `.124000` around a bound of `.123Z`; see `store.postgres-range.ts`.
       */
      it('a run is inside a date range built from its own rendered createdAt, at microsecond created_at, and the next millisecond is outside it', async () => {
        await checkRangeAroundOwnRenderedBound(database);
      });
    });
  });
});
