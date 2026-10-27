/**
 * The run and session repositories — the second instance of `./scope.ts`'s shape, and the one
 * that shows what the shape does when a table has referential obligations.
 *
 * ## What is here and what is deliberately not
 *
 * A run's **record** is a row in `runs`, while its replayable event log is stored in `run_events`.
 * Both repositories are workspace scoped. Event sequence allocation is serialized per run so an
 * SSE cursor remains contiguous even when several web processes append concurrently.
 *
 * ## Why a session repository lives here at all
 *
 * `runs.session_id` is `NOT NULL` and is tenant-paired to `sessions (id, workspace_id)`, so a run
 * row cannot exist without a session row. Wave 1 minted a session id per run and stored nothing —
 * `apps/web/instrumentation.ts` says so — which is fine against a `Map` and impossible against the
 * foreign key. {@link SessionRepository} therefore does the **minimum the `runs` table demands**:
 * it makes the row exist.
 *
 * It is emphatically **not** W2-CP-07's `SessionStore`. That task's brief is durable session
 * *state* — the conversation, the Claude session id, resume after a process kill — and it owns
 * `apps/web/server/sessions/**`, which this task does not touch. What is here is a repository
 * primitive that W2-CP-07 builds on: three columns, one upsert, no state, no resume.
 * `docs/adr/W2-DB-02-a-run-needs-a-session-row.md` draws the line.
 */
import {
  desc,
  eq,
  gte,
  isNull,
  lt,
  lte,
  inArray,
  max,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Database } from '../client.js';
import { agentVersions } from '../schema/agent-versions.js';
import { engineIds, type EngineId } from '../schema/agents.js';
import { auditEvents } from '../schema/audit-events.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { modelProviders } from '../schema/model-connections.js';
import { runEvents } from '../schema/run-events.js';
import { runUsageRecords, wireProtocols } from '../schema/run-usage-records.js';
import { runTokens } from '../schema/run-tokens.js';
import { shareRunCharges } from '../schema/share-run-charges.js';
import { shares } from '../schema/shares.js';
import {
  runs,
  runStatuses,
  stoppedRunStatuses,
  terminalRunStatuses,
  type AccountingState,
  type RunStatus,
} from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import {
  FOREIGN_KEY_VIOLATION,
  LIST_RUN_COLUMNS,
  RUN_COLUMNS,
  RUN_CONTINUATION_INDEX,
  RUN_IDEMPOTENCY_KEY_INDEX,
  RUN_PRIMARY_KEY,
  scopedIdempotencyKey,
  RUN_SESSION_CONSTRAINT,
  UNIQUE_VIOLATION,
  UUID_PATTERN,
  every,
  isTerminalRunStatus,
  parseApprovalCall,
  parseApprovalCalls,
  runStatusesThatMayMoveTo,
  sameIdSet,
  toRunRecord,
  violatedBy,
} from './runs/rows.js';
import type {
  ApprovalCall,
  ConsumeApprovedCallOutcome,
  CreateRunInput,
  CreateRunOutcome,
  ListRunsInput,
  RecordRunToolSandboxOutcome,
  RecordRunUsageOutcome,
  RunListPage,
  RunOutput,
  RunRecord,
  RunRepository,
  RunRepositoryProvider,
  RunTransitionOutcome,
  SnapshotRunModelInput,
  SnapshotRunModelOutcome,
  SnapshotRunToolsOutcome,
  UsageCostWindow,
} from './runs/types.js';

export { runStatuses, terminalRunStatuses };
export type { RunStatus };

// ADR-0065's engine vocabulary, re-exported from the schema the same way `runStatuses` is:
// `runs.engine` and `sessions.engine` both carry it, and a caller outside `packages/core` can
// only reach the schema through this layer.
export { engineIds };
export type { EngineId };

export { isTerminalRunStatus } from './runs/rows.js';
export type {
  CreateRunInput,
  RecordRunToolSandboxOutcome,
  RecordRunUsageInput,
  RecordRunUsageOutcome,
  RunEventRepository,
  RunEventRepositoryProvider,
  RunOutput,
  RunRecord,
  RunRepository,
  RunRepositoryProvider,
  RunTransitionOutcome,
  CreateRunOutcome,
  SnapshotRunToolsOutcome,
  SessionRecord,
  StoredRunEvent,
} from './runs/types.js';
export { createDatabaseRunEventRepositoryProvider } from './runs/events.js';
export type {
  EnsureSessionInput,
  EnsureSessionOutcome,
  SessionMutationOutcome,
  SessionRepository,
  SessionRepositoryProvider,
  SessionVisibility,
  UpdateSessionInput,
} from './runs/sessions.js';
export { createDatabaseSessionRepositoryProvider } from './runs/sessions.js';
export {
  isWorkspaceMember,
  listRunsNeedingAccountingReconciliation,
  listStaleRunIds,
} from './runs/queries.js';

/** How long a paused run waits for a decision before a late one cancels it (ADR-0145 D2.4). */
const APPROVAL_WINDOW_HOURS = 24;

/** The stored reason of a paused run cancelled because nobody decided in time. */
const APPROVAL_EXPIRED_ERROR =
  'approval_expired: no decision was made within 24 hours, so the request was rejected';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

interface StopSet {
  readonly error: string | null;
  readonly pendingApproval?: ApprovalCall;
  /** Written only when given: a pause leaves the column alone. */
  readonly output?: RunOutput | null;
}

/** The largest `limit` a caller may request in one page. */
const MAX_RUN_LIST_LIMIT = 200;

/** The PostgreSQL {@link RunRepositoryProvider}. */
export function createDatabaseRunRepositoryProvider(db: Database): RunRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): RunRepository {
      // The run-time half of the scope gate, before any predicate is built. See `./scope.ts`:
      // an `as WorkspaceScope` cast and `Object.create(WorkspaceScope.prototype)` both compile,
      // and until verification round 1 nothing refused either of them.
      const checked = requireWorkspaceScope(scope, 'RunRepositoryProvider');
      const tenant = eq(runs.workspaceId, checked.workspaceId);

      /** One run by id, tenant-filtered, with its agent joined in. */
      const read = async (runId: string): Promise<RunRecord | null> => {
        const rows = await db
          .select({
            ...RUN_COLUMNS,
            outputSchema: runs.outputSchema,
            prompt: runs.prompt,
            subject: runs.subject,
          })
          .from(runs)
          // The join is tenant-paired as well as id-paired. `runs_session_workspace_fk` already
          // guarantees the two workspaces agree, so this cannot change which row is found; it is
          // written out so the query says the invariant rather than relying on it.
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
          .where(every(tenant, eq(runs.id, runId)))
          .limit(1);
        const row = rows[0];
        return row === undefined ? null : toRunRecord(row);
      };

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

      return {
        async create(input: CreateRunInput): Promise<CreateRunOutcome> {
          const approvedToolCalls = parseApprovalCalls(input.approvedToolCalls ?? []);
          const decides = input.decides;
          try {
            const refused = await db.transaction(async (tx): Promise<CreateRunOutcome | null> => {
              // Session project assignment and run creation share this lock. A run cannot enter
              // between moveSession's no-runs check and its project update, and two creates on
              // one session cannot both pass the busy check below.
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${input.sessionId}, 1))`,
              );
              if (decides !== undefined) {
                // Session lock first, then the run lock: the paused run cannot move between this
                // read and the update below. A paused run is not session-busy, so the session
                // lock is what serialises two concurrent decisions.
                await tx.execute(
                  sql`select pg_advisory_xact_lock(hashtextextended(${decides.runId}, 0))`,
                );
                const paused = await tx
                  .select({
                    expired: sql<boolean>`${runs.approvalDeadlineAt} < now()`,
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
                outputSchema: input.outputSchema ?? null,
                subject: input.subject ?? null,
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
            if (
              decides !== undefined &&
              violatedBy(error, UNIQUE_VIOLATION, RUN_CONTINUATION_INDEX)
            ) {
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

        get: read,

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
                output == null
                  ? null
                  : { text: output.text, structured: output.structured ?? null },
            },
            statusEventMaxEvents,
          );
          return settle(runId, moved);
        },

        async snapshotModel(
          runId: string,
          input: SnapshotRunModelInput,
        ): Promise<SnapshotRunModelOutcome> {
          const rows = await db
            .update(runs)
            .set({
              model: input.model,
              provider: input.provider,
              modelConnectionId: input.connectionId,
            })
            .where(every(tenant, eq(runs.id, runId)))
            .returning({ id: runs.id });
          return rows.length > 0 ? { kind: 'updated' } : { kind: 'not-found' };
        },

        async snapshotTools(
          runId: string,
          connectorIds: readonly string[],
        ): Promise<SnapshotRunToolsOutcome> {
          // A string that is not a UUID names no run and no connector, so it is answered here as
          // `not-found` / `unknown-connectors` rather than reaching the database as a 22P02.
          if (!UUID_PATTERN.test(runId)) return { kind: 'not-found' };
          const malformed = connectorIds.filter((id) => !UUID_PATTERN.test(id));
          if (malformed.length > 0) {
            return { kind: 'unknown-connectors', connectorIds: [...new Set(malformed)].sort() };
          }
          // The canonical set: lower-case (PostgreSQL's own rendering), distinct, sorted.
          const wanted = [...new Set(connectorIds.map((id) => id.toLowerCase()))].sort();
          return db.transaction(async (tx): Promise<SnapshotRunToolsOutcome> => {
            // Lock the run row so the decision below and the write are one step: two concurrent
            // calls serialise here instead of both deciding on the same stale row.
            const locked = await tx
              .select({ status: runs.status, toolConnectorIds: runs.toolConnectorIds })
              .from(runs)
              .where(every(tenant, eq(runs.id, runId)))
              .limit(1)
              .for('update');
            const run = locked[0];
            if (run === undefined) return { kind: 'not-found' };
            // The run already carries exactly this set: answer before re-validating, so a retry
            // after launch (or after a connector in the set was deleted) still succeeds.
            if (sameIdSet(run.toolConnectorIds, wanted)) {
              return { kind: 'snapshotted', toolConnectorIds: wanted };
            }
            if (run.status !== 'queued') return { kind: 'not-queued' };
            if (wanted.length > 0) {
              // One `uuid[]` parameter, not one parameter per id, so no set size can overflow the
              // protocol's bind-parameter count.
              const found = await tx
                .select({ id: mcpServers.id })
                .from(mcpServers)
                .where(
                  every(
                    eq(mcpServers.workspaceId, checked.workspaceId),
                    sql`${mcpServers.id} = ANY(${sql.param(wanted)}::uuid[])`,
                    ne(mcpServers.kind, 'mcp'),
                  ),
                );
              const known = new Set(found.map((row) => row.id));
              const unknown = wanted.filter((id) => !known.has(id));
              if (unknown.length > 0) return { kind: 'unknown-connectors', connectorIds: unknown };
            }
            await tx
              .update(runs)
              .set({ toolConnectorIds: wanted })
              .where(every(tenant, eq(runs.id, runId)));
            return { kind: 'snapshotted', toolConnectorIds: wanted };
          });
        },

        async recordToolSandbox(
          runId: string,
          origin: string,
        ): Promise<RecordRunToolSandboxOutcome> {
          if (!UUID_PATTERN.test(runId)) return { kind: 'not-found' };
          const moved = await db
            .update(runs)
            .set({ toolSandboxOrigin: origin })
            .where(every(tenant, eq(runs.id, runId), eq(runs.status, 'queued')))
            .returning({ id: runs.id });
          if (moved.length > 0) return { kind: 'recorded' };
          const existing = await read(runId);
          if (existing === null) return { kind: 'not-found' };
          return existing.toolSandboxOrigin === origin
            ? { kind: 'recorded' }
            : { kind: 'not-queued' };
        },

        async snapshotFileGrants(runId: string, paths: readonly string[]): Promise<boolean> {
          if (!UUID_PATTERN.test(runId)) return false;
          const wanted = [...new Set(paths)].sort();
          const moved = await db
            .update(runs)
            .set({ fileGrants: wanted })
            .where(every(tenant, eq(runs.id, runId), eq(runs.status, 'queued')))
            .returning({ id: runs.id });
          if (moved.length > 0) return true;
          // A retry after launch records nothing new; it succeeds only if the set is unchanged.
          const existing = await read(runId);
          return existing !== null && sameIdSet(existing.fileGrants ?? [], wanted);
        },

        async recordUsage(runId, input): Promise<RecordRunUsageOutcome> {
          const counters = [
            input.inputTokens,
            input.outputTokens,
            input.cacheReadInputTokens,
            input.cacheCreationInputTokens,
            input.toolCalls,
          ];
          if (counters.some((value) => !Number.isSafeInteger(value) || value < 0)) {
            throw new Error('run usage counters must be non-negative safe integers');
          }
          if (!/^\d{1,8}\.\d{6}$/u.test(input.costUsd)) {
            throw new Error('run usage costUsd must be a non-negative decimal with six places');
          }
          if (
            input.providerResponseId.length === 0 ||
            !(modelProviders as readonly string[]).includes(input.provider) ||
            !(wireProtocols as readonly string[]).includes(input.wireProtocol) ||
            input.model.length === 0 ||
            (input.priceTableVersion !== null && input.priceTableVersion.length === 0)
          ) {
            throw new Error(
              'run usage identity, provider, wire protocol and model are required, and a price version must not be empty when present',
            );
          }

          const outcome = await db.transaction(async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${runId}, 0))`);
            const current = await tx
              .select({ id: runs.id, priceTableVersion: runs.priceTableVersion })
              .from(runs)
              .where(every(tenant, eq(runs.id, runId)))
              .limit(1);
            const existingRun = current[0];
            if (existingRun === undefined) return { kind: 'not-found' } as const;
            // Two catalogue versions may only disagree when both settlements actually priced
            // something. An unpriced attempt (this one, or the one already on the row) carries no
            // catalogue opinion, so it can never conflict with a real one.
            if (
              input.priceTableVersion !== null &&
              existingRun.priceTableVersion !== null &&
              existingRun.priceTableVersion !== input.priceTableVersion
            ) {
              return {
                kind: 'price-version-conflict',
                existingVersion: existingRun.priceTableVersion,
              } as const;
            }

            // Same lock covers this read: a concurrent retry of the identical response id cannot
            // observe a state between the two statements below.
            const existingLedgerRows = await tx
              .select({
                id: runUsageRecords.id,
                priceTableVersion: runUsageRecords.priceTableVersion,
                costUsd: runUsageRecords.costUsd,
              })
              .from(runUsageRecords)
              .where(
                every(
                  eq(runUsageRecords.runId, runId),
                  eq(runUsageRecords.providerResponseId, input.providerResponseId),
                ),
              )
              .limit(1);
            const existingLedgerRow = existingLedgerRows[0];

            // Token counts are added only for a response this ledger has never seen. A "late
            // arrival" — the same response id, now priced, that first landed unpriced — updates
            // the existing row's price and cost in place rather than adding a second copy of
            // tokens that were already counted.
            let addTokens = false;
            let costDelta: SQL;
            if (existingLedgerRow === undefined) {
              await tx.insert(runUsageRecords).values({
                workspaceId: checked.workspaceId,
                runId,
                providerResponseId: input.providerResponseId,
                provider: input.provider,
                model: input.model,
                inputTokens: input.inputTokens,
                outputTokens: input.outputTokens,
                cacheReadInputTokens: input.cacheReadInputTokens,
                cacheCreationInputTokens: input.cacheCreationInputTokens,
                toolCalls: input.toolCalls,
                wireProtocol: input.wireProtocol,
                costUsd: input.costUsd,
                costCurrency: input.costCurrency,
                priceTableVersion: input.priceTableVersion,
              });
              addTokens = true;
              costDelta = sql`${input.costUsd}::numeric`;
            } else if (
              existingLedgerRow.priceTableVersion !== null ||
              input.priceTableVersion === null
            ) {
              // Already priced (a genuine retry — nothing new to contribute), or this attempt has
              // no price to offer an already-unpriced row. Either way, a no-op duplicate.
              return { kind: 'duplicate' } as const;
            } else {
              await tx
                .update(runUsageRecords)
                .set({ priceTableVersion: input.priceTableVersion, costUsd: input.costUsd })
                .where(eq(runUsageRecords.id, existingLedgerRow.id));
              costDelta = sql`(${input.costUsd}::numeric - ${existingLedgerRow.costUsd}::numeric)`;
            }

            const ledgerRows = await tx
              .select({ priceTableVersion: runUsageRecords.priceTableVersion })
              .from(runUsageRecords)
              .where(
                every(
                  eq(runUsageRecords.workspaceId, checked.workspaceId),
                  eq(runUsageRecords.runId, runId),
                ),
              );
            const pricedCount = ledgerRows.filter((row) => row.priceTableVersion !== null).length;
            const accountingState: AccountingState =
              pricedCount === 0
                ? 'unavailable'
                : pricedCount === ledgerRows.length
                  ? 'complete'
                  : 'partial';

            await tx
              .update(runs)
              .set({
                provider: input.provider,
                model: input.model,
                ...(addTokens
                  ? {
                      inputTokens: sql`${runs.inputTokens} + ${input.inputTokens}`,
                      outputTokens: sql`${runs.outputTokens} + ${input.outputTokens}`,
                      cacheReadInputTokens: sql`${runs.cacheReadInputTokens} + ${input.cacheReadInputTokens}`,
                      cacheCreationInputTokens: sql`${runs.cacheCreationInputTokens} + ${input.cacheCreationInputTokens}`,
                      toolCalls: sql`${runs.toolCalls} + ${input.toolCalls}`,
                    }
                  : {}),
                costUsd: sql`${runs.costUsd} + ${costDelta}`,
                costCurrency: input.costCurrency,
                // A priced attempt sets the run's catalogue version; an unpriced one leaves
                // whatever was already there rather than blanking out a prior priced value.
                priceTableVersion: input.priceTableVersion ?? sql`${runs.priceTableVersion}`,
                accountingState,
                accountingError: null,
              })
              .where(every(tenant, eq(runs.id, runId)));

            // A public run is linked before it is launched. Advancing its charge beside the run
            // aggregate makes the provider-response ledger the single accounting source: a
            // duplicate response returns above, while a late priced response contributes only
            // its delta. Different responses for this run share the advisory lock.
            const linkedCharges = await tx
              .update(shareRunCharges)
              .set({ chargedUsd: sql`${shareRunCharges.chargedUsd} + ${costDelta}` })
              .where(
                every(
                  eq(shareRunCharges.workspaceId, checked.workspaceId),
                  eq(shareRunCharges.runId, runId),
                ),
              )
              .returning({ shareId: shareRunCharges.shareId });
            const linkedCharge = linkedCharges[0];
            if (linkedCharge !== undefined) {
              await tx
                .update(shares)
                .set({ spentUsd: sql`${shares.spentUsd} + ${costDelta}` })
                .where(
                  every(
                    eq(shares.workspaceId, checked.workspaceId),
                    eq(shares.id, linkedCharge.shareId),
                  ),
                );
              // The spend update locks the share row. Exactly one concurrent settlement can
              // move `stopped` from false to true and therefore exactly one audit row is written.
              const stopped = await tx
                .update(shares)
                .set({ stopped: true })
                .where(
                  every(
                    eq(shares.workspaceId, checked.workspaceId),
                    eq(shares.id, linkedCharge.shareId),
                    eq(shares.stopped, false),
                    sql`${shares.budgetCapUsd} is not null`,
                    sql`${shares.spentUsd} >= ${shares.budgetCapUsd}`,
                  ),
                )
                .returning({ id: shares.id, subjectLabel: shares.subjectLabel });
              const stoppedShare = stopped[0];
              if (stoppedShare !== undefined) {
                await tx.insert(auditEvents).values({
                  workspaceId: checked.workspaceId,
                  actorUserId: null,
                  actorLabel: 'Budget guard',
                  action: 'runnable-link-stopped',
                  subjectId: stoppedShare.id,
                  subjectLabel: stoppedShare.subjectLabel,
                });
              }
            }
            return { kind: 'recorded' } as const;
          });
          if (outcome.kind === 'not-found' || outcome.kind === 'price-version-conflict') {
            return outcome;
          }
          const run = await read(runId);
          if (run === null) throw new Error(`run ${runId} vanished after usage settlement`);
          return { kind: outcome.kind, run };
        },

        async markAccountingFailed(runId, reason): Promise<RunTransitionOutcome> {
          const moved = await db
            .update(runs)
            // Only from `pending`: a run with any settled usage already (`complete` / `partial` /
            // `unavailable`) is not regressed by one later, separately unmeasurable response.
            .set({ accountingState: 'failed', accountingError: reason })
            .where(every(tenant, eq(runs.id, runId), eq(runs.accountingState, 'pending')))
            .returning({ id: runs.id });
          if (moved.length > 0) {
            const run = await read(runId);
            if (run === null) throw new Error(`run ${runId} vanished between update and read`);
            return { kind: 'moved', run };
          }
          const existing = await read(runId);
          return existing === null ? { kind: 'not-found' } : { kind: 'no-op' };
        },

        async listRuns(input: ListRunsInput): Promise<RunListPage> {
          if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
            throw new Error('listRuns limit must be a safe positive integer');
          }
          if (input.limit > MAX_RUN_LIST_LIMIT) {
            throw new Error(`listRuns limit must not exceed ${String(MAX_RUN_LIST_LIMIT)}`);
          }
          const filter = input.filter ?? {};
          const predicates: SQL[] = [tenant];
          if (filter.status !== undefined) predicates.push(eq(runs.status, filter.status));
          if (filter.agentId !== undefined) predicates.push(eq(sessions.agentId, filter.agentId));
          if (filter.projectId !== undefined) {
            predicates.push(eq(sessions.projectId, filter.projectId));
          }
          if (filter.provider !== undefined) predicates.push(eq(runs.provider, filter.provider));
          if (filter.model !== undefined) predicates.push(eq(runs.model, filter.model));
          if (filter.createdFrom !== undefined) {
            predicates.push(gte(runs.createdAt, filter.createdFrom));
          }
          if (filter.createdTo !== undefined) {
            // Inclusive at the millisecond, which is the whole precision `createdTo` can carry
            // and the precision every rendered `createdAt` has. A plain `created_at <= createdTo`
            // compares microseconds against a millisecond-truncated bound, so a run created in
            // the last 999 µs of the bound's millisecond fell outside a range built from its own
            // rendered timestamp (round 3 finding 5). `< createdTo + 1 ms` is that same inclusive
            // bound, with `created_at` left bare for an index to use. `createdFrom` needs no
            // shift: for a millisecond-aligned bound, `created_at >= from` and
            // `floor_ms(created_at) >= from` already agree.
            //
            // The millisecond is added by PostgreSQL, not by `Date`: `createdTo` is bound as the
            // exact text `toISOString` prints for it, and the arithmetic happens past the point
            // where a JS `Date` would have to print year 10000 in the signed six-digit form
            // PostgreSQL refuses. `to=9999-12-31T23:59:59.999Z` is a legal bound; adding the
            // millisecond in JS first turned it into a thrown query (round 4 finding 2).
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
          if (cursor !== null) {
            // Newest-first keyset pagination: strictly before the boundary row in the same total
            // order the query is sorted by. `id` breaks a tie on `created_at` alone, which is what
            // makes the boundary a single row rather than a moment in time — issue #135's page-2
            // request must not re-see, or skip, a row that shares its predecessor's timestamp.
            //
            // The boundary is compared at the database's own precision, not the millisecond
            // precision a `Date` would give: `cursor.createdAt` is the exact text `listRuns`
            // printed for the previous page's last row (see `LIST_RUN_COLUMNS`), cast straight
            // back to `timestamptz` here rather than round-tripped through a JS `Date` first, so a
            // row whose `created_at` differs from the boundary only below one millisecond is still
            // correctly ordered against it (round 2 finding 1) — that includes two rows created in
            // the same statement, which share the identical instant and are told apart by `id`
            // alone, exactly as this predicate already does for a millisecond-level tie.
            const boundary = sql`${cursor.createdAt}::timestamptz`;
            const beforeBoundary = or(
              lt(runs.createdAt, boundary),
              every(eq(runs.createdAt, boundary), lt(runs.id, cursor.id)),
            );
            if (beforeBoundary === undefined) {
              throw new Error('the cursor predicate could not be built');
            }
            predicates.push(beforeBoundary);
          }
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
          return { costUsd: row?.total ?? '0', unpricedUsage: row?.unpriced ?? false };
        },
      };
    },
  };
}

/**
 * Which workspace a run belongs to, by run id **alone**.
 *
 * ## This is the one query in the repository layer that is not workspace-scoped
 *
 * It is here, named, exported and documented rather than hidden inside an adapter, because a
 * reader of this layer should meet it as a declared exception and not as a pattern to copy. Six
 * Wave 2 tracks are about to imitate this directory; the thing they must imitate is
 * {@link RunRepositoryProvider.forScope}, not this.
 *
 * The reason it exists is a port this task does not own. `apps/web/server/runs/store.ts`'s
 * `RunStore` identifies a run by id alone — `get`, `markRunning`, `finish`, `append` and
 * `openStream` take no workspace — because W1-CP-04 wrote it that way and `api.ts` filters
 * afterwards by comparing `run.workspaceId` to the principal's. Converting that port means editing
 * the three §34 run route handlers, which are outside this task's ownership globs;
 * `docs/adr/W2-DB-02-the-run-port-is-not-scope-bound.md` records the decision to declare it rather
 * than reach for them.
 *
 * What limits the damage is what this returns: a workspace id and **nothing else**. No run row, no
 * status, no error text, no timestamps. A caller learns which scope to build; every query it then
 * issues goes through {@link RunRepository}, filtered on that scope. And an id that names no run
 * answers `null`, which every caller turns into "not found" — never into an unscoped read.
 */
export async function findRunWorkspace(db: Database, runId: string): Promise<string | null> {
  const rows = await db
    .select({ workspaceId: runs.workspaceId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : row.workspaceId;
}
