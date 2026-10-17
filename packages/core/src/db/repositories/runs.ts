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
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  lte,
  max,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Database } from '../client.js';
import { engineIds, type EngineId } from '../schema/agents.js';
import { auditEvents } from '../schema/audit-events.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { memberships } from '../schema/memberships.js';
import { modelProviders, type ModelProvider } from '../schema/model-connections.js';
import { runEvents } from '../schema/run-events.js';
import { runUsageRecords, wireProtocols, type WireProtocol } from '../schema/run-usage-records.js';
import { runTokens } from '../schema/run-tokens.js';
import { shareRunCharges } from '../schema/share-run-charges.js';
import { shares } from '../schema/shares.js';
import {
  accountingStates,
  runs,
  runStatuses,
  terminalRunStatuses,
  type AccountingState,
  type RunStatus,
} from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import {
  afterPosition,
  assertPageLimit,
  keysetTimestamp,
  toKeysetPage,
  type KeysetPage,
  type KeysetPosition,
} from './keyset.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import { postgresViolations } from './violations.js';

export { runStatuses, terminalRunStatuses };
export type { RunStatus };

// ADR-0065's engine vocabulary, re-exported from the schema the same way `runStatuses` is:
// `runs.engine` and `sessions.engine` both carry it, and a caller outside `packages/core` can
// only reach the schema through this layer.
export { engineIds };
export type { EngineId };

/** The statuses at which a run is over, as a set, so membership is a lookup and not a scan. */
const TERMINAL: ReadonlySet<string> = new Set(terminalRunStatuses);

/** True for a status at which the run is over and `ended_at` must be set. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * One run, as the control plane reads it.
 *
 * `agentId` is **not** a column on `runs` — the schema refuses to store a second copy of it,
 * because it could disagree with `sessions.agent_id`. It is read through the join every time, so
 * the record can carry it without the table carrying it twice.
 */
export interface RunRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly status: RunStatus;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly model: string | null;
  /** The **model** provider that served the calls, never the engine that made them. */
  readonly provider: string | null;
  /** Which connection resolved this run (issue #129). NULL until resolved, or once deleted. */
  readonly modelConnectionId: string | null;
  /** The engine that executed the run (ADR-0065). NULL only for a run recorded before 0024. */
  readonly engine: EngineId | null;
  /** The adapter and third-party SDK version the runner reported. Opaque; NULL when unreported. */
  readonly engineVersion: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly toolCalls: number;
  readonly costUsd: string;
  readonly costCurrency: 'USD';
  readonly priceTableVersion: string | null;
  readonly error: string | null;
  /** See `schema/runs.ts`'s {@link AccountingState}. */
  readonly accountingState: AccountingState;
  /** Redacted settlement failure reason. Non-null only when `accountingState` is `'failed'`. */
  readonly accountingError: string | null;
  /**
   * The session's project, reached through the same join as {@link agentId}. `null` when the
   * session belongs to no project. Optional, not because a repository-produced record ever omits
   * it, but because `packages/gateway/src/index.test.ts` builds a `RunRecord` fixture by hand and
   * is outside issue #135's ownership globs — a required field here would be a compile error in a
   * file this task may not edit. Every record `read()` and `listRuns()` return sets it.
   */
  readonly projectId?: string | null;
  /**
   * The session's initiating user (spec §20) — who started the conversation this run belongs to.
   * Reached through the same join as {@link agentId}. Optional for the same reason
   * {@link projectId} is: an existing out-of-globs fixture must keep compiling.
   */
  readonly initiatingUserId?: string | null;
  /** The exact workspace principal that owns the session. */
  readonly ownerPrincipalId?: string;
  /**
   * The tool connectors this run may call (ADR-0113 C16): sorted, distinct ids, `[]` when none.
   * Optional for the same reason {@link projectId} is — hand-built `RunRecord` fixtures outside
   * this unit's ownership must keep compiling. Every record `get()` and `listRuns()` return sets it.
   */
  readonly toolConnectorIds?: readonly string[];
  /**
   * The origin of the session's tool sandbox serving this run's code tools (ADR-0118 TS3), or
   * `null` when the run has none. Optional for the same reason {@link projectId} is.
   */
  readonly toolSandboxOrigin?: string | null;
}

/** Everything an insert supplies. The workspace is not among them — it comes from the scope. */
export interface CreateRunInput {
  readonly id: string;
  readonly sessionId: string;
  /**
   * The engine that will execute this run — the agent's `policy.engine`, resolved by the caller.
   * Required, not defaulted: "which engine ran this" is history, and a default here would quietly
   * record `claude-agent-sdk` for a run some later engine actually performed.
   */
  readonly engine: EngineId;
  /** The prompt the run starts with (issue #620); omitted or null stores NULL. */
  readonly prompt?: string | null;
}

/** What creating a run can produce. Each member is a different correction. */
export type CreateRunOutcome =
  | { readonly kind: 'created'; readonly run: RunRecord }
  | { readonly kind: 'duplicate-id'; readonly id: string }
  | { readonly kind: 'unknown-session'; readonly sessionId: string }
  /** The session already has a `queued` or `running` run: two runs would resume one transcript. */
  | { readonly kind: 'session-busy'; readonly sessionId: string };

/** What a lifecycle transition can produce. `no-op` is a real answer, not a failure. */
export type RunTransitionOutcome =
  | { readonly kind: 'moved'; readonly run: RunRecord }
  | { readonly kind: 'no-op' }
  | { readonly kind: 'not-found' };

export interface RecordRunUsageInput {
  /** Stable upstream response id, or the gateway request id when the upstream supplies none. */
  readonly providerResponseId: string;
  readonly provider: ModelProvider;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly toolCalls: number;
  /** The gateway dialect that served this response (ADR-0068 D5). */
  readonly wireProtocol: WireProtocol;
  /** Exact fixed-scale decimal; never a JavaScript floating-point value. `'0.000000'` when
   * {@link priceTableVersion} is null — captured usage with no price available, not a real zero. */
  readonly costUsd: string;
  readonly costCurrency: 'USD';
  /** Null when no price catalogue entry covered this response (issue #134). */
  readonly priceTableVersion: string | null;
}

export type RecordRunUsageOutcome =
  | { readonly kind: 'recorded'; readonly run: RunRecord }
  | { readonly kind: 'duplicate'; readonly run: RunRecord }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'price-version-conflict'; readonly existingVersion: string };

/** Issue #129's resolved triple, written once before launch so a queued or failed run also has one. */
interface SnapshotRunModelInput {
  readonly connectionId: string;
  readonly model: string;
  readonly provider: ModelProvider;
}

/**
 * What recording a run's tool sandbox can produce.
 *
 *   * `recorded` — the run now carries this origin (also the answer to a retry of the same origin).
 *   * `not-found` — this workspace has no such run.
 *   * `not-queued` — the run has left `queued` and carries a different origin (or none).
 */
export type RecordRunToolSandboxOutcome =
  { readonly kind: 'recorded' } | { readonly kind: 'not-found' } | { readonly kind: 'not-queued' };

type SnapshotRunModelOutcome = { readonly kind: 'updated' } | { readonly kind: 'not-found' };

/**
 * What snapshotting a run's tool connectors can produce (ADR-0113 C16).
 *
 *   * `snapshotted` — the run now carries exactly `toolConnectorIds` (sorted, distinct).
 *   * `not-found` — this workspace has no such run.
 *   * `not-queued` — the run has left `queued` and carries a different set; an active run's
 *     authorised set is never changed.
 *   * `unknown-connectors` — these ids are not tool connectors of this workspace (absent, another
 *     workspace's, an MCP connector's, or not a UUID at all). The run is left unchanged.
 */
export type SnapshotRunToolsOutcome =
  | { readonly kind: 'snapshotted'; readonly toolConnectorIds: readonly string[] }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-queued' }
  | { readonly kind: 'unknown-connectors'; readonly connectorIds: readonly string[] };

/** The canonical textual UUID, the only form a `uuid` parameter is bound in. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether a stored `uuid[]` holds exactly the ids of a canonical (sorted, distinct) set. */
function sameIdSet(stored: readonly string[], canonical: readonly string[]): boolean {
  const sorted = [...new Set(stored)].sort();
  return sorted.length === canonical.length && sorted.every((id, i) => id === canonical[i]);
}

/**
 * Every filter `listRuns` composes, always intersected with the scope's own tenant predicate.
 * Every field is optional and an absent one contributes no predicate at all — `{}` lists the whole
 * workspace's runs, oldest-caller-first constraint being the scope alone (issue #135).
 *
 * `initiatingUserId` is deliberately not named `userId`: this filters by the session's initiating
 * user (`sessions.user_id`), a fact about the *row*, and is not to be confused with the caller's
 * own identity. Whether a caller may supply it at all — issue #135's "no user filter for
 * Builder/Viewer" — is an authorisation decision the HTTP layer makes before this method is ever
 * called; the repository applies whatever it is given, tenant-scoped, and decides nothing about
 * who may ask.
 */
interface RunListFilter {
  readonly status?: RunStatus;
  readonly agentId?: string;
  readonly projectId?: string;
  readonly provider?: ModelProvider;
  readonly model?: string;
  /** `runs.created_at >= createdFrom`, inclusive. */
  readonly createdFrom?: Date;
  /**
   * `runs.created_at <= createdTo`, inclusive **at millisecond precision** — the precision a
   * `Date`, and so every `createdAt` this repository ever renders, actually has. `created_at`
   * itself holds microseconds, so a range built from a run's own rendered `createdAt` includes
   * that run; see `listRuns` for how the bound is applied.
   */
  readonly createdTo?: Date;
  readonly initiatingUserId?: string;
  /** Exact session ownership, used for an own-grant collection read. */
  readonly ownerPrincipalId?: string;
}

/**
 * A keyset pagination boundary: the `(created_at, id)` pair of the last item on the previous page.
 * Opaque to every caller above this layer — the HTTP route encodes and decodes it, and never reads
 * either field for its own purposes.
 *
 * `createdAt` is **not** a `Date`. `runs.created_at` is `timestamptz` at microsecond precision,
 * but a JS `Date` only holds milliseconds — round-tripping the boundary through one truncates it,
 * and the predicate then compares a millisecond-rounded boundary against full-precision rows,
 * silently skipping every row whose true `created_at` falls inside that lost fraction (round 2
 * finding 1). So `createdAt` here is the exact text PostgreSQL itself would print for the
 * boundary row's `created_at` (`to_char(... , 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, always UTC, always
 * six fractional digits): a value round-trips through JSON, through the HTTP cursor's base64url
 * encoding, and back into `::timestamptz` bit-for-bit, because nothing on the way ever holds it in
 * a `Date`.
 */
interface RunListCursor {
  readonly createdAt: string;
  readonly id: string;
}

interface ListRunsInput {
  readonly filter?: RunListFilter;
  /** Rows to return. Validated to a safe positive integer, capped, before any query runs. */
  readonly limit: number;
  /** The previous page's boundary, or `null`/omitted for the first page. */
  readonly cursor?: RunListCursor | null;
}

interface RunListPage {
  /** Newest first — the same order `runs_workspace_created_idx` is shaped for. */
  readonly items: readonly RunRecord[];
  /** The boundary the next page's `cursor` should carry, or `null` when this was the last page. */
  readonly nextCursor: RunListCursor | null;
}

/** The largest `limit` a caller may request in one page. */
const MAX_RUN_LIST_LIMIT = 200;

/** Run persistence for exactly one workspace. No method takes a workspace id. */
export interface RunRepository {
  create(input: CreateRunInput): Promise<CreateRunOutcome>;
  get(runId: string): Promise<RunRecord | null>;
  /** Move a queued run to `running`, stamping `started_at`. Already-started is `no-op`. */
  markRunning(runId: string): Promise<RunTransitionOutcome>;
  /** Move a run to a terminal status, optionally committing its status event in the same transaction. */
  finish(
    runId: string,
    status: RunStatus,
    error: string | null,
    statusEventMaxEvents?: number,
  ): Promise<RunTransitionOutcome>;
  /**
   * Write the resolved model/provider/connection onto the run row (issue #129), before the run is
   * handed to a runtime. Distinct from {@link recordUsage}: this never touches `run_usage_records`
   * or the numeric counters — it is a plain overwrite of the three identity columns, called once,
   * before launch, so a run that is only ever `queued` or `failed` still says what it attempted.
   */
  snapshotModel(runId: string, input: SnapshotRunModelInput): Promise<SnapshotRunModelOutcome>;
  /**
   * Record the tool connectors this run may call (ADR-0113 C16), before launch. Every id must be a
   * tool connector (`kind <> 'mcp'`) of this workspace, or nothing is written. Idempotent: the
   * set the run already carries is `snapshotted` again, before or after launch, even when one of
   * its connectors has since been deleted; a different set once the run has left `queued` is
   * `not-queued`. Whether a connector is enabled is the gateway's call-time check. A malformed
   * run id is `not-found` and a malformed connector id is `unknown-connectors`, never a database
   * error.
   *
   * Single writer: compose calls this once per run, before the post (S2-02c/S2-04c). Concurrent
   * calls with different sets on one queued run are serialised by a row lock and the last one
   * wins; each caller's answer was true when it committed, but only the last one's still is.
   *
   * Optional on the interface for the same reason as {@link listRuns}: the database provider
   * implements it, but `packages/gateway/src/index.test.ts` builds a `RunRepository` fixture by
   * hand and is outside S2-02b's `Owns` globs. S2-02d/S2-02f may make it required.
   */
  snapshotTools?(runId: string, connectorIds: readonly string[]): Promise<SnapshotRunToolsOutcome>;
  /**
   * Record the origin of the tool sandbox serving this run's code tools (ADR-0118 TS3), before
   * launch. Written only while the run is `queued`; a retry of the same origin is `recorded`
   * again after launch. Optional for the same reason as {@link snapshotTools}.
   */
  recordToolSandbox?(runId: string, origin: string): Promise<RecordRunToolSandboxOutcome>;
  /**
   * Append one usage settlement (inserting a new ledger row, or pricing an existing unpriced one
   * for the same `providerResponseId`) and atomically advance the run read model, including
   * {@link RunRecord.accountingState}, recomputed from the ledger.
   */
  recordUsage(runId: string, input: RecordRunUsageInput): Promise<RecordRunUsageOutcome>;
  /**
   * Record that a settlement attempt could not produce usable ledger data at all (issue #134) —
   * never called when {@link recordUsage} could be, since that always carries more information.
   * Only takes effect while the run's accounting is still `pending`: a run that already has some
   * settled usage (`complete`/`partial`/`unavailable`) is not regressed to `failed` by one later,
   * separate, unmeasurable response.
   */
  markAccountingFailed(runId: string, reason: string): Promise<RunTransitionOutcome>;
  /**
   * Every run in this scope's workspace, newest first, joined through `sessions` to the agent,
   * project and initiating user the same way {@link get} is (issue #135). Cursor-paginated on
   * `(created_at, id)` — stable against concurrent inserts and deletes, since a keyset boundary
   * names a row rather than an offset into a count that can shift under it.
   *
   * Optional on the interface, not because {@link createDatabaseRunRepositoryProvider} omits it —
   * it does not — but because `packages/gateway/src/index.test.ts` builds a `RunRepository`
   * fixture by hand implementing only the subset `createDatabaseUsageRecorder` calls, and is
   * outside issue #135's `Owns` globs. A required method here would be a compile error in a file
   * this task may not edit; `apps/web/server/runs/store.ts`'s `createRepositoryRunStore` is the
   * one caller and treats an absent implementation as a broken composition, not a normal state.
   */
  listRuns?(input: ListRunsInput): Promise<RunListPage>;
}

export interface StoredRunEvent {
  readonly id: bigint;
  readonly type: string;
  readonly data: unknown;
  /** When the control plane recorded the event: the row's `created_at`, not the engine's clock. */
  readonly at: Date;
}

export interface RunEventRepository {
  append(
    runId: string,
    type: string,
    data: unknown,
    maxEvents: number,
  ): Promise<StoredRunEvent | null>;
  /** Events after `after`, oldest first; at most `limit` of them when it is given. */
  list(runId: string, after: bigint | null, limit?: number): Promise<readonly StoredRunEvent[]>;
  bounds(runId: string): Promise<{ oldest: bigint; latest: bigint } | null>;
}

export interface RunEventRepositoryProvider {
  forScope(scope: WorkspaceScope): RunEventRepository;
}

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
            if (currentRun === undefined || TERMINAL.has(currentRun.status)) return null;
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

export interface RunRepositoryProvider {
  forScope(scope: WorkspaceScope): RunRepository;
}

/** One session row, in the three columns a run needs from it. */
export interface SessionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  /** Legacy human attribution; null for machine-owned sessions. */
  readonly userId: string | null;
  readonly ownerPrincipalId: string;
  readonly projectId: string | null;
  readonly engineSessionId: string | null;
  readonly engine: EngineId | null;
  /** The agent version the session started on; `null` for a legacy, unversioned agent (#612). */
  readonly agentVersionId: string | null;
  readonly title: string | null;
  readonly status: 'active' | 'archived';
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Everything creating a session row supplies. The workspace comes from the scope. */
export interface EnsureSessionInput {
  readonly id: string;
  readonly agentId: string;
  readonly ownerPrincipalId: string;
  readonly userId?: string | null;
  readonly projectId?: string | null;
  readonly title?: string | null;
  /**
   * The agent version to pin, written only when this call inserts the row: an `existing` session
   * keeps the version it started on (#612). A version of another agent or workspace is refused by
   * `sessions_agent_version_fk` and re-thrown.
   */
  readonly agentVersionId?: string | null;
}

/**
 * The engine's identity for a session: the id it reported and the engine that reported it. One
 * value, so neither half can be written without the other — a reported id always names its engine
 * (ADR-0065), which is the invariant migration 0025 establishes for rows written before this type.
 */
interface SessionEngineIdentity {
  readonly engineSessionId: string;
  readonly engine: EngineId;
}

export interface UpdateSessionInput {
  readonly title?: string | null;
  readonly projectId?: string | null;
  readonly engineIdentity?: SessionEngineIdentity;
}

export type SessionMutationOutcome =
  | { readonly kind: 'updated'; readonly session: SessionRecord }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'no-op'; readonly session: SessionRecord };

/**
 * What ensuring a session row can produce.
 *
 * `existing` and `created` are kept apart even though both mean "the row is there now": a caller
 * resuming a session and a caller starting one are different requests, and W2-CP-07 needs to be
 * able to tell them apart without a second query.
 */
export type EnsureSessionOutcome =
  | { readonly kind: 'created'; readonly session: SessionRecord }
  | { readonly kind: 'existing'; readonly session: SessionRecord }
  | { readonly kind: 'unknown-agent'; readonly agentId: string }
  | { readonly kind: 'not-a-member'; readonly userId: string }
  | { readonly kind: 'unknown-principal'; readonly principalId: string };

/**
 * Which of the workspace's sessions a list may return. Pushed into the query rather than applied
 * to its result, so a page is always full and its boundary is a row the caller may see.
 */
export type SessionVisibility =
  /** Owner and Admin oversight: every session in the workspace. */
  | { readonly kind: 'all' }
  /** Everyone else: the sessions owned by exactly this durable principal. */
  | { readonly kind: 'owner'; readonly principalId: string }
  /** A runner: only the one session its signed per-run claim names, by the engine's id. */
  | { readonly kind: 'engine-session'; readonly engineSessionId: string };

/** The largest page {@link SessionRepository.list} serves. */
const MAX_SESSION_LIST_LIMIT = 200;

interface SessionListInput {
  readonly visibility: SessionVisibility;
  readonly status?: 'active' | 'archived';
  /** Rows per page, 1–{@link MAX_SESSION_LIST_LIMIT}; omitted for every remaining row. */
  readonly limit?: number;
  /** The previous page's `nextCursor`; omitted or `null` for the newest rows. */
  readonly cursor?: KeysetPosition | null;
}

/** Session-row persistence for exactly one workspace. See this file's header for its limits. */
export interface SessionRepository {
  ensure(input: EnsureSessionInput): Promise<EnsureSessionOutcome>;
  get(sessionId: string): Promise<SessionRecord | null>;
  getByEngineSessionId(engineSessionId: string): Promise<SessionRecord | null>;
  /**
   * Newest first by the immutable `(created_at, id)`, never by `updated_at`: a rename or a run
   * moves `updated_at`, and a row that moved while a caller paged would be skipped or seen twice.
   */
  list(input: SessionListInput): Promise<KeysetPage<SessionRecord>>;
  update(sessionId: string, input: UpdateSessionInput): Promise<SessionMutationOutcome>;
  archive(sessionId: string): Promise<SessionMutationOutcome>;
  restore(sessionId: string): Promise<SessionMutationOutcome>;
}

export interface SessionRepositoryProvider {
  forScope(scope: WorkspaceScope): SessionRepository;
}

// ── Failure classification ──────────────────────────────────────────────────────────────────
//
// Transcribed from `migrations/0000_init.sql`, which is what PostgreSQL reports back.

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

const RUN_PRIMARY_KEY = 'runs_pkey';
const RUN_SESSION_CONSTRAINT = 'runs_session_workspace_fk';
const SESSION_PRIMARY_KEY = 'sessions_pkey';
const SESSION_AGENT_CONSTRAINT = 'sessions_agent_workspace_fk';
const SESSION_MEMBER_CONSTRAINT = 'sessions_member_workspace_fk';
const SESSION_OWNER_CONSTRAINT = 'sessions_owner_principal_workspace_fk';

/**
 * True when some link of the thrown error's `cause` chain is this SQLSTATE on this constraint.
 *
 * A positive assertion about a named constraint, never "the write failed so it must have been
 * the obvious reason". A caller for which every `violatedBy` answers `false` re-throws: a failure
 * this module cannot name might be a dropped connection, and reporting it as a client error would
 * be a gate deciding on the absence of a negative (ADR-0015). The chain walk is in
 * `./violations.ts`, together with the measurement that showed it was needed.
 */
function violatedBy(error: unknown, code: string, constraint: string): boolean {
  for (const failure of postgresViolations(error)) {
    if (failure.code === code && failure.constraint === constraint) return true;
  }
  return false;
}

/** The columns a run read selects, with `agent_id` reached through the session. */
const RUN_COLUMNS = {
  id: runs.id,
  workspaceId: runs.workspaceId,
  agentId: sessions.agentId,
  sessionId: runs.sessionId,
  status: runs.status,
  createdAt: runs.createdAt,
  startedAt: runs.startedAt,
  endedAt: runs.endedAt,
  model: runs.model,
  provider: runs.provider,
  modelConnectionId: runs.modelConnectionId,
  toolConnectorIds: runs.toolConnectorIds,
  toolSandboxOrigin: runs.toolSandboxOrigin,
  engine: runs.engine,
  engineVersion: runs.engineVersion,
  inputTokens: runs.inputTokens,
  outputTokens: runs.outputTokens,
  cacheReadInputTokens: runs.cacheReadInputTokens,
  cacheCreationInputTokens: runs.cacheCreationInputTokens,
  toolCalls: runs.toolCalls,
  costUsd: runs.costUsd,
  costCurrency: runs.costCurrency,
  priceTableVersion: runs.priceTableVersion,
  error: runs.error,
  accountingState: runs.accountingState,
  accountingError: runs.accountingError,
  // Reached through the same join as `agentId` above, for the same reason: neither is a column on
  // `runs`, and a second copy here could disagree with `sessions`'.
  projectId: sessions.projectId,
  initiatingUserId: sessions.userId,
  ownerPrincipalId: sessions.ownerPrincipalId,
} as const;

/**
 * {@link RUN_COLUMNS} plus the one extra value only `listRuns` needs: the row's `created_at` at
 * the database's own precision, as text, for minting a keyset cursor that does not truncate it.
 * `RunRecord.createdAt` (from `RUN_COLUMNS` alone) stays a `Date` — everywhere else a run's
 * timestamp is a display value, not a pagination boundary, and `RunRecord`'s shape does not
 * change. Always UTC and always six fractional digits, so the text is both order-preserving
 * (lexicographic order on this format matches chronological order) and losslessly reversible with
 * a plain `::timestamptz` cast — see {@link RunListCursor}.
 */
const LIST_RUN_COLUMNS = {
  ...RUN_COLUMNS,
  createdAtCursor: sql<string>`to_char(${runs.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
} as const;

/**
 * A status read back from the database, narrowed by a positive assertion.
 *
 * `text('status', { enum: … })` is a compile-time narrowing; the row could hold anything the
 * `runs_status_valid` check allows, and a future migration relaxing that check would let an
 * unknown status through typed as a known one. Parsed here instead, with an explicit else.
 */
function parseRunStatus(value: string): RunStatus {
  const known = (runStatuses as readonly string[]).includes(value);
  if (!known) throw new Error(`runs.status holds ${JSON.stringify(value)}, which is not a status`);
  return value as RunStatus;
}

/** Same positive-assertion narrowing as {@link parseRunStatus}, for `runs.accounting_state`. */
function parseAccountingState(value: string): AccountingState {
  const known = (accountingStates as readonly string[]).includes(value);
  if (!known) {
    throw new Error(`runs.accounting_state holds ${JSON.stringify(value)}, which is not a state`);
  }
  return value as AccountingState;
}

/**
 * Same positive-assertion narrowing as {@link parseRunStatus}, for `runs.engine` — which, unlike
 * the two above, is legitimately NULL on a run recorded before migration 0024 added the column.
 */
function parseEngineId(value: string | null): EngineId | null {
  if (value === null) return null;
  const known = (engineIds as readonly string[]).includes(value);
  if (!known) throw new Error(`runs.engine holds ${JSON.stringify(value)}, which is not an engine`);
  return value as EngineId;
}

function toRunRecord(row: {
  id: string;
  workspaceId: string;
  agentId: string;
  sessionId: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  model: string | null;
  provider: string | null;
  modelConnectionId: string | null;
  toolConnectorIds: string[];
  toolSandboxOrigin: string | null;
  engine: string | null;
  engineVersion: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  toolCalls: number;
  costUsd: string;
  costCurrency: string;
  priceTableVersion: string | null;
  error: string | null;
  accountingState: string;
  accountingError: string | null;
  projectId: string | null;
  initiatingUserId: string | null;
}): RunRecord {
  if (row.costCurrency !== 'USD') {
    throw new Error(
      `runs.cost_currency holds unsupported currency ${JSON.stringify(row.costCurrency)}`,
    );
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    sessionId: row.sessionId,
    status: parseRunStatus(row.status),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    model: row.model,
    provider: row.provider,
    modelConnectionId: row.modelConnectionId,
    toolConnectorIds: [...row.toolConnectorIds],
    toolSandboxOrigin: row.toolSandboxOrigin,
    engine: parseEngineId(row.engine),
    engineVersion: row.engineVersion,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens,
    toolCalls: row.toolCalls,
    costUsd: row.costUsd,
    costCurrency: row.costCurrency,
    priceTableVersion: row.priceTableVersion,
    error: row.error,
    accountingState: parseAccountingState(row.accountingState),
    accountingError: row.accountingError,
    projectId: row.projectId,
    initiatingUserId: row.initiatingUserId,
  };
}

/**
 * `and()`, with a throw rather than a fallback if the conjunction cannot be built.
 *
 * Shared by both providers below, and every call site passes the tenant predicate first.
 * Drizzle types `and()` as possibly-undefined because it accepts an empty argument list;
 * degrading to `undefined` here would drop the whole `where` clause, tenant filter included —
 * the one failure this layer exists to make impossible — so the impossible arm throws instead of
 * quietly widening the query.
 */
function every(...predicates: readonly SQL[]): SQL {
  const combined = and(...predicates);
  if (combined === undefined) throw new Error('the workspace predicate could not be built');
  return combined;
}

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
          .select(RUN_COLUMNS)
          .from(runs)
          // The join is tenant-paired as well as id-paired. `runs_session_workspace_fk` already
          // guarantees the two workspaces agree, so this cannot change which row is found; it is
          // written out so the query says the invariant rather than relying on it.
          .innerJoin(
            sessions,
            every(eq(sessions.id, runs.sessionId), eq(sessions.workspaceId, runs.workspaceId)),
          )
          .where(every(tenant, eq(runs.id, runId)))
          .limit(1);
        const row = rows[0];
        return row === undefined ? null : toRunRecord(row);
      };

      return {
        async create(input: CreateRunInput): Promise<CreateRunOutcome> {
          try {
            const busy = await db.transaction(async (tx) => {
              // Session project assignment and run creation share this lock. A run cannot enter
              // between moveSession's no-runs check and its project update, and two creates on
              // one session cannot both pass the busy check below.
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${input.sessionId}, 1))`,
              );
              const active = await tx
                .select({ id: runs.id })
                .from(runs)
                .where(
                  every(
                    tenant,
                    eq(runs.sessionId, input.sessionId),
                    // A reused id is a duplicate, answered by the primary key below.
                    ne(runs.id, input.id),
                    notInArray(runs.status, [...terminalRunStatuses]),
                  ),
                )
                .limit(1);
              if (active.length > 0) return true;
              await tx.insert(runs).values({
                id: input.id,
                // Not from the caller. A run inherits the scope's workspace.
                workspaceId: checked.workspaceId,
                sessionId: input.sessionId,
                engine: input.engine,
                prompt: input.prompt ?? null,
              });
              return false;
            });
            if (busy) return { kind: 'session-busy', sessionId: input.sessionId };
          } catch (error) {
            if (violatedBy(error, UNIQUE_VIOLATION, RUN_PRIMARY_KEY)) {
              return { kind: 'duplicate-id', id: input.id };
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

        async markRunning(runId: string): Promise<RunTransitionOutcome> {
          const moved = await db
            .update(runs)
            // Only from `queued`. A run already running or already terminal is not moved, which
            // is what makes `started_at` stamped exactly once.
            .set({ status: 'running', startedAt: sql`now()` })
            .where(every(tenant, eq(runs.id, runId), eq(runs.status, 'queued')))
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

        async finish(
          runId: string,
          status: RunStatus,
          error: string | null,
          statusEventMaxEvents?: number,
        ): Promise<RunTransitionOutcome> {
          if (!isTerminalRunStatus(status)) {
            throw new Error(`${status} is not a terminal run status`);
          }
          if (
            statusEventMaxEvents !== undefined &&
            (!Number.isSafeInteger(statusEventMaxEvents) || statusEventMaxEvents < 1)
          ) {
            throw new Error('status event retention must be a positive safe integer');
          }
          const outcome = await db.transaction(async (tx) => {
            // Event append takes this exact lock before checking status and allocating sequence.
            // Whichever transaction enters first completes wholly first: a terminal transition
            // cannot overtake an admitted event, and an append cannot enter after termination.
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${runId}, 0))`);
            const moved = await tx
              .update(runs)
              .set({
                status,
                endedAt: sql`now()`,
                // `runs_ended_at_iff_terminal` needs a coherent pair, and
                // `runs_ended_after_started` needs the start not to be later than the end. A run
                // that failed before it ever started gets its start stamped here rather than
                // leaving a NULL that renders as "NaN s".
                startedAt: sql`coalesce(${runs.startedAt}, now())`,
                error,
              })
              .where(
                every(
                  tenant,
                  eq(runs.id, runId),
                  notInArray(runs.status, [...terminalRunStatuses]),
                ),
              )
              .returning({ id: runs.id });
            if (moved.length === 0) return 'unchanged' as const;
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
                data: { status, error },
              });
              const cutoff = next - BigInt(statusEventMaxEvents);
              if (cutoff > 0n) {
                await tx
                  .delete(runEvents)
                  .where(every(eq(runEvents.runId, runId), lte(runEvents.sequence, cutoff)));
              }
            }
            // Token revocation is part of the same commit as terminal state. A gateway can
            // therefore never observe a committed terminal run whose bearer remains active.
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
            return 'moved' as const;
          });
          const existing = await read(runId);
          if (existing === null) return { kind: 'not-found' };
          return outcome === 'moved' ? { kind: 'moved', run: existing } : { kind: 'no-op' };
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
      };
    },
  };
}

/** The columns a session read selects. */
const SESSION_COLUMNS = {
  id: sessions.id,
  workspaceId: sessions.workspaceId,
  agentId: sessions.agentId,
  userId: sessions.userId,
  ownerPrincipalId: sessions.ownerPrincipalId,
  projectId: sessions.projectId,
  engineSessionId: sessions.engineSessionId,
  engine: sessions.engine,
  agentVersionId: sessions.agentVersionId,
  title: sessions.title,
  status: sessions.status,
  createdAt: sessions.createdAt,
  updatedAt: sessions.updatedAt,
} as const;

/** The PostgreSQL {@link SessionRepositoryProvider}. See this file's header for its narrow remit. */
export function createDatabaseSessionRepositoryProvider(db: Database): SessionRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): SessionRepository {
      // The run-time half of the scope gate, before any predicate is built. See `./scope.ts`.
      const checked = requireWorkspaceScope(scope, 'SessionRepositoryProvider');
      const tenant = eq(sessions.workspaceId, checked.workspaceId);

      const read = async (sessionId: string): Promise<SessionRecord | null> => {
        const rows = await db
          .select(SESSION_COLUMNS)
          .from(sessions)
          .where(every(tenant, eq(sessions.id, sessionId)))
          .limit(1);
        return rows[0] ?? null;
      };

      return {
        get: read,

        async getByEngineSessionId(engineSessionId): Promise<SessionRecord | null> {
          const rows = await db
            .select(SESSION_COLUMNS)
            .from(sessions)
            .where(every(tenant, eq(sessions.engineSessionId, engineSessionId)))
            .limit(1);
          return rows[0] ?? null;
        },

        async list(input): Promise<KeysetPage<SessionRecord>> {
          if (input.limit !== undefined) {
            assertPageLimit(input.limit, MAX_SESSION_LIST_LIMIT, 'session list');
          }
          const predicates: SQL[] = [tenant];
          if (input.status !== undefined) predicates.push(eq(sessions.status, input.status));
          const visibility = input.visibility;
          if (visibility.kind === 'owner') {
            predicates.push(eq(sessions.ownerPrincipalId, visibility.principalId));
          } else if (visibility.kind === 'engine-session') {
            predicates.push(eq(sessions.engineSessionId, visibility.engineSessionId));
          }
          if (input.cursor !== undefined && input.cursor !== null) {
            predicates.push(afterPosition(sessions.createdAt, sessions.id, input.cursor));
          }
          const query = db
            .select({ session: SESSION_COLUMNS, cursorAt: keysetTimestamp(sessions.createdAt) })
            .from(sessions)
            .where(every(...predicates))
            .orderBy(desc(sessions.createdAt), desc(sessions.id));
          const rows = await (input.limit === undefined ? query : query.limit(input.limit + 1));
          return toKeysetPage(rows, input.limit, (row) => row.session);
        },

        async ensure(input: EnsureSessionInput): Promise<EnsureSessionOutcome> {
          const already = await read(input.id);
          if (already !== null) return { kind: 'existing', session: already };
          try {
            const rows = await db
              .insert(sessions)
              .values({
                id: input.id,
                workspaceId: checked.workspaceId,
                userId: input.userId ?? null,
                ownerPrincipalId: input.ownerPrincipalId,
                agentId: input.agentId,
                projectId: input.projectId ?? null,
                title: input.title ?? null,
                agentVersionId: input.agentVersionId ?? null,
              })
              .returning(SESSION_COLUMNS);
            const row = rows[0];
            if (row === undefined) throw new Error('the insert returned no row');
            return { kind: 'created', session: row };
          } catch (error) {
            if (violatedBy(error, UNIQUE_VIOLATION, SESSION_PRIMARY_KEY)) {
              // Someone else inserted it between the read above and this insert. The row exists,
              // which is what `ensure` promises; re-read it rather than reporting a failure.
              const raced = await read(input.id);
              if (raced !== null) return { kind: 'existing', session: raced };
              throw error;
            }
            if (violatedBy(error, FOREIGN_KEY_VIOLATION, SESSION_AGENT_CONSTRAINT)) {
              return { kind: 'unknown-agent', agentId: input.agentId };
            }
            if (violatedBy(error, FOREIGN_KEY_VIOLATION, SESSION_MEMBER_CONSTRAINT)) {
              if (input.userId === undefined || input.userId === null) throw error;
              return { kind: 'not-a-member', userId: input.userId };
            }
            if (violatedBy(error, FOREIGN_KEY_VIOLATION, SESSION_OWNER_CONSTRAINT)) {
              return { kind: 'unknown-principal', principalId: input.ownerPrincipalId };
            }
            throw error;
          }
        },

        async update(sessionId, input): Promise<SessionMutationOutcome> {
          const changes: {
            title?: string | null;
            projectId?: string | null;
            engineSessionId?: string | null;
            engine?: EngineId | null;
            updatedAt?: ReturnType<typeof sql>;
          } = {};
          if (input.title !== undefined) changes.title = input.title;
          if (input.projectId !== undefined) changes.projectId = input.projectId;
          if (input.engineIdentity !== undefined) {
            changes.engineSessionId = input.engineIdentity.engineSessionId;
            changes.engine = input.engineIdentity.engine;
          }
          if (Object.keys(changes).length === 0) {
            const current = await read(sessionId);
            return current === null ? { kind: 'not-found' } : { kind: 'no-op', session: current };
          }
          changes.updatedAt = sql`now()`;
          const rows = await db
            .update(sessions)
            .set(changes)
            .where(every(tenant, eq(sessions.id, sessionId)))
            .returning(SESSION_COLUMNS);
          const row = rows[0];
          return row === undefined ? { kind: 'not-found' } : { kind: 'updated', session: row };
        },

        async archive(sessionId): Promise<SessionMutationOutcome> {
          const rows = await db
            .update(sessions)
            .set({ status: 'archived', updatedAt: sql`now()` })
            .where(every(tenant, eq(sessions.id, sessionId), eq(sessions.status, 'active')))
            .returning(SESSION_COLUMNS);
          const row = rows[0];
          if (row !== undefined) return { kind: 'updated', session: row };
          const current = await read(sessionId);
          return current === null ? { kind: 'not-found' } : { kind: 'no-op', session: current };
        },

        async restore(sessionId): Promise<SessionMutationOutcome> {
          const rows = await db
            .update(sessions)
            .set({ status: 'active', updatedAt: sql`now()` })
            .where(every(tenant, eq(sessions.id, sessionId), eq(sessions.status, 'archived')))
            .returning(SESSION_COLUMNS);
          const row = rows[0];
          if (row !== undefined) return { kind: 'updated', session: row };
          const current = await read(sessionId);
          return current === null ? { kind: 'not-found' } : { kind: 'no-op', session: current };
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
 * run's tokens. Cross-tenant and unscoped like {@link findRunWorkspace}: it returns ids only.
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
