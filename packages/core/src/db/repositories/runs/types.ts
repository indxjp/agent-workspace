import type { EngineId } from '../../schema/agents.js';
import type { ModelProvider } from '../../schema/model-connections.js';
import type { WireProtocol } from '../../schema/run-usage-records.js';
import type { AccountingState, RunStatus } from '../../schema/runs.js';
import type { SessionStatus } from '../../schema/sessions.js';
import type { WorkspaceScope } from '../scope.js';

/**
 * A tool call a human approves (ADR-0145 D2.1): the tool's name and the canonical JSON text of the
 * call. One approval covers exactly one such call, once.
 */
export interface ApprovalCall {
  readonly toolName: string;
  readonly canonicalCall: string;
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
  /**
   * The number of the agent version the session pins (#612), reached by joining
   * `sessions.agent_version_id` to `agent_versions`. `null` for a legacy unversioned session.
   * Optional for the same reason {@link projectId} is: an existing out-of-globs fixture must keep
   * compiling. Every record `read()` and `listRuns()` return sets it.
   */
  readonly agentVersion?: number | null;
  /** The exact workspace principal that owns the session. */
  readonly ownerPrincipalId?: string;
  /**
   * The tool connectors this run may call (ADR-0113 C16): sorted, distinct ids, `[]` when none.
   * Optional for the same reason {@link projectId} is — hand-built `RunRecord` fixtures outside
   * this unit's ownership must keep compiling. Every record `get()` and `listRuns()` return sets it.
   */
  readonly toolConnectorIds?: readonly string[];
  /** The workspace file paths this run was granted (ADR-0147); `[]` when none. Optional like the rest. */
  readonly fileGrants?: readonly string[];
  /**
   * The origin of the session's tool sandbox serving this run's code tools (ADR-0118 TS3), or
   * `null` when the run has none. Optional for the same reason {@link projectId} is.
   */
  readonly toolSandboxOrigin?: string | null;
  /** The call an `awaiting_approval` run waits on; kept as history after the run moves on. */
  readonly pendingApproval?: ApprovalCall | null;
  /** The calls this run, as a continuation, may make without asking again. `[]` when none. */
  readonly approvedToolCalls?: readonly ApprovalCall[];
  /**
   * When {@link approvedToolCalls} were consumed: the moment the run left `queued`, before the
   * runner was sent anything (ADR-0151). `null` for a run with no approved calls and for one not yet
   * started. Optional for the same reason {@link projectId} is.
   */
  readonly approvalsConsumedAt?: Date | null;
  /** The approved calls that have already run, each once ({@link RunRepository.consumeApprovedCall}). */
  readonly consumedToolCalls?: readonly ApprovalCall[];
  /**
   * The run's final answer (ADR-0143): `null` until the run is `completed`, and for a failed or
   * cancelled one. Optional for the same reason {@link projectId} is. Every record `get()` and
   * `listRuns()` return sets it.
   */
  readonly output?: RunOutput | null;
  /**
   * The JSON Schema the run was asked to answer with (ADR-0143), `null` when it asked for none.
   * Only `get()` sets it: the list columns leave it out to keep list pages small.
   */
  readonly outputSchema?: Readonly<Record<string, unknown>> | null;
  /**
   * The prompt the run started with (issue #620), `null` when none was stored. Only `get()` sets
   * it, like {@link outputSchema}: a session share copies it (ADR-0158).
   */
  readonly prompt?: string | null;
  /**
   * The caller identity the run acts for (ADR-0142 D2), `null` when it asserts none. Only `get()`
   * sets it, for the approval continuation to carry on (ADR-0157); it is never rendered.
   */
  readonly subject?: string | null;
}

/** A completed run's answer. `structured` is `null` when the run asked for no output schema. */
export interface RunOutput {
  readonly text: string;
  readonly structured: unknown;
}

/** What creating a run can produce. Each member is a different correction. */
export type CreateRunOutcome =
  | { readonly kind: 'created'; readonly run: RunRecord }
  | { readonly kind: 'duplicate-id'; readonly id: string }
  | { readonly kind: 'unknown-session'; readonly sessionId: string }
  /** The session already has a `queued` or `running` run: two runs would resume one transcript. A run
   * paused at `awaiting_approval` has stopped and does not count (ADR-0145 D1). */
  | { readonly kind: 'session-busy'; readonly sessionId: string }
  /** Another run of this workspace and principal already holds the start key (ADR-0151). The caller
   * answers with that run, found by {@link RunRepository.findByIdempotencyKey}. */
  | { readonly kind: 'idempotency-key-taken'; readonly key: string }
  /** `decides` named a run that is not (or no longer) `awaiting_approval` in this session. Nothing was written. */
  | { readonly kind: 'already-decided'; readonly runId: string }
  /**
   * `decides` named a paused run whose approval window (24 hours from the pause, ADR-0145 D2.4)
   * had closed. The run was moved to `cancelled` in this call; no continuation was created.
   */
  | { readonly kind: 'approval-expired'; readonly runId: string };

/**
 * What consuming an approved call can produce (ADR-0145 D2.1, #1541).
 *
 *   * `consumed` — this caller used the approval; it runs the call.
 *   * `already-used` — an earlier caller used it; nothing is written.
 *   * `not-approved` — no running run of this workspace has this call approved.
 */
export type ConsumeApprovedCallOutcome = 'consumed' | 'already-used' | 'not-approved';

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
export interface SnapshotRunModelInput {
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

export type SnapshotRunModelOutcome = { readonly kind: 'updated' } | { readonly kind: 'not-found' };

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

export interface ListRunsInput {
  readonly filter?: RunListFilter;
  /** Rows to return. Validated to a safe positive integer, capped, before any query runs. */
  readonly limit: number;
  /** The previous page's boundary, or `null`/omitted for the first page. */
  readonly cursor?: RunListCursor | null;
}

export interface RunListPage {
  /** Newest first — the same order `runs_workspace_created_idx` is shaped for. */
  readonly items: readonly RunRecord[];
  /** The boundary the next page's `cursor` should carry, or `null` when this was the last page. */
  readonly nextCursor: RunListCursor | null;
}

/** Run persistence for exactly one workspace. No method takes a workspace id. */
export interface RunRepository {
  create(input: CreateRunInput): Promise<CreateRunOutcome>;
  get(runId: string): Promise<RunRecord | null>;
  /**
   * The run `principalId` started with this `Idempotency-Key`, whatever its status, and the hash of
   * the request it was started with (ADR-0151); `null` when there is none.
   */
  findByIdempotencyKey(
    principalId: string,
    key: string,
  ): Promise<{ readonly run: RunRecord; readonly requestHash: string } | null>;
  /**
   * Move a queued run to `running`, stamping `started_at`, and `approvals_consumed_at` when it
   * carries approved calls. Already-started is `no-op`.
   */
  markRunning(runId: string): Promise<RunTransitionOutcome>;
  /**
   * Use up one approval of a running run, atomically: one conditional update appends `call` to
   * `consumed_tool_calls` only while the run is `running`, `call` is in `approved_tool_calls` and
   * not yet consumed, so of any number of concurrent callers exactly one gets `consumed`. This is
   * the single consumption record the engine path and a direct gateway call share.
   */
  consumeApprovedCall(runId: string, call: ApprovalCall): Promise<ConsumeApprovedCallOutcome>;
  /**
   * Pause a running run for a human decision (ADR-0145 D1): status `awaiting_approval`, `ended_at`
   * set, the call it waits on stored, and its run tokens revoked in the same commit. Any other
   * source status is `no-op`. The way out is {@link finish} with `completed` or `cancelled`; a
   * paused run is never moved back to `running`. `statusEventMaxEvents` has the meaning it has for
   * {@link finish}: when given, the `run.status` event is committed in the same transaction.
   */
  awaitApproval(
    runId: string,
    call: ApprovalCall,
    statusEventMaxEvents?: number,
  ): Promise<RunTransitionOutcome>;
  /**
   * Move a run to a terminal status, optionally committing its status event in the same transaction.
   * `output` is written in that same update and only for `completed`; passing one with any other
   * status throws. A run that is already terminal is `no-op` and keeps what it has.
   */
  finish(
    runId: string,
    status: RunStatus,
    error: string | null,
    statusEventMaxEvents?: number,
    output?: RunOutput | null,
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
   * Optional on the interface: the database provider implements it, but `packages/gateway`'s
   * hand-built `RunRepository` fixtures do not. S2-02d/S2-02f may make it required.
   */
  snapshotTools?(runId: string, connectorIds: readonly string[]): Promise<SnapshotRunToolsOutcome>;
  /**
   * Record the origin of the tool sandbox serving this run's code tools (ADR-0118 TS3), before
   * launch. Written only while the run is `queued`; a retry of the same origin is `recorded`
   * again after launch. Optional for the same reason as {@link snapshotTools}.
   */
  recordToolSandbox?(runId: string, origin: string): Promise<RecordRunToolSandboxOutcome>;
  /**
   * Record the file paths the run may search (ADR-0147) while it is `queued`. `true` once the run
   * carries exactly `paths`; `false` when the workspace has no such run or it already left `queued`.
   */
  snapshotFileGrants?(runId: string, paths: readonly string[]): Promise<boolean>;
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
   */
  listRuns(input: ListRunsInput): Promise<RunListPage>;
  /**
   * The model cost this workspace's usage ledger settled in `[from, to)` by each row's own
   * `created_at`, in one read. The ledger is the source `runs.cost_usd` is advanced from, so a run
   * that spans midnight is split at it; an unpriced response counts as 0 in `costUsd`, which is why
   * `unpricedUsage` says whether any run with usage in the window has an accounting state other
   * than `complete`, so a caller can tell that the sum cannot be trusted as a total.
   */
  usageCostUsd(from: Date, to: Date): Promise<UsageCostWindow>;
}

/** What {@link RunRepository.usageCostUsd} answers for a window. */
export interface UsageCostWindow {
  /** The settled cost, as a decimal string; `'0'` when the window has no usage. */
  readonly costUsd: string;
  /** Some run with usage in the window is not `complete`: part of its spend is unmeasured. */
  readonly unpricedUsage: boolean;
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

export interface RunRepositoryProvider {
  forScope(scope: WorkspaceScope): RunRepository;
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
  /** The calls a continuation run may make without asking again; omitted stores `[]`. */
  readonly approvedToolCalls?: readonly ApprovalCall[];
  /** The JSON Schema object the run must answer with (ADR-0143); omitted or null stores NULL. */
  readonly outputSchema?: Readonly<Record<string, unknown>> | null;
  /** The caller identity the run acts for (ADR-0142 D2, ADR-0157); omitted or null stores NULL. */
  readonly subject?: string | null;
  /** The start request's `Idempotency-Key`, the principal it is scoped to, and the request's hash. */
  readonly idempotency?: RunIdempotency;
  /**
   * Makes this run the continuation of a paused run (ADR-0145 D2.3): in the same transaction that
   * inserts it, the run `runId` of this session moves from `awaiting_approval` to `completed`
   * (with its `run.status` event). If that run is not paused the answer is `already-decided`; if
   * its approval window has closed it is `cancelled` and the answer is `approval-expired`. In
   * both cases no run is inserted. Omitted for an ordinary run.
   */
  readonly decides?: {
    readonly runId: string;
    /** Retention for the paused run's `run.status` event, as for `finish`. */
    readonly statusEventMaxEvents?: number;
  };
}

/** A start key: unique per workspace and principal (ADR-0151, #250). */
interface RunIdempotency {
  readonly principalId: string;
  readonly key: string;
  readonly requestHash: string;
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
  readonly status: SessionStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
