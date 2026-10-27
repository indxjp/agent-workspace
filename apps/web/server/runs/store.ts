/**
 * The run store — run records and their event logs (spec §27 `runs`, §34, §19).
 *
 * Two things live behind one port on purpose: a run's status and a run's events are read
 * together on every request that matters (`GET /api/runs/:id` shows the status the event log
 * ends with) and written together on every transition, so splitting them buys two adapters that
 * can disagree.
 *
 * **R-13's conclusion, restated as the port's contract.** Google Cloud Run caps a request at
 * under 60 minutes, so a long agent run is necessarily several SSE connections; spec §14.6 says
 * durability lives in PostgreSQL and object storage, never in the ephemeral thing. Therefore
 * {@link RunStore} is defined as *"replay from an event id, then follow"* and never as
 * *"stream a run"*. Every adapter must be able to answer "what came after id N".
 *
 * ## Two implementations, two event logs, and the seam between them
 *
 * This file holds the port, the record types and the constants both adapters share. The adapters
 * live beside it: `InMemoryRunStore` in `./memory-store` keeps records in a `Map`, and
 * `createRepositoryRunStore` in `./repository-store` keeps them in the `runs` table, through
 * `packages/core/src/db/repositories/runs.ts`, where the tenant is a `WorkspaceScope` the compiler
 * will not let a caller fabricate. `store.test.ts` runs one conformance suite against both.
 *
 * The in-memory adapter uses `RunEventLog`; the repository adapter uses the durable,
 * scope-bound `run_events` repository. The two adapters retain the same replay/follow contract,
 * while only the database-backed adapter survives process restart. The earlier process-only
 * decision is preserved as superseded history in
 * `docs/adr/W2-DB-02-the-run-event-log-has-no-table.md`.
 *
 * ## What this port does NOT do, and why it is written down here
 *
 * {@link RunStore} identifies a run by **id alone**: `get`, `markRunning`, `finish`, `append` and
 * `openStream` take no workspace. That is W1-CP-04's shape — `api.ts` reads the run and then
 * compares `run.workspaceId` against the principal's — and the three §34 route handlers that
 * depend on it are outside this task's ownership globs. So the repository underneath IS
 * scope-bound and every query it issues carries the tenant, while the *port* is not, and the
 * database adapter therefore performs exactly one query that is scoped by run id alone in order
 * to find which scope to use (`findRunWorkspace` in core, which returns a workspace id and no row
 * content). Converting the port itself is named as follow-up work in
 * `docs/adr/W2-DB-02-the-run-port-is-not-scope-bound.md` rather than left to be discovered.
 */
import type { EngineId } from '@indx-workspace/contracts/engines';
import {
  type ModelProvider,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '@indx-workspace/contracts/runs';

import type { PlatformEventName, SseEvent } from './sse';

/**
 * The run lifecycle this port serves, from `@indx-workspace/contracts/runs` (not from
 * `@agent-workspace/core`, which would reach the edge bundle). A test asserts it matches the
 * database schema's list.
 */
export const runStatuses = RUN_STATUSES;
export type RunStatus = (typeof runStatuses)[number];

/** The statuses at which a run is over. A terminal run's event stream ends rather than follows. */
export const terminalRunStatuses = TERMINAL_RUN_STATUSES;
const TERMINAL: ReadonlySet<string> = new Set(terminalRunStatuses);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/** Terminal, or paused at `awaiting_approval` (ADR-0145): nothing runs, so the event log is closed. */
export { isStoppedRunStatus } from '@indx-workspace/contracts/runs';

/** The tool call a run paused on, and the form of it an approval lets a continuation run. */
export interface ApprovalCall {
  readonly toolName: string;
  readonly canonicalCall: string;
}

/**
 * The accounting-state vocabulary (issue #134), transcribed for the same reason
 * {@link runStatuses} is: a value import of `@agent-workspace/core`'s schema at this module's top
 * level would reach the edge bundle. `api.test.ts` asserts this list agrees with the schema's.
 */
export const accountingStates = [
  'pending',
  'complete',
  'partial',
  'failed',
  'unavailable',
] as const;
type AccountingState = (typeof accountingStates)[number];

/**
 * One run, as `GET /api/runs/:id` **and** `GET /api/runs` render it (issue #135) — the same
 * shape, because `api.ts`'s `renderRun` is the one function both routes call. See this file's
 * header for why every field beyond the first six is optional: a caller that never obtains a
 * `RunRecord` from `get()`/`listRuns()` is not making this promise up.
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
  readonly model?: string | null;
  /** The **model** provider that served the calls, never the engine that made them (ADR-0065). */
  readonly provider?: string | null;
  /** Which connection resolved this run (issue #129). NULL until resolved, or once deleted. */
  readonly modelConnectionId?: string | null;
  /** The engine that executed the run (ADR-0065). NULL only for a run recorded before 0024. */
  readonly engine?: string | null;
  /** The adapter and third-party SDK version the runner reported. Opaque; NULL when unreported. */
  readonly engineVersion?: string | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly toolCalls?: number;
  readonly costUsd?: string;
  readonly costCurrency?: 'USD';
  readonly priceTableVersion?: string | null;
  /** §35's "errors": the failure message, null when the run did not fail. */
  readonly error: string | null;
  /** See {@link AccountingState}. Issue #134. */
  readonly accountingState?: AccountingState;
  /** Redacted settlement failure reason. Non-null only when `accountingState` is `'failed'`. */
  readonly accountingError?: string | null;
  /** The session's project (issue #135), reached the same way {@link agentId} is. */
  readonly projectId?: string | null;
  /** The session's initiating user (issue #135), reached the same way {@link agentId} is. */
  readonly initiatingUserId?: string | null;
  /** The number of the agent version the run's session pins (#612); `null` for a legacy session. */
  readonly agentVersion?: number | null;
  /** The exact workspace principal that owns the session. */
  readonly ownerPrincipalId?: string;
  /** The run's final answer (ADR-0143): `null` until `completed`, and for a failed or cancelled run. */
  readonly output?: RunOutput | null;
  /** The JSON Schema the run was asked to answer with (ADR-0143); `null` when it asked for none. */
  readonly outputSchema?: Readonly<Record<string, unknown>> | null;
  /** The caller identity the run acts for (ADR-0142 D2); an approval continuation keeps it (ADR-0157). */
  readonly subject?: string | null;
  /** The call a paused run waits on; non-null only while `awaiting_approval` (ADR-0145). */
  readonly pendingApproval?: ApprovalCall | null;
  /** The calls this run may make without asking: the ones its predecessor's approval admitted. */
  readonly approvedToolCalls?: readonly ApprovalCall[];
  /** The workspace paths this run was granted (ADR-0147), after any `fileScope`; `[]` when none. */
  readonly fileGrants?: readonly string[];
  /**
   * When {@link approvedToolCalls} were consumed: the moment the run left `queued` (ADR-0151).
   * `null` for a run with no approved calls and for one not yet started.
   */
  readonly approvalsConsumedAt?: Date | null;
}

/** A completed run's answer. `structured` is `null` when the run asked for no output schema. */
export interface RunOutput {
  readonly text: string;
  readonly structured: unknown;
}

/**
 * Every filter `RunStore.listRuns` composes, always intersected with the store's own workspace
 * scoping. See `packages/core/src/db/repositories/runs.ts`'s `RunListFilter`, which this mirrors
 * field for field — this module cannot import that type at runtime, for the reason this file's
 * header gives, so the shape is restated rather than shared.
 */
interface RunListFilter {
  readonly status?: RunStatus;
  readonly agentId?: string;
  readonly projectId?: string;
  readonly provider?: ModelProvider;
  readonly model?: string;
  /** `createdAt >= createdFrom`, inclusive. */
  readonly createdFrom?: Date;
  /**
   * `createdAt <= createdTo`, inclusive at millisecond precision — the only precision a `Date`
   * has, so a range built from a run's own rendered `createdAt` includes that run on both
   * implementations. `InMemoryRunStore` has no finer precision to begin with; the repository
   * holds microseconds and rounds the bound up to the next millisecond to say the same thing.
   */
  readonly createdTo?: Date;
  readonly initiatingUserId?: string;
  /** Exact session ownership, used for an own-grant collection read. */
  readonly ownerPrincipalId?: string;
}

/**
 * A keyset pagination boundary: the `(created_at, id)` pair of the previous page's last item.
 *
 * `createdAt` is an opaque string, not a `Date` — see
 * `packages/core/src/db/repositories/runs.ts`'s `RunListCursor` for why: a `Date` only holds
 * milliseconds, `runs.created_at` holds microseconds, and round-tripping the boundary through a
 * `Date` (as this port did before round 2 finding 1) silently drops rows that share a boundary's
 * millisecond but not its microseconds. Each implementation below mints and reads its own opaque
 * form of it — the repository-backed one at the database's full precision, `InMemoryRunStore` at
 * the only precision it ever has (`Date.prototype.toISOString`) — and this port, `api.ts`'s
 * encode/decode, and the caller in between never parse it as a timestamp themselves.
 */
export interface RunListCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface ListRunsInput {
  readonly filter?: RunListFilter;
  readonly limit: number;
  readonly cursor?: RunListCursor | null;
}

/**
 * The largest `limit` either implementation of this port will serve in one page.
 *
 * Restated from `MAX_RUN_LIST_LIMIT` in `packages/core/src/db/repositories/runs.ts` for the reason
 * {@link runStatuses} is restated — `apps/web` reaches `@agent-workspace/core` through
 * `import type` only, and a value import would mean a new runtime dependency in
 * `apps/web/package.json`. `store.test.ts` reads the core file as text and fails if the two
 * numbers stop agreeing.
 */
export const MAX_RUN_LIST_LIMIT = 200;

export interface RunListPage {
  readonly items: readonly RunRecord[];
  readonly nextCursor: RunListCursor | null;
}

export interface CreateRunInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly sessionId: string;
  /**
   * The engine that will execute the run (ADR-0065). Required, not defaulted: which engine ran a
   * run is history, and a default here would record `claude-agent-sdk` for a run some later engine
   * actually performed. `startRun` is the one caller that decides it.
   */
  readonly engine: EngineId;
  /**
   * Attribution `InMemoryRunStore` has nowhere else to learn (issue #135): the repository-backed
   * store reaches these through the session join instead, and ignores these fields here. They are
   * session facts supplied by `startRun`, not independent ownership claims made by a client.
   */
  readonly projectId?: string | null;
  readonly initiatingUserId?: string | null;
  readonly agentVersion?: number | null;
  /** Exact session ownership for the in-memory adapter, which has no session join. */
  readonly ownerPrincipalId?: string;
  /** The prompt, stored for the feedback list (issue #620). The in-memory store ignores it. */
  readonly prompt?: string;
  /** The JSON Schema object the run must answer with (ADR-0143). */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** The caller identity the run acts for, stored so an approval continuation inherits it (ADR-0157). */
  readonly subject?: string;
  /** The start request's `Idempotency-Key`, scoped to the acting principal (ADR-0151, #250). */
  readonly idempotency?: RunIdempotency;
  /** The calls a decision on a paused run admits for this continuation run (ADR-0145 D2.3). */
  readonly approvedToolCalls?: readonly ApprovalCall[];
  /**
   * Makes this run the continuation of the paused run `runId` in the same session: the paused run
   * is completed in the transaction that inserts this one, so exactly one decision can win.
   * {@link RunStore.create} then throws {@link ApprovalDecisionError} instead of creating a run.
   */
  readonly decides?: string;
}

/** A start key, the principal it belongs to, and the hash of the request it was first used with. */
export interface RunIdempotency {
  readonly principalId: string;
  readonly key: string;
  readonly requestHash: string;
}

/** An event on its way in. The id is assigned by the store, never by the caller. */
export interface AppendEventInput {
  readonly type: string;
  readonly data: unknown;
}

/** A platform lifecycle event on its way in. The name is narrowed at the type level too. */
export interface PlatformEventInput {
  readonly type: PlatformEventName;
  readonly data: unknown;
}

/** Total, explicit outcome of an append. `rejected` names what was wrong and stores nothing. */
export type AppendResult =
  | { readonly kind: 'appended'; readonly event: SseEvent }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Why a resume cursor could not be honoured, when the events it names are gone.
 *
 * The client is told in band, as a `stream-reset` frame, and never by silently starting from
 * somewhere else: a gap the client cannot see is a gap it will render as a complete transcript.
 */
export interface StreamResetNotice {
  readonly reason: string;
  /** The oldest id the stream can actually start after, or null when nothing is retained. */
  readonly resumedAfter: string | null;
}

/** An open subscription: the backlog and the live tail, as one sequence. */
export interface RunStreamHandle {
  /** Non-null when the requested cursor could not be served and the client must resynchronise. */
  readonly reset: StreamResetNotice | null;
  /** Replay then live, oldest first, ending when the run reaches a terminal status. */
  readonly events: AsyncIterable<SseEvent>;
  /** Release the subscription. Idempotent. */
  close(): void;
}

/**
 * {@link RunStore.create} refused: the session already has a `queued` or `running` run, and two
 * runs resuming one engine session would interleave its transcript. The repository store decides
 * it under the session lock in core `create`; the in-memory test double does not model it.
 */
export class SessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} already has a run in progress`);
    this.name = 'SessionBusyError';
  }
}

/**
 * Another run of this workspace and principal already holds the start key (ADR-0151). Thrown by
 * {@link RunStore.create} when two starts with one key race; the caller answers with
 * {@link RunStore.findByIdempotencyKey}.
 */
export class IdempotencyKeyTakenError extends Error {
  constructor(readonly key: string) {
    super('another run already holds this Idempotency-Key');
    this.name = 'IdempotencyKeyTakenError';
  }
}

/** {@link CreateRunInput.decides} named a run that cannot be decided; no run was created. */
export class ApprovalDecisionError extends Error {
  constructor(
    readonly runId: string,
    /** `expired`: the 24-hour window had closed and the paused run was cancelled instead. */
    readonly reason: 'already-decided' | 'expired',
  ) {
    super(`run ${runId} cannot be decided: ${reason}`);
    this.name = 'ApprovalDecisionError';
  }
}

export interface RunStore {
  /**
   * Throws {@link ApprovalDecisionError} when `decides` names a run that is not awaiting approval
   * (judged first, #1440), {@link IdempotencyKeyTakenError} when `input.idempotency`'s key is
   * already held (judged before the session's busy check, so a racing retry is replayed), and
   * {@link SessionBusyError} when the session already has a non-terminal run. A refusal leaves
   * the paused run `decides` names untouched.
   */
  create(input: CreateRunInput): Promise<RunRecord>;
  get(runId: string): Promise<RunRecord | null>;
  /**
   * The run `principalId` started in `workspaceId` with this key, whatever its status, and the
   * hash of the request it was started with; `null` when there is none. A paused run keeps its key.
   */
  findByIdempotencyKey(
    workspaceId: string,
    principalId: string,
    key: string,
  ): Promise<{ readonly run: RunRecord; readonly requestHash: string } | null>;
  /**
   * Move a queued run to `running`, stamping `startedAt`. No-op if it already started.
   *
   * Reports whether **this** call performed the transition. `false` means the run was not
   * `queued`: it is already running, it is already terminal, or this store has never seen it.
   * The launcher reads that as "this run is no longer mine to start" — an interrupt that lands
   * while a run is still queued makes it terminal before anything is posted to a runtime (issue
   * #235, `docs/adr/SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md`) — which is a
   * fact only the transition itself knows, and a separate read back would race with it.
   */
  markRunning(runId: string): Promise<boolean>;
  /** Move a run to a terminal status. When requested, commit its status event in the same step. */
  finish(
    runId: string,
    status: RunStatus,
    error: string | null,
    emitStatusEvent?: boolean,
    output?: RunOutput | null,
  ): Promise<void>;
  /**
   * Pause a running run for a human decision (ADR-0145): status `awaiting_approval`, the call it
   * waits on stored, and the `run.status` event committed with it. No-op unless the run is running.
   */
  awaitApproval(runId: string, call: ApprovalCall): Promise<void>;
  /**
   * Write the resolved model/provider/connection onto the run row (issue #129), before the run is
   * handed to a runtime, so a queued or failed run identifies what it attempted. A no-op if the
   * run no longer exists.
   */
  snapshotModel(
    runId: string,
    input: { readonly connectionId: string; readonly model: string; readonly provider: string },
  ): Promise<void>;
  /**
   * Append a **relayed** event: one whose name came from outside this control plane.
   *
   * The name is checked against the reserved list, so a runtime cannot write a control-frame name
   * or one of the platform's own lifecycle events. This is the only append the relay is given.
   */
  append(runId: string, event: AppendEventInput): Promise<AppendResult>;
  /**
   * Append one of the **platform's own** lifecycle events (`run.status`).
   *
   * Separate from {@link append} because the two have different trust: `append` refuses every
   * reserved name, and this one accepts nothing else. Splitting them is what lets the reservation
   * cover `run.status` at all — a single method could only either let a runtime forge the
   * platform's event or stop the platform writing it.
   */
  appendPlatformEvent(runId: string, event: PlatformEventInput): Promise<AppendResult>;
  /**
   * Open a stream over one run.
   *
   * `after` is the client's resume cursor: deliver everything with a strictly greater id. `null`
   * means "from the beginning", which is a first connection's defined meaning.
   */
  openStream(runId: string, after: bigint | null): Promise<RunStreamHandle | null>;
  /**
   * Every run in one workspace, newest first, filtered and cursor-paginated (issue #135).
   *
   * Takes a workspace id explicitly — the one member of this port that does, because a
   * *collection* has no id of its own to look a workspace up from the way every other method here
   * does (see this file's header).
   */
  listRuns(workspaceId: string, input: ListRunsInput): Promise<RunListPage>;
}

/**
 * Per-run retention, counted in **frames** (rows), not engine messages: since ENG-03 one engine
 * message is one row per `agent.*` frame it maps to, so an assistant turn with prose and five tool
 * calls is six rows. A ten-minute run at one message per second is ~600 messages, a few thousand
 * frames for a tool-heavy one; this is still a wide margin.
 */
const DEFAULT_MAX_EVENTS_PER_RUN = 50_000;

/** A sane positive integer, or the default. Parsed before it is compared (ADR-0015). */
export function eventRetentionLimit(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_EVENTS_PER_RUN;
}
