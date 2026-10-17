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
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
 */
export const runStatuses = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof runStatuses)[number];

/** The statuses at which a run is over and `ended_at` must be set. */
export const terminalRunStatuses = ['completed', 'failed', 'cancelled'] as const;

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
     * The origin of the session's tool sandbox that serves this run's code tools (ADR-0118 TS3),
     * written by the server once while the run is `queued`. The gateway forwards the run's tool
     * calls to it; the run request never carries it, so no caller chooses where the gateway
     * dials. NULL for a run with no code tool and for every run recorded before migration 0045.
     */
    toolSandboxOrigin: text('tool_sandbox_origin'),
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
    oneOf('runs_status_valid', table.status, runStatuses),
    oneOf('runs_provider_valid', table.provider, modelProviders),
    oneOf('runs_engine_valid', table.engine, engineIds),
    oneOf('runs_accounting_state_valid', table.accountingState, accountingStates),
    // A finished run has an end time and an unfinished one does not. Without this, a
    // `completed` run with a NULL `ended_at` renders a duration of "NaN s" in the UI — the
    // exact class of failure ADR-0015 is about, moved one layer earlier so it cannot
    // reach the renderer.
    check(
      'runs_ended_at_iff_terminal',
      sql`(${table.status} in ${sql.raw(renderValueList(terminalRunStatuses))}) = (${table.endedAt} is not null)`,
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
