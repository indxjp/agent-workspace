import { asc, eq, lt, lte, ne, or } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { memberships } from '../../schema/memberships.js';
import { runs, type AccountingState, type RunStatus } from '../../schema/runs.js';
import { requireWorkspaceScope, type WorkspaceScope } from '../scope.js';
import { every, parseAccountingState, parseRunStatus } from './rows.js';

/** One run an operator's accounting reconciliation pass should look at (issue #134, gap G-8). */
export interface AccountingReconciliationCandidate {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: RunStatus;
  readonly accountingState: AccountingState;
  readonly accountingError: string | null;
  readonly createdAt: Date;
}

/**
 * Runs whose accounting never reached `complete`, oldest first — the query G-8 names: this task
 * builds the query an operator runs by hand, and deliberately no scheduled job that runs it.
 *
 * Cross-tenant and unscoped like {@link findRunWorkspace}, for the same reason: an operator
 * reconciling stuck settlement is not acting *as* any one workspace. It returns run identity and
 * accounting status only — no token counts, no cost, no error detail beyond the already-redacted
 * `accounting_error` — so a caller that wants to act on a candidate still goes through the
 * tenant-scoped {@link RunRepository} for the workspace this lists.
 */
export async function listRunsNeedingAccountingReconciliation(
  db: Database,
  olderThan: Date,
  limit = 100,
): Promise<readonly AccountingReconciliationCandidate[]> {
  const rows = await db
    .select({
      id: runs.id,
      workspaceId: runs.workspaceId,
      status: runs.status,
      accountingState: runs.accountingState,
      accountingError: runs.accountingError,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(every(ne(runs.accountingState, 'complete'), lte(runs.createdAt, olderThan)))
    .orderBy(asc(runs.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    status: parseRunStatus(row.status),
    accountingState: parseAccountingState(row.accountingState),
  }));
}

/**
 * Runs no process is driving any more: `running` since before `before`, or `queued` since before
 * it. A launch lives in the process that started it, so a replica that dies mid-run leaves its row
 * open forever; the stale-run sweep fails these through the scoped `finish`, which revokes the
 * run's tokens. A run paused at `awaiting_approval` is deliberately not listed: nothing is driving it
 * by design, and its 24 h expiry is a decision, not a crash (ADR-0145 D1, D2.4). Cross-tenant and
 * unscoped like {@link findRunWorkspace}: it returns ids only.
 */
export async function listStaleRunIds(
  db: Database,
  before: Date,
  limit = 100,
): Promise<readonly string[]> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      or(
        every(eq(runs.status, 'running'), lt(runs.startedAt, before)),
        every(eq(runs.status, 'queued'), lt(runs.createdAt, before)),
      ),
    )
    .orderBy(asc(runs.createdAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Is this user a member of this scope's workspace?
 *
 * Here rather than in `scope.ts` because it is an *authorisation* question and the scope is a
 * *tenancy* value; W2-CP-06 owns the former. It is exported because `sessions_member_workspace_fk`
 * makes membership a precondition of a session row, and a caller that can check it first gets a
 * legible refusal instead of a constraint violation.
 */
export async function isWorkspaceMember(
  db: Database,
  scope: WorkspaceScope,
  userId: string,
): Promise<boolean> {
  // The same run-time refusal every `forScope` runs: this reads rows for a tenant, so a forged
  // scope must not reach the `where` clause here either.
  const checked = requireWorkspaceScope(scope, 'isWorkspaceMember');
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(every(eq(memberships.workspaceId, checked.workspaceId), eq(memberships.userId, userId)))
    .limit(1);
  // Positive assertion: a member because a membership row was returned.
  return rows.length > 0;
}
