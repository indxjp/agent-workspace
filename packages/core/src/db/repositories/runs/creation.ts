import { RUN_CHILDREN_MAX } from '@indx-workspace/contracts/runs';
import { eq, ne, notInArray, sql } from 'drizzle-orm';

import type { Database } from '../../client.js';

import { runs, stoppedRunStatuses } from '../../schema/runs.js';

import type { RunContext } from './context.js';
import type { createRunLifecycle } from './lifecycle.js';
import {
  FOREIGN_KEY_VIOLATION,
  RUN_CONTINUATION_INDEX,
  RUN_IDEMPOTENCY_KEY_INDEX,
  RUN_PRIMARY_KEY,
  RUN_SESSION_CONSTRAINT,
  UNIQUE_VIOLATION,
  every,
  parseApprovalCalls,
  scopedIdempotencyKey,
  violatedBy,
} from './rows.js';
import type { CreateRunInput, CreateRunOutcome, RunRepository } from './types.js';

/** The stored reason of a paused run cancelled because nobody decided in time. */
const APPROVAL_EXPIRED_ERROR =
  'approval_expired: no decision was made within 24 hours, so the request was rejected';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The fan-out guard of a child-run insert (ADR-0104 acceptance decisions 6 and 8): under a lock on
 * the lead run, so two member calls that race both count the other, `child-limit` when the lead
 * already has `maxChildren` child runs, otherwise `null`. A continuation of a child counts too, so
 * a tree never holds more than `maxChildren` children and the run read, its tree cost and the
 * interrupt cascade (each reading at most `RUN_CHILDREN_MAX`) always see all of them.
 *
 * With `requireRunning` (a member call, not a continuation) the lead's row is read `for share`:
 * a lead that is no longer `running` answers `parent-stopped`. The share lock waits for an
 * interrupt's committed status update, and an interrupt that comes after waits for this insert, so
 * the interrupt cascade's later read of the children always sees a child this call inserts.
 */
async function childLimitIn(
  tx: Transaction,
  workspaceId: string,
  parent: { readonly runId: string; readonly maxChildren: number },
  requireRunning: boolean,
): Promise<CreateRunOutcome | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${parent.runId}, 2))`);
  if (requireRunning) {
    const [lead] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(every(eq(runs.workspaceId, workspaceId), eq(runs.id, parent.runId)))
      .limit(1)
      .for('share');
    if (lead?.status !== 'running') return { kind: 'parent-stopped', runId: parent.runId };
  }
  const [row] = await tx
    .select({ children: sql<number>`count(*)::int` })
    .from(runs)
    .where(every(eq(runs.workspaceId, workspaceId), eq(runs.parentRunId, parent.runId)));
  return (row?.children ?? 0) >= parent.maxChildren
    ? { kind: 'child-limit', runId: parent.runId }
    : null;
}

export function createRunCreation(
  context: RunContext,
  stopIn: ReturnType<typeof createRunLifecycle>['stopIn'],
): Pick<RunRepository, 'create' | 'findByIdempotencyKey'> {
  const { db, checked, tenant, read } = context;
  return {
    async create(input: CreateRunInput): Promise<CreateRunOutcome> {
      const approvedToolCalls = parseApprovalCalls(input.approvedToolCalls ?? []);
      if (
        input.spendCeilingUsd !== undefined &&
        input.spendCeilingUsd !== null &&
        !/^\d{1,8}(?:\.\d{1,6})?$/u.test(input.spendCeilingUsd)
      ) {
        throw new Error('run spendCeilingUsd must be a decimal with at most six places');
      }
      const decides = input.decides;
      try {
        const refused = await db.transaction(async (tx): Promise<CreateRunOutcome | null> => {
          // Session project assignment and run creation share this lock. A run cannot enter
          // between moveSession's no-runs check and its project update, and two creates on
          // one session cannot both pass the busy check below.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${input.sessionId}, 1))`,
          );
          const continuation = await continuationTreeIn(tx, context, input, stopIn);
          if (continuation.kind !== 'ready') return continuation;
          const tree = continuation.tree;
          if (input.parent !== undefined && decides === undefined) {
            const refusedChild = await childLimitIn(tx, checked.workspaceId, input.parent, true);
            if (refusedChild !== null) return refusedChild;
          } else if (decides !== undefined && tree.parentRunId !== null) {
            // A child's continuation is one more row under the root, so it meets the fan-out.
            const refusedChild = await childLimitIn(
              tx,
              checked.workspaceId,
              { runId: tree.parentRunId, maxChildren: RUN_CHILDREN_MAX },
              false,
            );
            if (refusedChild !== null) return refusedChild;
          }
          if (input.idempotency !== undefined) {
            // Before the busy check (#1440): a retry that raced its original on this session
            // waited on the lock above, and must hear "key taken" so the route replays the
            // original, not `session_busy`. A key held on another session still reaches the
            // unique index below.
            const held = await tx
              .select({ id: runs.id })
              .from(runs)
              .where(
                every(
                  tenant,
                  eq(
                    runs.idempotencyKey,
                    scopedIdempotencyKey(input.idempotency.principalId, input.idempotency.key),
                  ),
                ),
              )
              .limit(1);
            if (held.length > 0) {
              return { kind: 'idempotency-key-taken', key: input.idempotency.key };
            }
          }
          const active = await tx
            .select({ id: runs.id })
            .from(runs)
            .where(
              every(
                tenant,
                eq(runs.sessionId, input.sessionId),
                // A reused id is a duplicate, answered by the primary key below.
                ne(runs.id, input.id),
                notInArray(runs.status, [...stoppedRunStatuses]),
              ),
            )
            .limit(1);
          if (active.length > 0) return { kind: 'session-busy', sessionId: input.sessionId };
          if (decides !== undefined) {
            // A decision completes the pause; the continuation inserted below carries on.
            const decided = await stopIn(
              tx,
              decides.runId,
              'completed',
              { error: null },
              decides.statusEventMaxEvents,
            );
            if (!decided) return { kind: 'already-decided', runId: decides.runId };
          }
          await tx.insert(runs).values({
            id: input.id,
            // Not from the caller. A run inherits the scope's workspace.
            workspaceId: checked.workspaceId,
            sessionId: input.sessionId,
            engine: input.engine,
            prompt: input.prompt ?? null,
            approvedToolCalls,
            continuesRunId: decides?.runId ?? null,
            parentRunId: tree.parentRunId,
            agentTeamVersionId: tree.agentTeamVersionId,
            outputSchema: input.outputSchema ?? null,
            subject: input.subject ?? null,
            limitsOverride: input.limitsOverride ?? null,
            spendCeilingUsd: input.spendCeilingUsd ?? null,
            ...(input.idempotency === undefined
              ? {}
              : {
                  idempotencyKey: scopedIdempotencyKey(
                    input.idempotency.principalId,
                    input.idempotency.key,
                  ),
                  idempotencyRequestHash: input.idempotency.requestHash,
                }),
          });
          return null;
        });
        if (refused !== null) return refused;
      } catch (error) {
        if (violatedBy(error, UNIQUE_VIOLATION, RUN_PRIMARY_KEY)) {
          return { kind: 'duplicate-id', id: input.id };
        }
        if (
          input.idempotency !== undefined &&
          violatedBy(error, UNIQUE_VIOLATION, RUN_IDEMPOTENCY_KEY_INDEX)
        ) {
          return { kind: 'idempotency-key-taken', key: input.idempotency.key };
        }
        if (decides !== undefined && violatedBy(error, UNIQUE_VIOLATION, RUN_CONTINUATION_INDEX)) {
          // The paused run already has its continuation: the same answer as a decided run.
          return { kind: 'already-decided', runId: decides.runId };
        }
        if (violatedBy(error, FOREIGN_KEY_VIOLATION, RUN_SESSION_CONSTRAINT)) {
          // Also the answer when the session exists in ANOTHER workspace: the composite key
          // is what makes those two the same rejection (spec §25).
          return { kind: 'unknown-session', sessionId: input.sessionId };
        }
        throw error;
      }
      const created = await read(input.id);
      if (created === null) throw new Error(`run ${input.id} vanished between insert and read`);
      return { kind: 'created', run: created };
    },
    async findByIdempotencyKey(principalId: string, key: string) {
      const rows = await db
        .select({ id: runs.id, requestHash: runs.idempotencyRequestHash })
        .from(runs)
        .where(every(tenant, eq(runs.idempotencyKey, scopedIdempotencyKey(principalId, key))))
        .limit(1);
      const row = rows[0];
      if (row?.requestHash == null) return null;
      const run = await read(row.id);
      return run === null ? null : { run, requestHash: row.requestHash };
    },
  };
}

type RunTree = { parentRunId: string | null; agentTeamVersionId: string | null };
type StopIn = ReturnType<typeof createRunLifecycle>['stopIn'];
async function continuationTreeIn(
  tx: Transaction,
  context: RunContext,
  input: CreateRunInput,
  stopIn: StopIn,
): Promise<{ kind: 'ready'; tree: RunTree } | CreateRunOutcome> {
  const { tenant } = context;
  const decides = input.decides;
  let tree = {
    parentRunId: input.parent?.runId ?? null,
    agentTeamVersionId: input.agentTeamVersionId ?? null,
  };

  if (decides !== undefined) {
    // Session lock first, then the run lock: the paused run cannot move between this
    // read and the update below. A paused run is not session-busy, so the session
    // lock is what serialises two concurrent decisions.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${decides.runId}, 0))`);
    const paused = await tx
      .select({
        expired: sql<boolean>`${runs.approvalDeadlineAt} < now()`,
        parentRunId: runs.parentRunId,
        agentTeamVersionId: runs.agentTeamVersionId,
      })
      .from(runs)
      .where(
        every(
          tenant,
          eq(runs.id, decides.runId),
          eq(runs.sessionId, input.sessionId),
          eq(runs.status, 'awaiting_approval'),
        ),
      )
      .limit(1);
    const pausedRun = paused[0];
    if (pausedRun === undefined) {
      return { kind: 'already-decided', runId: decides.runId };
    }
    if (pausedRun.expired) {
      await stopIn(
        tx,
        decides.runId,
        'cancelled',
        { error: APPROVAL_EXPIRED_ERROR },
        decides.statusEventMaxEvents,
      );
      return { kind: 'approval-expired', runId: decides.runId };
    }
    // A continuation stays in its paused run's tree (ADR-0104 decisions 5 and 7).
    tree = {
      parentRunId: pausedRun.parentRunId,
      agentTeamVersionId: pausedRun.agentTeamVersionId,
    };
  }

  return { kind: 'ready', tree };
}
