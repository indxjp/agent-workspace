import { eq, inArray, isNull, lte, max, sql } from 'drizzle-orm';

import { webhookEventTypeOf } from '@indx-workspace/contracts/webhooks';
import type { Database } from '../../client.js';

import { runEvents } from '../../schema/run-events.js';

import { runTokens } from '../../schema/run-tokens.js';

import { runs, type RunStatus } from '../../schema/runs.js';

import type { RunContext } from './context.js';
import { every, isTerminalRunStatus, parseApprovalCall, runStatusesThatMayMoveTo } from './rows.js';
import type {
  ApprovalCall,
  ConsumeApprovedCallOutcome,
  RunOutput,
  RunRepository,
  RunTransitionOutcome,
} from './types.js';
/** How long a paused run waits for a decision before a late one cancels it (ADR-0145 D2.4). */
const APPROVAL_WINDOW_HOURS = 24;

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

interface StopSet {
  readonly error: string | null;
  readonly pendingApproval?: ApprovalCall;
  /** Written only when given: a pause leaves the column alone. */
  readonly output?: RunOutput | null;
}

/**
 * The webhook outbox (ADR-SDK-18-N3-250 D4): inside a stop's transaction, one pending delivery per
 * webhook of the run's workspace that subscribes to the event `status` emits. The caller's guarded
 * update moves a run to a terminal status once; the unique (workspace, webhook, run) index is the
 * database fact behind that. `awaiting_approval` is stopped, not final, and emits nothing (D3).
 */
async function enqueueWebhookDeliveriesIn(
  tx: Transaction,
  workspaceId: string,
  runId: string,
  status: RunStatus,
): Promise<void> {
  const eventType = webhookEventTypeOf(status);
  if (eventType === null) return;
  await tx.execute(sql`
    insert into webhook_deliveries (workspace_id, webhook_id, run_id, event_type)
    select webhook.workspace_id, webhook.id, ${runId}::uuid, ${eventType}::text
    from webhooks as webhook
    where webhook.workspace_id = ${workspaceId}::uuid
      and ${eventType}::text = any(webhook.events)
    on conflict (workspace_id, webhook_id, run_id) do nothing`);
}

export function createRunLifecycle({ db, checked, tenant, read }: RunContext) {
  /**
   * Move a run to a status at which its runtime is over (terminal, or `awaiting_approval`) in
   * one transaction: the guarded update, the optional `run.status` event, and the revocation of
   * the run's tokens. Returns whether the run moved.
   */
  const stopIn = async (
    tx: Transaction,
    runId: string,
    status: RunStatus,
    set: StopSet,
    statusEventMaxEvents?: number,
  ): Promise<boolean> => {
    // Event append takes this exact lock before checking status and allocating sequence.
    // Whichever transaction enters first completes wholly first: a stop cannot overtake an
    // admitted event, and an append cannot enter after the stop. A caller that already holds
    // the session lock takes this one second; nothing takes them in the other order.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${runId}, 0))`);
    const moved = await tx
      .update(runs)
      .set({
        status,
        // A paused run keeps this end time when a decision later finishes it.
        endedAt: sql`coalesce(${runs.endedAt}, now())`,
        // `runs_ended_at_iff_terminal` needs a coherent pair, and
        // `runs_ended_after_started` needs the start not to be later than the end. A run
        // that failed before it ever started gets its start stamped here rather than
        // leaving a NULL that renders as "NaN s".
        startedAt: sql`coalesce(${runs.startedAt}, now())`,
        error: set.error,
        ...(set.pendingApproval === undefined ? {} : { pendingApproval: set.pendingApproval }),
        // The deadline is stamped with the pause, from the same end time (ADR-0145 D2.4).
        ...(status === 'awaiting_approval'
          ? {
              approvalDeadlineAt: sql`coalesce(${runs.endedAt}, now()) + make_interval(hours => ${APPROVAL_WINDOW_HOURS})`,
            }
          : {}),
        ...(set.output === undefined ? {} : { output: set.output }),
      })
      .where(
        every(
          tenant,
          eq(runs.id, runId),
          inArray(runs.status, [...runStatusesThatMayMoveTo(status)]),
        ),
      )
      .returning({ id: runs.id });
    if (moved.length === 0) return false;
    if (statusEventMaxEvents !== undefined) {
      const current = await tx
        .select({ value: max(runEvents.sequence) })
        .from(runEvents)
        .where(eq(runEvents.runId, runId));
      const latest = current[0]?.value;
      const next = (latest == null ? 0n : BigInt(latest)) + 1n;
      await tx.insert(runEvents).values({
        runId,
        workspaceId: checked.workspaceId,
        sequence: next,
        type: 'run.status',
        data: { status, error: set.error },
      });
      const cutoff = next - BigInt(statusEventMaxEvents);
      if (cutoff > 0n) {
        await tx
          .delete(runEvents)
          .where(every(eq(runEvents.runId, runId), lte(runEvents.sequence, cutoff)));
      }
    }
    await enqueueWebhookDeliveriesIn(tx, checked.workspaceId, runId, status);
    // Token revocation is part of the same commit as the stop. A gateway can therefore
    // never observe a committed stopped run whose bearer remains active.
    await tx
      .update(runTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        every(
          eq(runTokens.workspaceId, checked.workspaceId),
          eq(runTokens.runId, runId),
          isNull(runTokens.revokedAt),
        ),
      );
    return true;
  };

  const stop = (
    runId: string,
    status: RunStatus,
    set: StopSet,
    statusEventMaxEvents?: number,
  ): Promise<boolean> =>
    db.transaction((tx) => stopIn(tx, runId, status, set, statusEventMaxEvents));

  /** The outcome of a {@link stop}: the run as it now reads, `no-op`, or `not-found`. */
  const settle = async (runId: string, moved: boolean): Promise<RunTransitionOutcome> => {
    const existing = await read(runId);
    if (existing === null) return { kind: 'not-found' };
    return moved ? { kind: 'moved', run: existing } : { kind: 'no-op' };
  };

  const transitions: Pick<
    RunRepository,
    'markRunning' | 'consumeApprovedCall' | 'awaitApproval' | 'finish'
  > = {
    async markRunning(runId: string): Promise<RunTransitionOutcome> {
      const moved = await db
        .update(runs)
        // Only from `queued`. A run already running, paused or terminal is not moved, which
        // is what makes `started_at` stamped exactly once — and a continuation's approvals
        // consumed exactly once, in this commit, before the runner is sent anything (ADR-0151).
        .set({
          status: 'running',
          startedAt: sql`now()`,
          approvalsConsumedAt: sql`case when ${runs.approvedToolCalls} = '[]'::jsonb then null else now() end`,
        })
        .where(
          every(
            tenant,
            eq(runs.id, runId),
            inArray(runs.status, [...runStatusesThatMayMoveTo('running')]),
          ),
        )
        .returning({ id: runs.id });
      if (moved.length > 0) {
        const run = await read(runId);
        if (run === null) throw new Error(`run ${runId} vanished between update and read`);
        return { kind: 'moved', run };
      }
      // Nothing moved. Two different facts, and they are told apart by a read rather than
      // assumed: the run is not queued, or there is no such run in this workspace.
      const existing = await read(runId);
      return existing === null ? { kind: 'not-found' } : { kind: 'no-op' };
    },
    async consumeApprovedCall(
      runId: string,
      call: ApprovalCall,
    ): Promise<ConsumeApprovedCallOutcome> {
      // Persisted and caller JSON is `unknown` until parsed; the SQL below only ever sees the
      // two-key shape.
      const wanted = JSON.stringify(parseApprovalCall(call));
      const element = sql`jsonb_build_array(${wanted}::jsonb)`;
      // One conditional update. PostgreSQL locks the row, so of two concurrent callers the
      // second re-evaluates `consumed_tool_calls` against the committed row and moves nothing.
      const moved = await db
        .update(runs)
        .set({ consumedToolCalls: sql`${runs.consumedToolCalls} || ${element}` })
        .where(
          every(
            tenant,
            eq(runs.id, runId),
            eq(runs.status, 'running'),
            sql`${runs.approvedToolCalls} @> ${element}`,
            sql`not (${runs.consumedToolCalls} @> ${element})`,
          ),
        )
        .returning({ id: runs.id });
      if (moved.length > 0) return 'consumed';
      const existing = await read(runId);
      const used = existing?.consumedToolCalls?.some(
        (consumed) =>
          consumed.toolName === call.toolName && consumed.canonicalCall === call.canonicalCall,
      );
      return existing?.status === 'running' && used === true ? 'already-used' : 'not-approved';
    },
    async awaitApproval(
      runId: string,
      call: ApprovalCall,
      statusEventMaxEvents?: number,
    ): Promise<RunTransitionOutcome> {
      const pendingApproval = parseApprovalCall(call);
      const moved = await stop(
        runId,
        'awaiting_approval',
        { error: null, pendingApproval },
        statusEventMaxEvents,
      );
      return settle(runId, moved);
    },
    async finish(
      runId: string,
      status: RunStatus,
      error: string | null,
      statusEventMaxEvents?: number,
      output?: RunOutput | null,
    ): Promise<RunTransitionOutcome> {
      if (!isTerminalRunStatus(status)) {
        throw new Error(`${status} is not a terminal run status`);
      }
      if (output != null && status !== 'completed') {
        throw new Error(`a run that ended ${status} cannot carry an output`);
      }
      if (
        statusEventMaxEvents !== undefined &&
        (!Number.isSafeInteger(statusEventMaxEvents) || statusEventMaxEvents < 1)
      ) {
        throw new Error('status event retention must be a positive safe integer');
      }
      const moved = await stop(
        runId,
        status,
        {
          error,
          output:
            output == null ? null : { text: output.text, structured: output.structured ?? null },
        },
        statusEventMaxEvents,
      );
      return settle(runId, moved);
    },
  };
  return { stopIn, transitions };
}
