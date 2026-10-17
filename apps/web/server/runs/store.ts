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
 * {@link InMemoryRunStore} keeps records in a `Map`. {@link createRepositoryRunStore} keeps them
 * in the `runs` table, through `packages/core/src/db/repositories/runs.ts`, where the tenant is a
 * `WorkspaceScope` the compiler will not let a caller fabricate. `store.test.ts` runs one
 * conformance suite against both.
 *
 * The in-memory adapter uses {@link RunEventLog}; the repository adapter uses the durable,
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
import { MODEL_PROVIDERS, type ModelProvider } from '@indx-workspace/contracts/runs';
import type {
  RunEventRepository as CoreRunEventRepository,
  RunEventRepositoryProvider as CoreRunEventRepositoryProvider,
  RunRepository as CoreRunRepository,
  RunRepositoryProvider as CoreRunRepositoryProvider,
  WorkspaceScope as CoreWorkspaceScope,
  WorkspaceScopeResolver as CoreWorkspaceScopeResolver,
} from '@agent-workspace/core/db';

import {
  classifyEventName,
  classifyPlatformEventName,
  renderEventData,
  RUN_STATUS_EVENT,
  type PlatformEventName,
  type SseEvent,
} from './sse';

/**
 * The run lifecycle, transcribed from `packages/core/src/db/schema/runs.ts` rather than invented.
 * It is restated instead of imported because `apps/web` does not depend on
 * `@agent-workspace/core` and adding that dependency means editing `apps/web/package.json`,
 * which is not this task's to edit. A test asserts the two lists are identical.
 */
export const runStatuses = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof runStatuses)[number];

/** The statuses at which a run is over. A terminal run's event stream ends rather than follows. */
export const terminalRunStatuses = ['completed', 'failed', 'cancelled'] as const;
const TERMINAL: ReadonlySet<string> = new Set(terminalRunStatuses);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/** A provider read back from the database, narrowed by a positive assertion (ADR-0015). */
function parseModelProvider(value: string): ModelProvider {
  if (!(MODEL_PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(`${JSON.stringify(value)} is not a recognised model provider`);
  }
  return value as ModelProvider;
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
export type AccountingState = (typeof accountingStates)[number];

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
  /** The exact workspace principal that owns the session. */
  readonly ownerPrincipalId?: string;
}

/**
 * Every filter `RunStore.listRuns` composes, always intersected with the store's own workspace
 * scoping. See `packages/core/src/db/repositories/runs.ts`'s `RunListFilter`, which this mirrors
 * field for field — this module cannot import that type at runtime, for the reason this file's
 * header gives, so the shape is restated rather than shared.
 */
export interface RunListFilter {
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
 * `apps/web/package.json`. `store.test.ts` reads the core file (and `api.ts`'s own copy) as text
 * and fails if the three numbers stop agreeing.
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
  /** Exact session ownership for the in-memory adapter, which has no session join. */
  readonly ownerPrincipalId?: string;
  /** The prompt, stored for the feedback list (issue #620). The in-memory store ignores it. */
  readonly prompt?: string;
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

/** How many events one stream reads per query, so a replay of a long run is never one huge read. */
const EVENT_PAGE_SIZE = 500;
/** A stream's poll interval: the first wait, and the longest one a quiet run backs off to. */
const POLL_MIN_MS = 250;
const POLL_MAX_MS = 2_000;
/** How many run-to-workspace lookups one repository store remembers. */
const REMEMBERED_RUN_WORKSPACES = 10_000;

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

export interface RunStore {
  /** Throws {@link SessionBusyError} when the session already has a non-terminal run. */
  create(input: CreateRunInput): Promise<RunRecord>;
  get(runId: string): Promise<RunRecord | null>;
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
  ): Promise<void>;
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
   * does (see this file's header). Optional on the interface, not because either implementation
   * below omits it, but so that a future third implementation of this port compiles without it and
   * `apps/web/server/runs/api.ts` can treat a missing implementation the same 503 way it already
   * treats `revokeRunTokens` being absent, rather than that becoming this task's problem to solve.
   */
  listRuns?(workspaceId: string, input: ListRunsInput): Promise<RunListPage>;
}

/**
 * Per-run retention, counted in **frames** (rows), not engine messages: since ENG-03 one engine
 * message is one row per `agent.*` frame it maps to, so an assistant turn with prose and five tool
 * calls is six rows. A ten-minute run at one message per second is ~600 messages, a few thousand
 * frames for a tool-heavy one; this is still a wide margin.
 */
export const DEFAULT_MAX_EVENTS_PER_RUN = 50_000;

/** One run's event log, as this process holds it. */
interface EventLogState {
  /** Retained events, oldest first. Ids are contiguous within the array but not from 1. */
  events: SseEvent[];
  /** The id assigned to the most recent event, retained or evicted. */
  lastId: bigint;
  /** How many events have been evicted, so a cursor into the evicted range can be detected. */
  evicted: bigint;
  /** Set when the run reaches a terminal status: the log is closed and open streams must end. */
  closed: boolean;
  listeners: Set<() => void>;
}

/**
 * The event half of {@link RunStore}, in process, used by {@link InMemoryRunStore} only.
 *
 * It centralizes ids, retention, reset notices and the wake-up protocol for the in-memory adapter.
 * The repository adapter implements the same public contract through the durable event repository
 * and has a separate cross-process polling protocol.
 *
 * **Single-threaded JavaScript is what makes {@link stream} race-free**: the backlog read and the
 * listener registration happen in one synchronous tick, so no event can be appended between them.
 * The PostgreSQL adapter cannot rely on that guarantee, so {@link createRepositoryRunStore}
 * registers its waiter before reading the backlog and re-polls every 250 ms. Per-run ordering is
 * serialized by the advisory lock in `packages/core/src/db/repositories/runs.ts`; there is no
 * database LISTEN/NOTIFY wake-up path.
 *
 * **It grows without bound, and that is a property, not an oversight.** Retention is per run
 * ({@link DEFAULT_MAX_EVENTS_PER_RUN} caps one run's event array), but *runs themselves are never
 * evicted*: {@link open} adds an entry and nothing ever removes one, so a process retains every
 * run it has served, terminal or not, until the process exits.
 */
class RunEventLog {
  readonly #logs = new Map<string, EventLogState>();
  readonly #maxEvents: number;
  readonly #now: () => Date;

  public constructor(maxEvents: number, now: () => Date) {
    this.#maxEvents = maxEvents;
    this.#now = now;
  }

  /** Start a log for a run. Idempotent: re-opening a known run leaves its events alone. */
  public open(runId: string): void {
    if (this.#logs.has(runId)) return;
    this.#logs.set(runId, {
      events: [],
      lastId: 0n,
      evicted: 0n,
      closed: false,
      listeners: new Set(),
    });
  }

  /** Does this process hold a log for that run? */
  public knows(runId: string): boolean {
    return this.#logs.has(runId);
  }

  /** Close the log and wake every open stream so it can finish rather than hang. */
  public close(runId: string): void {
    const state = this.#logs.get(runId);
    if (state === undefined) return;
    state.closed = true;
    this.#wake(state);
  }

  /**
   * Append one already-classified event.
   *
   * The name has been checked by the caller — `append` refuses every reserved name and
   * `appendPlatformEvent` accepts nothing else — so what is left here is the two rejections that
   * are about the log rather than about the name: an unknown run, and a closed one.
   */
  public write(runId: string, type: string, data: unknown): AppendResult {
    const state = this.#logs.get(runId);
    if (state === undefined) return { kind: 'rejected', reason: `no run ${runId}` };
    if (state.closed) {
      return { kind: 'rejected', reason: `run ${runId} is finished; its event log is closed` };
    }
    const payload = renderEventData(data);
    if (payload.kind !== 'ok') return { kind: 'rejected', reason: payload.reason };

    state.lastId += 1n;
    const stored: SseEvent = { id: state.lastId, type, data, at: this.#now() };
    state.events.push(stored);
    while (state.events.length > this.#maxEvents) {
      state.events.shift();
      state.evicted += 1n;
    }
    this.#wake(state);
    return { kind: 'appended', event: stored };
  }

  /** Open a stream over one run, or `null` when this process holds no log for it. */
  public stream(runId: string, after: bigint | null): RunStreamHandle | null {
    const state = this.#logs.get(runId);
    if (state === undefined) return null;

    // The oldest id still retained. `evicted` counts events dropped from the front, and ids start
    // at 1, so the first retained id is `evicted + 1`.
    const oldestRetained = state.evicted + 1n;
    let cursor = after ?? 0n;
    let reset: StreamResetNotice | null = null;
    if (cursor < state.evicted) {
      // The events between the client's cursor and what is retained are gone. Say so.
      reset = {
        reason:
          after === null
            ? `the beginning of run ${runId}'s event log is no longer retained; the stream starts at the oldest retained event`
            : `events after ${String(cursor)} are no longer retained for run ${runId}; the stream resumes at the oldest retained event and is not contiguous with what you already have`,
        resumedAfter: state.events.length > 0 ? String(oldestRetained - 1n) : null,
      };
      cursor = state.evicted;
    }
    if (after !== null && after > state.lastId) {
      // A cursor ahead of anything this run ever produced. Not a gap — a wrong id, or a client
      // resuming against a different run. Refuse to guess; restart it and say why.
      reset = {
        reason: `run ${runId} has no event after ${String(after)} (its latest id is ${String(state.lastId)}); the stream restarts from the oldest retained event`,
        resumedAfter: state.events.length > 0 ? String(oldestRetained - 1n) : null,
      };
      cursor = state.evicted;
    }

    let closed = false;
    let wake: (() => void) | null = null;
    const notify = (): void => {
      const w = wake;
      wake = null;
      if (w) w();
    };
    state.listeners.add(notify);
    const close = (): void => {
      if (closed) return;
      closed = true;
      state.listeners.delete(notify);
      notify();
    };

    /** The stream is finished when the run is over and everything it produced has been sent. */
    const exhausted = (): boolean => state.closed && cursor >= state.lastId;

    const events = (async function* (): AsyncGenerator<SseEvent> {
      try {
        for (;;) {
          if (closed) return;
          // Everything retained with an id strictly greater than the cursor.
          const pending = state.events.filter((e) => e.id > cursor);
          for (const event of pending) {
            if (closed) return;
            cursor = event.id;
            yield event;
          }
          if (closed) return;
          if (exhausted()) return;

          // Arm the waiter BEFORE re-testing the condition, and never the other way round.
          // While this generator is suspended at a `yield`, `wake` is null, so an `append`
          // during that window finds no resolver and its notification is simply dropped. A bare
          // `await` here would then sleep through events that already exist — a lost wakeup that
          // strands a run's tail until some later event happens to arrive. Arming first makes
          // every subsequent append find a live resolver, and the re-test below catches every
          // append that happened before the arming.
          const armed = new Promise<void>((resolve) => {
            wake = resolve;
          });
          const alreadyReady = closed || exhausted() || state.events.some((e) => e.id > cursor);
          if (!alreadyReady) await armed;
          wake = null;
        }
      } finally {
        close();
      }
    })();

    return { reset, events, close };
  }

  #wake(state: EventLogState): void {
    for (const listener of [...state.listeners]) listener();
  }
}

/** A sane positive integer, or the default. Parsed before it is compared (ADR-0015). */
function retention(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_EVENTS_PER_RUN;
}

export interface InMemoryRunStoreOptions {
  readonly maxEventsPerRun?: number;
  readonly now?: () => Date;
}

/**
 * The in-process adapter: records in a `Map`, events in a {@link RunEventLog}.
 *
 * **Nothing here survives the process.** A restart loses every run and every event. That is why it
 * is not what a deployment installs — see {@link createRepositoryRunStore}.
 *
 * There is no operator opt-in that installs this in a real deployment, and there is no memory
 * fallback of any kind. `apps/web/instrumentation.ts` never names this class: a process whose
 * database is unreachable installs **nothing** and every `/api/**` route answers 503 by name,
 * because every request is authorised by reading `workspaces`, `users` and `memberships`, so a
 * process with no database can authorise nobody and this store would never be reached.
 * `docs/adr/W2-DB-02-no-silent-memory-fallback.md` records that decision.
 *
 * Verification round 1 found this comment claiming that `instrumentation.ts` "refuses to install it
 * unless an operator asked for it by name". No such mechanism existed in any form, and the sentence
 * contradicted the ADR above; it is deleted rather than implemented.
 *
 * Verification round 2 found the replacement sentence — "its two real consumers are …" — also
 * wrong, and wrong in the same way: a count nobody measured. What replaces it is not a better
 * count but a gate. `store.test.ts` parses every tracked module in the repository, derives the set
 * that imports this class, and classifies each importer as a `*.test.ts` suite or as the
 * acceptance harness that refuses to run without `AW_ACCEPTANCE_HARNESS`. Anything else fails by
 * name. So "no deployment path constructs this" is checked rather than asserted, and this
 * paragraph cannot go stale without a test going red.
 */
export class InMemoryRunStore implements RunStore {
  readonly #records = new Map<string, RunRecord>();
  readonly #events: RunEventLog;
  readonly #now: () => Date;

  constructor(options: InMemoryRunStoreOptions = {}) {
    this.#now = options.now ?? ((): Date => new Date());
    this.#events = new RunEventLog(retention(options.maxEventsPerRun), this.#now);
  }

  create(input: CreateRunInput): Promise<RunRecord> {
    if (this.#records.has(input.id)) {
      return Promise.reject(new Error(`run ${input.id} already exists`));
    }
    const record: RunRecord = {
      id: input.id,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      status: 'queued',
      createdAt: this.#now(),
      startedAt: null,
      endedAt: null,
      model: null,
      provider: null,
      modelConnectionId: null,
      engine: input.engine,
      engineVersion: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      toolCalls: 0,
      costUsd: '0.000000',
      costCurrency: 'USD',
      priceTableVersion: null,
      error: null,
      accountingState: 'pending',
      accountingError: null,
      projectId: input.projectId ?? null,
      // `exactOptionalPropertyTypes` refuses an explicit `undefined` for an optional `string`
      // field, so an omitted `initiatingUserId` must omit the key entirely rather than assign it.
      ...(input.initiatingUserId === undefined ? {} : { initiatingUserId: input.initiatingUserId }),
      ...(input.ownerPrincipalId === undefined ? {} : { ownerPrincipalId: input.ownerPrincipalId }),
    };
    this.#records.set(input.id, record);
    this.#events.open(input.id);
    return Promise.resolve(record);
  }

  get(runId: string): Promise<RunRecord | null> {
    return Promise.resolve(this.#records.get(runId) ?? null);
  }

  markRunning(runId: string): Promise<boolean> {
    const record = this.#records.get(runId);
    if (record === undefined) return Promise.resolve(false);
    if (record.status !== 'queued') return Promise.resolve(false);
    this.#records.set(runId, { ...record, status: 'running', startedAt: this.#now() });
    return Promise.resolve(true);
  }

  finish(
    runId: string,
    status: RunStatus,
    error: string | null,
    emitStatusEvent = false,
  ): Promise<void> {
    if (!isTerminalRunStatus(status)) {
      return Promise.reject(new Error(`${status} is not a terminal run status`));
    }
    const record = this.#records.get(runId);
    if (record === undefined) return Promise.resolve();
    if (isTerminalRunStatus(record.status)) return Promise.resolve();
    if (emitStatusEvent) {
      const appended = this.#events.write(runId, RUN_STATUS_EVENT, { status, error });
      if (appended.kind !== 'appended') return Promise.reject(new Error(appended.reason));
    }
    const now = this.#now();
    this.#records.set(runId, {
      ...record,
      status,
      // The database's `runs_ended_at_iff_terminal` check requires both stamps to be coherent,
      // so a run that is finished without ever having been marked running still gets a start.
      startedAt: record.startedAt ?? now,
      endedAt: now,
      error,
    });
    this.#events.close(runId);
    return Promise.resolve();
  }

  snapshotModel(
    runId: string,
    input: { readonly connectionId: string; readonly model: string; readonly provider: string },
  ): Promise<void> {
    const record = this.#records.get(runId);
    if (record === undefined) return Promise.resolve();
    this.#records.set(runId, {
      ...record,
      model: input.model,
      provider: input.provider,
      modelConnectionId: input.connectionId,
    });
    return Promise.resolve();
  }

  /**
   * Ingestion is where an event name and payload are checked, so that everything in the log is
   * renderable and `sseFrame` can treat a failure as a broken invariant rather than as input.
   * A relayed name is refused if it is reserved; see {@link appendPlatformEvent} for the other
   * half of that reservation.
   */
  append(runId: string, event: AppendEventInput): Promise<AppendResult> {
    const name = classifyEventName(event.type);
    if (name.kind !== 'ok') return Promise.resolve({ kind: 'rejected', reason: name.reason });
    return Promise.resolve(this.#events.write(runId, name.name, event.data));
  }

  appendPlatformEvent(runId: string, event: PlatformEventInput): Promise<AppendResult> {
    // Checked at run time as well as in the type, because the caller may be JavaScript, or an
    // adapter deserialising a value: a name is admitted because it IS a platform event name.
    const name = classifyPlatformEventName(event.type);
    if (name.kind !== 'ok') return Promise.resolve({ kind: 'rejected', reason: name.reason });
    return Promise.resolve(this.#events.write(runId, name.name, event.data));
  }

  openStream(runId: string, after: bigint | null): Promise<RunStreamHandle | null> {
    return Promise.resolve(this.#events.stream(runId, after));
  }

  listRuns(workspaceId: string, input: ListRunsInput): Promise<RunListPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      return Promise.reject(new Error('listRuns limit must be a safe positive integer'));
    }
    // The same ceiling, with the same message, the repository refuses by: the port promises one
    // answer from two implementations, and a direct caller that reaches this store instead of the
    // repository must not discover a page size the other half of the port would have refused.
    if (input.limit > MAX_RUN_LIST_LIMIT) {
      return Promise.reject(
        new Error(`listRuns limit must not exceed ${String(MAX_RUN_LIST_LIMIT)}`),
      );
    }
    const filter = input.filter ?? {};
    const matches = (run: RunRecord): boolean => {
      if (run.workspaceId !== workspaceId) return false;
      if (filter.status !== undefined && run.status !== filter.status) return false;
      if (filter.agentId !== undefined && run.agentId !== filter.agentId) return false;
      if (filter.projectId !== undefined && run.projectId !== filter.projectId) return false;
      if (filter.provider !== undefined && run.provider !== filter.provider) return false;
      if (filter.model !== undefined && run.model !== filter.model) return false;
      if (filter.createdFrom !== undefined && run.createdAt < filter.createdFrom) return false;
      if (filter.createdTo !== undefined && run.createdAt > filter.createdTo) return false;
      if (
        filter.initiatingUserId !== undefined &&
        run.initiatingUserId !== filter.initiatingUserId
      ) {
        return false;
      }
      if (
        filter.ownerPrincipalId !== undefined &&
        run.ownerPrincipalId !== filter.ownerPrincipalId
      ) {
        return false;
      }
      return true;
    };
    // Newest first, `id` breaking a tie on `createdAt` — the same total order the repository-backed
    // store's SQL `ORDER BY` produces, so a keyset cursor minted by one page means the same thing on
    // the next regardless of which implementation is behind the port.
    const ordered = [...this.#records.values()].filter(matches).sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) return byTime;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    const cursor = input.cursor ?? null;
    // `cursor.createdAt` is the opaque string this store itself minted below
    // (`Date.prototype.toISOString`, this store's only precision), parsed back to compare — never
    // held as a `Date` across the boundary, for the reason `RunListCursor`'s doc comment gives.
    const cursorTime = cursor === null ? null : new Date(cursor.createdAt).getTime();
    const afterCursor =
      cursor === null || cursorTime === null
        ? ordered
        : ordered.filter((run) => {
            const runTime = run.createdAt.getTime();
            return runTime < cursorTime || (runTime === cursorTime && run.id < cursor.id);
          });
    const hasMore = afterCursor.length > input.limit;
    const page = hasMore ? afterCursor.slice(0, input.limit) : afterCursor;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? { createdAt: last.createdAt.toISOString(), id: last.id }
        : null;
    return Promise.resolve({ items: page, nextCursor });
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The PostgreSQL implementation of the same port.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What {@link createRepositoryRunStore} needs, and the whole of it.
 *
 * Every member is an interface from `@agent-workspace/core/db`, imported as a **type**. The
 * reason is mechanical and is the same one `../agents/store.ts` gives: `instrumentation.ts` is
 * compiled for the edge runtime as well as for Node, `import type` is erased before any bundler
 * sees it, and a value import of core here would drag `pg` and `node:fs` onto the edge. The
 * composition root builds the implementations — it is the only module that holds a `Database`
 * handle — and hands them over.
 */
export interface RepositoryRunStoreDependencies {
  /** Builds a run repository from a scope. `packages/core/src/db/repositories/runs.ts`. */
  readonly repositories: CoreRunRepositoryProvider;
  /** Builds the durable, scope-bound replay log for a run. */
  readonly events: CoreRunEventRepositoryProvider;
  /** Turns a workspace id into a scope, or answers `null`. `.../repositories/scope.ts`. */
  readonly scopes: CoreWorkspaceScopeResolver;
  /**
   * Which workspace a run belongs to, by run id alone.
   *
   * The one unscoped read in this adapter, and it is here because {@link RunStore}'s port is not
   * scope-bound — see this file's header. It returns a workspace id and no row content, so
   * nothing crosses a tenant boundary through it; what it does is tell this adapter which scope
   * to build before every other query, each of which is then filtered on that scope. `null` means
   * no run has that id, and every caller treats that as "not found" rather than carrying on.
   */
  readonly findRunWorkspace: (runId: string) => Promise<string | null>;
  /** Per-run event retention, as {@link InMemoryRunStoreOptions.maxEventsPerRun}. */
  readonly maxEventsPerRun?: number;
}

/**
 * The database-backed {@link RunStore}: records in `runs` and replayable events in `run_events`.
 *
 * Both halves survive restart:
 *
 * | | across a restart |
 * | --- | --- |
 * | the run record — id, session, status, timestamps, error | **kept** |
 * | the run's event log | **kept** |
 *
 * Waiters remain process-local notifications, but replay always reads the durable repository.
 * A reconnect to another process therefore replays committed events before following new ones.
 */
export function createRepositoryRunStore(dependencies: RepositoryRunStoreDependencies): RunStore {
  const maxEvents = retention(dependencies.maxEventsPerRun);
  const waiters = new Map<string, Set<() => void>>();

  /**
   * The workspace a run belongs to, remembered once this process has looked it up. Bounded, oldest
   * first out, so a long-lived replica does not keep one entry per run it ever served; a forgotten
   * run costs one `findRunWorkspace` on its next use.
   */
  const workspaceOfRun = new Map<string, string>();
  const remember = (runId: string, workspaceId: string): void => {
    workspaceOfRun.delete(runId);
    workspaceOfRun.set(runId, workspaceId);
    if (workspaceOfRun.size > REMEMBERED_RUN_WORKSPACES) {
      const oldest = workspaceOfRun.keys().next();
      if (oldest.done !== true) workspaceOfRun.delete(oldest.value);
    }
  };

  /** The scope for a workspace id, or a thrown error naming the workspace that is gone. */
  const scopeFor = async (workspaceId: string): Promise<CoreWorkspaceScope> => {
    const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
    if (scope === null) {
      throw new Error(
        `no workspace has id ${workspaceId}; a run store cannot be scoped to a workspace that does not exist`,
      );
    }
    return scope;
  };

  /** The repositories for the run's own workspace, or `null` when no run has that id. */
  const repositoriesForRun = async (
    runId: string,
  ): Promise<{ runs: CoreRunRepository; events: CoreRunEventRepository } | null> => {
    const workspaceId = workspaceOfRun.get(runId) ?? (await dependencies.findRunWorkspace(runId));
    // The explicit else: no workspace means no run, and every caller turns that into the same
    // answer the in-memory store gives for an id it has never seen.
    if (workspaceId === null) return null;
    remember(runId, workspaceId);
    const scope = await scopeFor(workspaceId);
    return {
      runs: dependencies.repositories.forScope(scope),
      events: dependencies.events.forScope(scope),
    };
  };

  const repositoryForRun = async (runId: string): Promise<CoreRunRepository | null> =>
    (await repositoriesForRun(runId))?.runs ?? null;

  const wake = (runId: string): void => {
    for (const notify of [...(waiters.get(runId) ?? [])]) notify();
  };

  const append = async (runId: string, type: string, data: unknown): Promise<AppendResult> => {
    const payload = renderEventData(data);
    if (payload.kind !== 'ok') return { kind: 'rejected', reason: payload.reason };
    const repositories = await repositoriesForRun(runId);
    if (repositories === null) return { kind: 'rejected', reason: `no run ${runId}` };
    const run = await repositories.runs.get(runId);
    if (run === null) return { kind: 'rejected', reason: `no run ${runId}` };
    if (isTerminalRunStatus(run.status)) {
      return { kind: 'rejected', reason: `run ${runId} is finished; its event log is closed` };
    }
    const stored = await repositories.events.append(runId, type, data, maxEvents);
    if (stored === null) return { kind: 'rejected', reason: `no run ${runId}` };
    wake(runId);
    return { kind: 'appended', event: stored };
  };

  return {
    async create(input: CreateRunInput): Promise<RunRecord> {
      const repository = dependencies.repositories.forScope(await scopeFor(input.workspaceId));
      const outcome = await repository.create({
        id: input.id,
        sessionId: input.sessionId,
        engine: input.engine,
        prompt: input.prompt ?? null,
      });
      if (outcome.kind === 'duplicate-id') {
        // The same message the in-memory store rejects with, because `api.ts` and the conformance
        // suite both read it and two spellings of one failure is two failures to handle.
        throw new Error(`run ${input.id} already exists`);
      }
      if (outcome.kind === 'session-busy') throw new SessionBusyError(input.sessionId);
      if (outcome.kind === 'unknown-session') {
        throw new Error(
          `no session ${input.sessionId} in workspace ${input.workspaceId}; a run row references its session (runs_session_workspace_fk)`,
        );
      }
      remember(input.id, input.workspaceId);
      // `agentId` comes back from the session the run belongs to, never from the caller: the
      // `runs` table stores no `agent_id`, precisely so it cannot disagree with the session's.
      return outcome.run;
    },

    async get(runId: string): Promise<RunRecord | null> {
      const repository = await repositoryForRun(runId);
      if (repository === null) return null;
      return repository.get(runId);
    },

    async markRunning(runId: string): Promise<boolean> {
      const repository = await repositoryForRun(runId);
      // A run this store does not have is a no-op, exactly as in memory: the launcher marks a run
      // running without first asking whether it still exists.
      if (repository === null) return false;
      const outcome = await repository.markRunning(runId);
      // `moved` is the only outcome that transitioned the row; `no-op` (not queued any more) and
      // `not-found` both mean this call did not, which is what the port promises to report.
      return outcome.kind === 'moved';
    },

    async finish(
      runId: string,
      status: RunStatus,
      error: string | null,
      emitStatusEvent = false,
    ): Promise<void> {
      // Refused before any lookup, so an invalid status is the same failure whether or not the
      // run exists.
      if (!isTerminalRunStatus(status)) {
        throw new Error(`${status} is not a terminal run status`);
      }
      const repository = await repositoryForRun(runId);
      if (repository === null) return;
      const outcome = await repository.finish(
        runId,
        status,
        error,
        emitStatusEvent ? maxEvents : undefined,
      );
      // The log is closed on `moved` and on `no-op` alike: `no-op` means the run was already
      // terminal, and a log left open on a terminal run is a stream that never ends.
      if (outcome.kind !== 'not-found') wake(runId);
    },

    async snapshotModel(
      runId: string,
      input: { readonly connectionId: string; readonly model: string; readonly provider: string },
    ): Promise<void> {
      const repository = await repositoryForRun(runId);
      if (repository === null) return;
      await repository.snapshotModel(runId, {
        connectionId: input.connectionId,
        model: input.model,
        provider: parseModelProvider(input.provider),
      });
    },

    async append(runId: string, event: AppendEventInput): Promise<AppendResult> {
      const name = classifyEventName(event.type);
      if (name.kind !== 'ok') return { kind: 'rejected', reason: name.reason };
      return append(runId, name.name, event.data);
    },

    async appendPlatformEvent(runId: string, event: PlatformEventInput): Promise<AppendResult> {
      const name = classifyPlatformEventName(event.type);
      if (name.kind !== 'ok') return { kind: 'rejected', reason: name.reason };
      return append(runId, name.name, event.data);
    },

    async openStream(runId: string, after: bigint | null): Promise<RunStreamHandle | null> {
      const repositories = await repositoriesForRun(runId);
      if (repositories === null || (await repositories.runs.get(runId)) === null) return null;

      const bounds = await repositories.events.bounds(runId);
      let cursor = after ?? 0n;
      let reset: StreamResetNotice | null = null;
      if (bounds === null && after !== null && after > 0n) {
        reset = {
          reason: `run ${runId} has no event after ${String(after)} (its latest id is 0); the stream restarts from the oldest retained event`,
          resumedAfter: null,
        };
        cursor = 0n;
      } else if (bounds !== null && cursor < bounds.oldest - 1n) {
        reset = {
          reason:
            after === null
              ? `the beginning of run ${runId}'s event log is no longer retained; the stream starts at the oldest retained event`
              : `events after ${String(cursor)} are no longer retained for run ${runId}; the stream resumes at the oldest retained event and is not contiguous with what you already have`,
          resumedAfter: String(bounds.oldest - 1n),
        };
        cursor = bounds.oldest - 1n;
      } else if (bounds !== null && after !== null && after > bounds.latest) {
        reset = {
          reason: `run ${runId} has no event after ${String(after)} (its latest id is ${String(bounds.latest)}); the stream restarts from the oldest retained event`,
          resumedAfter: String(bounds.oldest - 1n),
        };
        cursor = bounds.oldest - 1n;
      }

      let closed = false;
      let releaseCurrentWait: (() => void) | null = null;
      const close = (): void => {
        if (closed) return;
        closed = true;
        releaseCurrentWait?.();
      };

      const durableEvents = (async function* (): AsyncGenerator<SseEvent> {
        let idleMs = POLL_MIN_MS;
        // Set once the run is seen terminal; the stream then drains what is left and ends.
        let terminal = false;
        try {
          for (;;) {
            let notify!: () => void;
            const notified = new Promise<void>((resolve) => {
              notify = resolve;
            });
            const listeners = waiters.get(runId) ?? new Set<() => void>();
            listeners.add(notify);
            waiters.set(runId, listeners);
            releaseCurrentWait = notify;

            try {
              const page = await repositories.events.list(runId, cursor, EVENT_PAGE_SIZE);
              for (const event of page) {
                cursor = event.id;
                yield event;
              }
              if (closed) return;
              // A full page means more are waiting: read on before asking about the run.
              if (page.length === EVENT_PAGE_SIZE) continue;
              if (terminal) return;
              const run = await repositories.runs.get(runId);
              if (run === null) return;
              if (isTerminalRunStatus(run.status)) {
                // A final event may commit between the list above and this status read. Event
                // append and finish share the run lock, so no append can commit after the terminal
                // status becomes visible. One last drain is therefore complete.
                terminal = true;
                continue;
              }
              // Waking is in-process only, so polling is the cross-replica signal; it backs off
              // while the run is quiet so idle viewers do not each query four times a second.
              idleMs = page.length > 0 ? POLL_MIN_MS : Math.min(idleMs * 2, POLL_MAX_MS);
              await Promise.race([
                notified,
                new Promise<void>((resolve) => setTimeout(resolve, idleMs)),
              ]);
            } finally {
              listeners.delete(notify);
              if (listeners.size === 0) waiters.delete(runId);
              releaseCurrentWait = null;
            }
          }
        } finally {
          close();
        }
      })();

      return { reset, events: durableEvents, close };
    },

    async listRuns(workspaceId: string, input: ListRunsInput): Promise<RunListPage> {
      const repository = dependencies.repositories.forScope(await scopeFor(workspaceId));
      // `RunRepository.listRuns` is optional only so an out-of-globs hand-built fixture
      // (`packages/gateway/src/index.test.ts`) keeps compiling — see that method's own comment.
      // Every repository this composition root actually installs has it; an absent one here is a
      // broken wiring, not a request this store can answer.
      if (repository.listRuns === undefined) {
        throw new Error('the installed RunRepository does not implement listRuns');
      }
      return repository.listRuns(input);
    },
  };
}
