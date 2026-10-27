import { asc, eq, gt, lte, max, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { runEvents } from '../../schema/run-events.js';
import { runs } from '../../schema/runs.js';
import { requireWorkspaceScope, type WorkspaceScope } from '../scope.js';
import { STOPPED, every } from './rows.js';
import type { RunEventRepository, RunEventRepositoryProvider } from './types.js';

/** PostgreSQL event log with an advisory lock assigning one contiguous sequence per run. */
export function createDatabaseRunEventRepositoryProvider(db: Database): RunEventRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): RunEventRepository {
      const checked = requireWorkspaceScope(scope, 'RunEventRepositoryProvider');
      const tenant = eq(runs.workspaceId, checked.workspaceId);
      return {
        async append(runId, type, data, maxEvents) {
          return db.transaction(async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${runId}, 0))`);
            const owned = await tx
              .select({ id: runs.id, status: runs.status })
              .from(runs)
              .where(every(tenant, eq(runs.id, runId)))
              .limit(1);
            const currentRun = owned[0];
            if (currentRun === undefined || STOPPED.has(currentRun.status)) return null;
            const current = await tx
              .select({ value: max(runEvents.sequence) })
              .from(runEvents)
              .where(eq(runEvents.runId, runId));
            const latest = current[0]?.value;
            const next = (latest == null ? 0n : BigInt(latest)) + 1n;
            const inserted = await tx
              .insert(runEvents)
              .values({
                runId,
                workspaceId: checked.workspaceId,
                sequence: next,
                type,
                data,
              })
              .returning({ at: runEvents.createdAt });
            const cutoff = next - BigInt(maxEvents);
            if (cutoff > 0n) {
              await tx
                .delete(runEvents)
                .where(every(eq(runEvents.runId, runId), lte(runEvents.sequence, cutoff)));
            }
            const at = inserted[0]?.at;
            if (at === undefined) throw new Error('run event insert returned no row');
            return { id: next, type, data, at };
          });
        },
        async list(runId, after, limit) {
          const predicates: SQL[] = [tenant, eq(runs.id, runId), eq(runEvents.runId, runs.id)];
          if (after !== null) predicates.push(gt(runEvents.sequence, after));
          const query = db
            .select({
              id: runEvents.sequence,
              type: runEvents.type,
              data: runEvents.data,
              at: runEvents.createdAt,
            })
            .from(runEvents)
            .innerJoin(runs, eq(runs.id, runEvents.runId))
            .where(every(...predicates))
            .orderBy(asc(runEvents.sequence))
            .$dynamic();
          return limit === undefined ? query : query.limit(limit);
        },
        async bounds(runId) {
          const values = await db
            .select({
              oldest: sql<bigint>`min(${runEvents.sequence})`,
              latest: max(runEvents.sequence),
            })
            .from(runEvents)
            .innerJoin(runs, eq(runs.id, runEvents.runId))
            .where(every(tenant, eq(runs.id, runId)));
          const row = values[0];
          return row?.oldest == null || row.latest == null
            ? null
            : { oldest: BigInt(row.oldest), latest: BigInt(row.latest) };
        },
      };
    },
  };
}
