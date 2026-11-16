import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { demoDailyCosts } from '../schema/demo-daily-costs.js';
import { demoRunAdmissions } from '../schema/demo-run-admissions.js';
import { runUsageRecords } from '../schema/run-usage-records.js';
import { runs } from '../schema/runs.js';
import { workspaces } from '../schema/workspaces.js';

/** What one admission attempt found. */
export type DemoAdmissionOutcome = 'admitted' | 'person_limit' | 'client_limit';

/** One UTC day's demo model spend, live and carried. */
export interface DemoSpendWindow {
  /** The cost as a decimal string; `'0'` when nothing was spent. */
  readonly costUsd: string;
  /** Some of the spend has no price, so the sum is a floor. */
  readonly unpricedUsage: boolean;
}

/**
 * The demo run caps' tables (internal spec, "Abuse controls"): `demo_run_admissions`, the demo
 * workspaces' usage ledger and `demo_daily_costs`. Not tenant-scoped: a cap counts across every
 * demo workspace a person or an address has had, and the site cost across all of them;
 * `tenancy-readers.test-support.ts` records the exemption. Times come from the caller's `Clock`.
 */
export interface DemoCapsRepository {
  /** When the workspace's demo ends, or `null` for a real workspace or one that does not exist. */
  demoExpiresAt(workspaceId: string): Promise<Date | null>;
  /**
   * Count the person's and the client's admissions at or after `since` and record one at `now`
   * only if both are under their limits, in one transaction. Both counts are taken under
   * transaction-scoped advisory locks (person first, then client, always in that order), so of two
   * concurrent calls at the last place exactly one is admitted.
   */
  admit(input: {
    readonly userId: string;
    readonly clientKey: string;
    readonly now: Date;
    readonly since: Date;
    readonly personLimit: number;
    readonly clientLimit: number;
  }): Promise<DemoAdmissionOutcome>;
  /** How many demo runs the person started at or after `since`: the count `admit` limits. */
  countAdmissionsSince(userId: string, since: Date): Promise<number>;
  /**
   * Every demo workspace's model spend with usage at or after `dayStart` and before `dayEnd`
   * (live workspaces' ledger rows), plus `demo_daily_costs` for the UTC day `dayStart` starts
   * (workspaces already deleted).
   */
  spentOn(dayStart: Date, dayEnd: Date): Promise<DemoSpendWindow>;
}

/** Advisory-lock key of one counted subject; the prefix keeps persons and clients apart. */
const lockKey = (kind: 'person' | 'client', subject: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`demo_admit:${kind}:${subject}`}, 0))`;

export function createDatabaseDemoCapsRepository(db: Database): DemoCapsRepository {
  return {
    async demoExpiresAt(workspaceId) {
      const [row] = await db
        .select({ demoExpiresAt: workspaces.demoExpiresAt })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      return row?.demoExpiresAt ?? null;
    },
    async countAdmissionsSince(userId, since) {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(demoRunAdmissions)
        .where(and(eq(demoRunAdmissions.userId, userId), gte(demoRunAdmissions.createdAt, since)));
      return row?.count ?? 0;
    },
    admit({ userId, clientKey, now, since, personLimit, clientLimit }) {
      return db.transaction(async (tx) => {
        await tx.execute(lockKey('person', userId));
        await tx.execute(lockKey('client', clientKey));
        const [personRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(demoRunAdmissions)
          .where(
            and(eq(demoRunAdmissions.userId, userId), gte(demoRunAdmissions.createdAt, since)),
          );
        if ((personRow?.count ?? 0) >= personLimit) return 'person_limit';
        const [clientRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(demoRunAdmissions)
          .where(
            and(
              eq(demoRunAdmissions.clientKey, clientKey),
              gte(demoRunAdmissions.createdAt, since),
            ),
          );
        if ((clientRow?.count ?? 0) >= clientLimit) return 'client_limit';
        await tx.insert(demoRunAdmissions).values({ userId, clientKey, createdAt: now });
        return 'admitted';
      });
    },
    async spentOn(dayStart, dayEnd) {
      const [live] = await db
        .select({
          total: sql<string>`coalesce(sum(${runUsageRecords.costUsd}), 0)::text`,
          unpriced: sql<boolean>`coalesce(bool_or(${runs.accountingState} <> 'complete'), false)`,
        })
        .from(runUsageRecords)
        .innerJoin(runs, eq(runs.id, runUsageRecords.runId))
        .innerJoin(workspaces, eq(workspaces.id, runUsageRecords.workspaceId))
        .where(
          and(
            isNotNull(workspaces.demoExpiresAt),
            gte(runUsageRecords.createdAt, dayStart),
            lt(runUsageRecords.createdAt, dayEnd),
          ),
        );
      // A run whose settlement failed may have spent money no ledger row records.
      const [failed] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(runs)
        .innerJoin(workspaces, eq(workspaces.id, runs.workspaceId))
        .where(
          and(
            isNotNull(workspaces.demoExpiresAt),
            eq(runs.accountingState, 'failed'),
            gte(runs.createdAt, dayStart),
            lt(runs.createdAt, dayEnd),
          ),
        );
      const [carried] = await db
        .select({
          total: sql<string>`${demoDailyCosts.costUsd}::text`,
          unpriced: demoDailyCosts.unpricedUsage,
        })
        .from(demoDailyCosts)
        .where(eq(demoDailyCosts.day, dayStart.toISOString().slice(0, 10)));
      return {
        costUsd: String(Number(live?.total ?? '0') + Number(carried?.total ?? '0')),
        unpricedUsage:
          (live?.unpriced ?? false) || (failed?.count ?? 0) > 0 || (carried?.unpriced ?? false),
      };
    },
  };
}
