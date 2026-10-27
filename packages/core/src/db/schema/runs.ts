/**
 * `runs` — one execution of one agent inside a session (spec §27, §35).
 *
 * §35 lists what a run must record: "run / session / agent / model / provider / status /
 * duration / input tokens / output tokens / estimated cost / tool calls / errors". Two of
 * those are deliberately not columns:
 *
 *   * **agent** — a run always belongs to a session, and §19.5 rule 4 fixes a session to one
 *     agent ("Switching the agent mid-conversation starts a new session"). A second copy of
 *     `agent_id` here could disagree with `sessions.agent_id` and nothing in the schema would
 *     stop it, so the run reaches its agent through `session_id`. One join, no way to be wrong.
 *   * **duration** — `ended_at - started_at`. A stored duration is a third value that can
 *     contradict the two it is derived from.
 *
 * `model` and `provider` ARE stored, even though they are reachable through the agent's model
 * connection, because they are history: the connection can be edited or deleted after the run,
 * and a run record that changes retroactively is not a record.
 */
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { RUN_STATUSES } from '@indx-workspace/contracts/runs';

import { engineIds } from './agents.js';
import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { modelConnections, modelProviders } from './model-connections.js';
import { oneOf, renderValueList } from './one-of.js';
import { sessions } from './sessions.js';
import { workspaces } from './workspaces.js';

/**
 * The run lifecycle. `cancelled` is distinct from `failed` because §14.3's runtime contract
 * has an interrupt: a user pressing stop is not an error, and a UI that paints it red is
 * lying.
 *
 * `awaiting_approval` is a run that has stopped for a human decision (ADR-0145 D1): its runtime is
 * over, its tokens are revoked, and `pending_approval` names the call it waits on. It is stopped,
 * not terminal: it still moves on, to `completed` (approved and continued elsewhere) or `cancelled`
 * (denied, interrupted or expired). The list is the contract's `RUN_STATUSES` itself.
 */
export const runStatuses = RUN_STATUSES;
export type RunStatus = (typeof runStatuses)[number];

/** The statuses at which a run is over for good. */
export const terminalRunStatuses = ['completed', 'failed', 'cancelled'] as const;

/**
 * The statuses at which the run's runtime is over and `ended_at` must be set: the terminal ones and
 * `awaiting_approval`. A stopped run does not make its session busy.
 */
export const stoppedRunStatuses = [...terminalRunStatuses, 'awaiting_approval'] as const;

/**
 * Whether usage settlement is trustworthy — issue #134, and **deliberately separate** from
 * {@link RunStatus}. A run can reach `status = 'completed'` while its accounting is still
 * `pending`: the runtime's own lifecycle and the gateway's usage capture are different processes
 * racing the same database, and collapsing the two into one column is exactly the false zero this
 * column exists to remove. Before this column existed, `input_tokens = 0` on a `completed` run was
 * indistinguishable from "genuinely used nothing".
 *
 *   * `pending` — no settlement has landed yet (the default). Where a killed gateway process, or a
 *     still-in-flight stream past its settlement timeout, leaves a run.
 *   * `complete` — every usage record captured for this run carries a real price version;
 *     `cost_usd` is an actual, not estimated, figure.
 *   * `partial` — some usage records are priced and some are not.
 *   * `unavailable` — usage was captured but no ledger row for this run has ever been priced;
 *     `cost_usd` stays `0` and the state says that zero is not a measurement.
 *   * `failed` — a settlement attempt could not even produce ledger data (an unmeasurable
 *     provider response, or a settlement write that itself errored). `accounting_error` carries a
 *     redacted reason.
 */
export const accountingStates = [
  'pending',
  'complete',
  'partial',
  'failed',
  'unavailable',
] as const;
export type AccountingState = (typeof accountingStates)[number];

export const runs = pgTable(
  'runs',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /**
     * The reference to the session is **tenant-paired** and declared in the table config below
     * as `runs_session_workspace_fk`, not here: `(session_id, workspace_id)` must point at one
     * row of `sessions (id, workspace_id)`, so a run cannot carry a workspace_id different
     * from its session's.
     */
    sessionId: uuid('session_id').notNull(),
    status: text('status', { enum: runStatuses }).notNull().default('queued'),
    /** The provider-side model id actually used. NULL until the run reports one. */
    model: text('model'),
    /**
     * Which **model** provider served it, recorded at run time. NULL until known.
     *
     * This is not the engine (ADR-0065). It answers "who answered the model call", where
     * {@link engine} below answers "what made the call". The two are independent and both are
     * history: a `claude-agent-sdk` run served by an `openai` connection records both.
     */
    provider: text('provider', { enum: modelProviders }),
    /**
     * The engine that executed the run — the harness that turned the agent and the prompt into
     * model calls (ADR-0065). NULL only for a run recorded before this column existed; migration
     * 0025 deliberately does not backfill it, because nothing ever observed those rows' engine and
     * a guess would be indistinguishable from a measurement (the same reasoning as
     * `accounting_state`'s `unavailable`).
     */
    engine: text('engine', { enum: engineIds }),
    /**
     * The adapter's and third-party SDK's version, as the runner reported it. Opaque: recorded for
     * support, never parsed or compared. NULL for a historic run and for one that failed before the
     * engine answered.
     */
    engineVersion: text('engine_version'),
    /**
     * Which connection resolved this run (issue #129), snapshotted before launch so a queued or
     * failed run identifies what it attempted, not only what a completed one settled to. `SET
     * NULL` on delete: deleting the connection later must not erase the run's own history — the
     * text `model`/`provider` columns above stay exactly as recorded even once this id goes null.
     * Unlike the workspace/project defaults, this is deliberately not paired with `model`/
     * `provider` by a check constraint: a deleted connection legitimately leaves this column NULL
     * while the historical `model`/`provider` text remains.
     */
    modelConnectionId: uuid('model_connection_id').references(() => modelConnections.id, {
      onDelete: 'set null',
    }),
    /**
     * The tool connectors this run may call (ADR-0113 C16): the sorted, distinct ids of tool-kind
     * `mcp_servers` rows in this run's workspace, snapshotted before launch by
     * `RunRepository.snapshotTools`. Empty (the default) for a run that calls no tool connector and
     * for every run recorded before migration 0036.
     *
     * No foreign key: PostgreSQL cannot put one on an array element. The tenancy and the kind of
     * every id are checked by `snapshotTools` at write time, and again by the gateway on every
     * call, which also re-checks that the connector still exists and is enabled — so an id that a
     * deleted connector leaves behind is harmless history. `tenancy.test.ts` rule 3 matches only
     * `*_id` columns, so this `_ids` column is not caught there; this comment states its tenant
     * pairing instead.
     */
    toolConnectorIds: uuid('tool_connector_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /**
     * The workspace file paths this run was granted (ADR-0147): files and folder roots, exactly what
     * the run request carried after the policy ceiling, snapshotted by
     * `RunRepository.snapshotFileGrants` while the run is `queued`. Run-scoped file search answers
     * only from these. Empty (the default) means no grant, and a search then finds nothing.
     *
     * Paths, not file ids, and no foreign key: PostgreSQL cannot put one on an array element, and a
     * path names the same object the run was given. Every search is also confined to the run's own
     * workspace by the tenant-scoped repository, so a path cannot reach another tenant's text.
     */
    fileGrants: text('file_grants')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * The origin of the session's tool sandbox that serves this run's code tools (ADR-0118 TS3),
     * written by the server once while the run is `queued`. The gateway forwards the run's tool
     * calls to it; the run request never carries it, so no caller chooses where the gateway
     * dials. NULL for a run with no code tool and for every run recorded before migration 0045.
     */
    toolSandboxOrigin: text('tool_sandbox_origin'),
    /**
     * The call an `awaiting_approval` run waits on (ADR-0145 D2.1): `{ toolName, canonicalCall }`,
     * where `canonicalCall` is the canonical JSON text of the call. NULL in every other status
     * (`runs_awaiting_approval_has_pending`), and kept as history once the run moves on. Persisted
     * JSON is `unknown`: the repository validates it on write and on read.
     */
    pendingApproval: jsonb('pending_approval'),
    /**
     * When an `awaiting_approval` run stops waiting (ADR-0145 D2.4): 24 hours after it paused,
     * written by the same update that pauses it. A decision that arrives after it cancels the run
     * instead (`approval_expired`). Set in every `awaiting_approval` row
     * (`runs_awaiting_approval_has_deadline`) and kept as history once the run moves on; NULL for a
     * run that never paused.
     */
    approvalDeadlineAt: timestamp('approval_deadline_at', { withTimezone: true, mode: 'date' }),
    /**
     * The calls a continuation run may make without asking again (ADR-0145 D2.1): an array of
     * `{ toolName, canonicalCall }`, each good for one use. `[]` (the default) for every run that
     * is not a continuation. Validated on write and on read, like {@link pendingApproval}.
     */
    approvedToolCalls: jsonb('approved_tool_calls')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * The paused run this run continues (ADR-0145 D2.3, ADR-0151): written once, by the decision
     * that completes that run and inserts this one. NULL for a run that is not a continuation. A
     * paused run has at most one continuation (`runs_continues_run_id_unique`). The reference is
     * tenant-paired, declared below as `runs_continues_run_workspace_fk`.
     */
    continuesRunId: uuid('continues_run_id'),
    /**
     * When this continuation's approved calls were used up (ADR-0151, RF-303): stamped by the same
     * update that moves the run out of `queued`, which happens once and before the runner is sent
     * anything, so the approval is consumed durably before any approved call can execute. NULL for
     * a run with no approved calls and for one not yet started. Nothing clears it, and
     * `runs_consumed_approvals_never_queued` refuses to put such a run back in the queue: a retry
     * would run an approved call a second time, so a continuation the runner accepted is never
     * retried.
     */
    approvalsConsumedAt: timestamp('approvals_consumed_at', { withTimezone: true, mode: 'date' }),
    /**
     * The approved calls that have run (ADR-0145 D2.1, #1541): an array of `{ toolName,
     * canonicalCall }`, each added once, by `consumeApprovedCall` only, in the one update that also
     * checks the call is in {@link approvedToolCalls} and not yet here. So it is a subset of
     * `approved_tool_calls` by construction (no CHECK: it would need jsonb containment in the
     * formal model) and a call is good for one use however many callers race for it. `[]` (the
     * default) until the gateway runs an approved write. Validated on read, like
     * {@link approvedToolCalls}.
     */
    consumedToolCalls: jsonb('consumed_tool_calls')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * The start request's `Idempotency-Key`, prefixed with the acting principal's id
     * (`<principalId>:<key>`), so a key is scoped to one workspace and one principal (ADR-0151,
     * #250). NULL for a run started without one. A paused run keeps it: a replay returns the
     * original run whatever its status, and the key is never freed.
     */
    idempotencyKey: text('idempotency_key'),
    /** The SHA-256 of the start request a key was first used with; set exactly when the key is. */
    idempotencyRequestHash: text('idempotency_request_hash'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadInputTokens: integer('cache_read_input_tokens').notNull().default(0),
    cacheCreationInputTokens: integer('cache_creation_input_tokens').notNull().default(0),
    /**
     * §35's "estimated cost". `numeric`, which R-15 §4 verified reads back into TypeScript as
     * a **string**, not a number — that is the point. Money must not pass through a JavaScript
     * float on its way to a workspace budget (§20.6.3).
     */
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    /** ISO 4217 settlement currency. 0.1.0 pricing is USD-only and says so explicitly. */
    costCurrency: text('cost_currency').notNull().default('USD'),
    /** Immutable catalogue version used to calculate the accumulated cost. */
    priceTableVersion: text('price_table_version'),
    toolCalls: integer('tool_calls').notNull().default(0),
    /** §35's "errors": the failure message, NULL when the run did not fail. */
    error: text('error'),
    /**
     * The prompt the run was started with (issue #620), so a rated run can become an evaluation
     * case. NULL for a run recorded before migration 0042. End-user text: it goes with its run.
     */
    prompt: text('prompt'),
    /**
     * The JSON Schema object the run was asked to answer with (ADR-0143), written once when the
     * run is created. NULL for a run that asked for none and for every run recorded before
     * migration 0054. Opaque here: the public boundary checks its dialect and size.
     */
    outputSchema: jsonb('output_schema').$type<Record<string, unknown>>(),
    /**
     * The caller identity the run was started to act for (ADR-0142 D2), written once when the run
     * is created so an approval continuation can carry it on (ADR-0157). NULL for a run that
     * asserted none and for every run recorded before migration 0067. A person identifier: the same
     * string a trigger stores, never rendered on the run resource.
     */
    subject: text('subject'),
    /**
     * The run's final answer, `{ text, structured }` (ADR-0143), written in the same transaction
     * that moves the run to `completed` and at no other time. NULL until then, for a failed or
     * cancelled run, and for every run recorded before migration 0054.
     */
    output: jsonb('output').$type<{ text: string; structured: unknown }>(),
    /** See {@link AccountingState}. Existing rows are backfilled to `unavailable`, not `complete`
     * — they were never settled by this mechanism, and saying otherwise is the false zero issue
     * #134 removes. */
    accountingState: text('accounting_state', { enum: accountingStates })
      .notNull()
      .default('pending'),
    /** Redacted settlement failure reason. Never provider credentials or response bodies. */
    accountingError: text('accounting_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Tenant index, and the shape the workspace-wide Runs list queries: newest first.
    index('runs_workspace_created_idx').on(table.workspaceId, table.createdAt),
    // §18's agent page shows "Latest Run" for one session's history.
    index('runs_session_created_idx').on(table.sessionId, table.createdAt),
    index('runs_model_connection_idx').on(table.modelConnectionId),
    uniqueIndex('runs_id_workspace_unique').on(table.id, table.workspaceId),
    // ADR-0151: one run per start key. The key already carries the principal.
    uniqueIndex('runs_workspace_idempotency_key_unique')
      .on(table.workspaceId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    // ADR-0151: one continuation per paused run. The decision path already serialises two
    // decisions under the paused run's lock; this makes a second continuation impossible anyway.
    uniqueIndex('runs_continues_run_id_unique')
      .on(table.continuesRunId)
      .where(sql`${table.continuesRunId} is not null`),
    // §25, and the reason `session_id` above carries no reference of its own. The file header
    // refuses to store `agent_id` because "a second copy could disagree with sessions.agent_id
    // and nothing in the schema would stop it". `workspace_id` IS a second copy, of
    // sessions.workspace_id, and this constraint is what stops it: the pair is checked
    // together, so the run's workspace and its session's workspace cannot diverge.
    //
    // `CASCADE` follows sessions' own cascade from agents: a deleted session takes its runs.
    foreignKey({
      columns: [table.sessionId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.workspaceId],
      name: 'runs_session_workspace_fk',
    }).onDelete('cascade'),
    // §25: a run must not be able to record another workspace's connection. No `.onDelete()`
    // action here, matching `agents_model_connection_workspace_fk`'s own pattern (see that
    // constraint's comment): the single-column FK above already carries `SET NULL`, and a
    // composite `SET NULL` would additionally null `workspace_id`, which is `NOT NULL`.
    foreignKey({
      columns: [table.modelConnectionId, table.workspaceId],
      foreignColumns: [modelConnections.id, modelConnections.workspaceId],
      name: 'runs_model_connection_workspace_fk',
    }),
    // A continuation continues a run of its own workspace. No `.onDelete()` action, like
    // `workspace_principals_acts_for_workspace_fk`: both runs belong to one session, so the
    // session's cascade removes them together, and nothing deletes a single run.
    foreignKey({
      columns: [table.continuesRunId, table.workspaceId],
      foreignColumns: [table.id, table.workspaceId],
      name: 'runs_continues_run_workspace_fk',
    }),
    oneOf('runs_status_valid', table.status, runStatuses, { snake: true }),
    oneOf('runs_provider_valid', table.provider, modelProviders),
    oneOf('runs_engine_valid', table.engine, engineIds),
    oneOf('runs_accounting_state_valid', table.accountingState, accountingStates),
    // A stopped run has an end time and a running one does not. Without this, a
    // `completed` run with a NULL `ended_at` renders a duration of "NaN s" in the UI — the
    // exact class of failure ADR-0015 is about, moved one layer earlier so it cannot
    // reach the renderer.
    check(
      'runs_ended_at_iff_terminal',
      sql`(${table.status} in ${sql.raw(renderValueList(stoppedRunStatuses, { snake: true }))}) = (${table.endedAt} is not null)`,
    ),
    check(
      'runs_awaiting_approval_has_pending',
      sql`${table.status} <> 'awaiting_approval' or ${table.pendingApproval} is not null`,
    ),
    check(
      'runs_awaiting_approval_has_deadline',
      sql`${table.status} <> 'awaiting_approval' or ${table.approvalDeadlineAt} is not null`,
    ),
    check(
      'runs_consumed_approvals_never_queued',
      sql`${table.approvalsConsumedAt} is null or ${table.status} <> 'queued'`,
    ),
    check(
      'runs_idempotency_key_has_hash',
      sql`(${table.idempotencyKey} is null) = (${table.idempotencyRequestHash} is null)`,
    ),
    check(
      'runs_output_only_when_completed',
      sql`${table.output} is null or ${table.status} = 'completed'`,
    ),
    check(
      'runs_ended_after_started',
      sql`${table.endedAt} is null or ${table.startedAt} is null or ${table.endedAt} >= ${table.startedAt}`,
    ),
    check(
      'runs_counters_non_negative',
      sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0 and ${table.cacheReadInputTokens} >= 0 and ${table.cacheCreationInputTokens} >= 0 and ${table.toolCalls} >= 0 and ${table.costUsd} >= 0`,
    ),
    check('runs_cost_currency_usd', sql`${table.costCurrency} = 'USD'`),
    check(
      'runs_price_version_matches_accounting_state',
      sql`(${table.accountingState} in ('complete', 'partial')) = (${table.priceTableVersion} is not null)`,
    ),
    check(
      'runs_unpriced_cost_zero',
      sql`${table.accountingState} in ('complete', 'partial') or ${table.costUsd} = 0`,
    ),
  ],
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
