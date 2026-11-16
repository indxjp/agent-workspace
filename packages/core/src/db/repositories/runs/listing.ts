import { asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';

import { agentVersions } from '../../schema/agent-versions.js';

import { runUsageRecords } from '../../schema/run-usage-records.js';

import { runs } from '../../schema/runs.js';
import { sessions } from '../../schema/sessions.js';

import type { RunContext } from './context.js';
import { LIST_RUN_COLUMNS, RUN_COLUMNS, UUID_PATTERN, every, toRunRecord } from './rows.js';
import type {
  ListRunsInput,
  RunListPage,
  RunRecord,
  RunRepository,
  UsageCostWindow,
} from './types.js';

const MAX_RUN_LIST_LIMIT = 200;
export function createRunListing({
  db,
  checked,
  tenant,
}: RunContext): Pick<RunRepository, 'listRuns' | 'listChildren' | 'usageCostUsd'> {
  return {
    async listRuns(input: ListRunsInput): Promise<RunListPage> {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
        throw new Error('listRuns limit must be a safe positive integer');
      }
      if (input.limit > MAX_RUN_LIST_LIMIT) {
        throw new Error(`listRuns limit must not exceed ${String(MAX_RUN_LIST_LIMIT)}`);
      }
      const predicates = runListPredicates(input, tenant);
      // One extra row, never returned, tells the caller a next page exists without a second
      // round trip and without trusting a row count that can shift under concurrent writes.
      const rows = await db
        .select(LIST_RUN_COLUMNS)
        .from(runs)
        .innerJoin(
          sessions,
          every(eq(sessions.id, runs.sessionId), eq(sessions.workspaceId, runs.workspaceId)),
        )
        .leftJoin(
          agentVersions,
          every(
            eq(agentVersions.id, sessions.agentVersionId),
            eq(agentVersions.workspaceId, sessions.workspaceId),
          ),
        )
        .where(every(...predicates))
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(input.limit + 1);
      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const items = page.map(toRunRecord);
      // The cursor is minted from the raw row's full-precision `createdAtCursor`, never from
      // `RunRecord.createdAt` on `items` — that field is a `Date` and is exactly the
      // millisecond-truncated value this whole fix exists to stop using as a boundary.
      const lastRow = page[page.length - 1];
      const nextCursor =
        hasMore && lastRow !== undefined
          ? { createdAt: lastRow.createdAtCursor, id: lastRow.id }
          : null;
      return { items, nextCursor };
    },
    async listChildren(parentRunId: string, limit: number): Promise<readonly RunRecord[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RUN_LIST_LIMIT) {
        throw new Error(
          `listChildren limit must be an integer from 1 to ${String(MAX_RUN_LIST_LIMIT)}`,
        );
      }
      // A non-UUID string names no run; binding it to a `uuid` parameter would throw instead.
      if (!UUID_PATTERN.test(parentRunId)) return [];
      const rows = await db
        .select(RUN_COLUMNS)
        .from(runs)
        .innerJoin(
          sessions,
          every(eq(sessions.id, runs.sessionId), eq(sessions.workspaceId, runs.workspaceId)),
        )
        .leftJoin(
          agentVersions,
          every(
            eq(agentVersions.id, sessions.agentVersionId),
            eq(agentVersions.workspaceId, sessions.workspaceId),
          ),
        )
        .where(every(tenant, eq(runs.parentRunId, parentRunId)))
        .orderBy(asc(runs.createdAt), asc(runs.id))
        .limit(limit);
      return rows.map(toRunRecord);
    },
    async usageCostUsd(from: Date, to: Date): Promise<UsageCostWindow> {
      const [row] = await db
        .select({
          total: sql<string>`coalesce(sum(${runUsageRecords.costUsd}), 0)::text`,
          unpriced: sql<boolean>`coalesce(bool_or(${runs.accountingState} <> 'complete'), false)`,
        })
        .from(runUsageRecords)
        .innerJoin(
          runs,
          every(
            eq(runs.id, runUsageRecords.runId),
            eq(runs.workspaceId, runUsageRecords.workspaceId),
          ),
        )
        .where(
          every(
            eq(runUsageRecords.workspaceId, checked.workspaceId),
            gte(runUsageRecords.createdAt, from),
            lt(runUsageRecords.createdAt, to),
          ),
        );
      // A run whose settlement itself failed may have spent money no ledger row records, so it
      // has nothing to join above. It makes the window unpriced all the same (#1963, SPD-12).
      // Only `failed` does: a run still `pending` has simply not settled yet, and a window that
      // counted every unsettled run would refuse a whole workspace for a run in flight.
      let unpriced = row?.unpriced ?? false;
      if (!unpriced) {
        const failed = await db
          .select({ id: runs.id })
          .from(runs)
          .where(
            every(
              tenant,
              eq(runs.accountingState, 'failed'),
              gte(runs.createdAt, from),
              lt(runs.createdAt, to),
            ),
          )
          .limit(1);
        unpriced = failed.length > 0;
      }
      return { costUsd: row?.total ?? '0', unpricedUsage: unpriced };
    },
  };
}

function runListPredicates(input: ListRunsInput, tenant: SQL): SQL[] {
  const filter = input.filter ?? {};
  const predicates: SQL[] = [tenant];
  if (filter.status !== undefined) predicates.push(eq(runs.status, filter.status));
  if (filter.agentId !== undefined) predicates.push(eq(sessions.agentId, filter.agentId));
  if (filter.agentIds !== undefined) {
    // `inArray` of an empty list is `false` in drizzle, which is what an empty set means.
    predicates.push(inArray(sessions.agentId, [...filter.agentIds]));
  }
  if (filter.projectId !== undefined) {
    predicates.push(eq(sessions.projectId, filter.projectId));
  }
  if (filter.provider !== undefined) predicates.push(eq(runs.provider, filter.provider));
  if (filter.model !== undefined) predicates.push(eq(runs.model, filter.model));
  if (filter.createdFrom !== undefined) {
    predicates.push(gte(runs.createdAt, filter.createdFrom));
  }
  if (filter.createdTo !== undefined) {
    // Match the rendered millisecond inclusively while preserving PostgreSQL microseconds.
    // Add in SQL so the legal maximum Date does not first overflow into year 10000 in JS.
    predicates.push(
      lt(
        runs.createdAt,
        sql`${filter.createdTo.toISOString()}::timestamptz + interval '1 millisecond'`,
      ),
    );
  }
  if (filter.initiatingUserId !== undefined) {
    predicates.push(eq(sessions.userId, filter.initiatingUserId));
  }
  if (filter.ownerPrincipalId !== undefined) {
    predicates.push(eq(sessions.ownerPrincipalId, filter.ownerPrincipalId));
  }
  const cursor = input.cursor ?? null;
  if (cursor !== null) predicates.push(beforeRunCursor(cursor));

  return predicates;
}

function beforeRunCursor(cursor: NonNullable<ListRunsInput['cursor']>): SQL {
  // Keep the database cursor precision; id breaks ties between rows created at the same instant.
  const boundary = sql`${cursor.createdAt}::timestamptz`;
  const beforeBoundary = or(
    lt(runs.createdAt, boundary),
    every(eq(runs.createdAt, boundary), lt(runs.id, cursor.id)),
  );
  if (beforeBoundary === undefined) {
    throw new Error('the cursor predicate could not be built');
  }

  return beforeBoundary;
}
