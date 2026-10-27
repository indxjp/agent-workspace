/**
 * The in-process {@link RunStore}: records in a `Map`, events in a {@link RunEventLog}.
 * The port, the record types and the shared constants live in `./store`; the PostgreSQL adapter
 * is `./repository-store`. `store.test.ts` runs one conformance suite against both.
 */
import {
  classifyEventName,
  classifyPlatformEventName,
  renderEventData,
  RUN_STATUS_EVENT,
  type SseEvent,
} from './sse';
import {
  ApprovalDecisionError,
  eventRetentionLimit,
  isTerminalRunStatus,
  MAX_RUN_LIST_LIMIT,
  type ApprovalCall,
  type AppendEventInput,
  type AppendResult,
  IdempotencyKeyTakenError,
  type CreateRunInput,
  type ListRunsInput,
  type PlatformEventInput,
  type RunListPage,
  type RunOutput,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type RunStreamHandle,
  type StreamResetNotice,
} from './store';

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

  /** Reopen a log closed by a pause, so the paused run's own cancellation can still be recorded. */
  public reopen(runId: string): void {
    const state = this.#logs.get(runId);
    if (state !== undefined) state.closed = false;
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
const memoryKeySlot = (workspaceId: string, principalId: string, key: string): string =>
  JSON.stringify([workspaceId, principalId, key]);

export class InMemoryRunStore implements RunStore {
  readonly #records = new Map<string, RunRecord>();
  /** `workspace principal key` → the run id and request hash it was first used with. */
  readonly #keys = new Map<string, { readonly runId: string; readonly requestHash: string }>();
  readonly #events: RunEventLog;
  readonly #now: () => Date;

  constructor(options: InMemoryRunStoreOptions = {}) {
    this.#now = options.now ?? ((): Date => new Date());
    this.#events = new RunEventLog(eventRetentionLimit(options.maxEventsPerRun), this.#now);
  }

  create(input: CreateRunInput): Promise<RunRecord> {
    if (this.#records.has(input.id)) {
      return Promise.reject(new Error(`run ${input.id} already exists`));
    }
    const { idempotency } = input;
    const keySlot =
      idempotency === undefined
        ? null
        : memoryKeySlot(input.workspaceId, idempotency.principalId, idempotency.key);
    // The repository store's order (#1440): the decision is judged first, then the key, and only
    // then is the paused run completed, so a taken key leaves it awaiting approval.
    const paused = input.decides === undefined ? undefined : this.#records.get(input.decides);
    if (
      input.decides !== undefined &&
      (paused?.status !== 'awaiting_approval' ||
        paused.sessionId !== input.sessionId ||
        paused.workspaceId !== input.workspaceId)
    ) {
      // No 24-hour window is modelled here: the repository store decides expiry under its lock.
      return Promise.reject(new ApprovalDecisionError(input.decides, 'already-decided'));
    }
    if (idempotency !== undefined && keySlot !== null && this.#keys.has(keySlot)) {
      return Promise.reject(new IdempotencyKeyTakenError(idempotency.key));
    }
    if (paused !== undefined) {
      // The repository store writes the same `completed` status event into the paused run's log.
      this.#events.reopen(paused.id);
      const appended = this.#events.write(paused.id, RUN_STATUS_EVENT, {
        status: 'completed',
        error: null,
      });
      this.#events.close(paused.id);
      if (appended.kind !== 'appended') return Promise.reject(new Error(appended.reason));
      this.#records.set(paused.id, { ...paused, status: 'completed', pendingApproval: null });
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
      output: null,
      outputSchema: input.outputSchema ?? null,
      subject: input.subject ?? null,
      pendingApproval: null,
      approvedToolCalls: input.approvedToolCalls ?? [],
      approvalsConsumedAt: null,
      projectId: input.projectId ?? null,
      agentVersion: input.agentVersion ?? null,
      // `exactOptionalPropertyTypes` refuses an explicit `undefined` for an optional `string`
      // field, so an omitted `initiatingUserId` must omit the key entirely rather than assign it.
      ...(input.initiatingUserId === undefined ? {} : { initiatingUserId: input.initiatingUserId }),
      ...(input.ownerPrincipalId === undefined ? {} : { ownerPrincipalId: input.ownerPrincipalId }),
    };
    this.#records.set(input.id, record);
    if (idempotency !== undefined && keySlot !== null) {
      this.#keys.set(keySlot, { runId: input.id, requestHash: idempotency.requestHash });
    }
    this.#events.open(input.id);
    return Promise.resolve(record);
  }

  get(runId: string): Promise<RunRecord | null> {
    return Promise.resolve(this.#records.get(runId) ?? null);
  }

  findByIdempotencyKey(
    workspaceId: string,
    principalId: string,
    key: string,
  ): Promise<{ readonly run: RunRecord; readonly requestHash: string } | null> {
    const held = this.#keys.get(memoryKeySlot(workspaceId, principalId, key));
    const run = held === undefined ? undefined : this.#records.get(held.runId);
    return Promise.resolve(
      held === undefined || run === undefined ? null : { run, requestHash: held.requestHash },
    );
  }

  markRunning(runId: string): Promise<boolean> {
    const record = this.#records.get(runId);
    if (record === undefined) return Promise.resolve(false);
    if (record.status !== 'queued') return Promise.resolve(false);
    const startedAt = this.#now();
    // ADR-0151: approved calls are consumed in the same step that leaves `queued`, as the
    // repository store does.
    const consumed = (record.approvedToolCalls ?? []).length > 0;
    this.#records.set(runId, {
      ...record,
      status: 'running',
      startedAt,
      approvalsConsumedAt: consumed ? startedAt : null,
    });
    return Promise.resolve(true);
  }

  finish(
    runId: string,
    status: RunStatus,
    error: string | null,
    emitStatusEvent = false,
    output: RunOutput | null = null,
  ): Promise<void> {
    if (!isTerminalRunStatus(status)) {
      return Promise.reject(new Error(`${status} is not a terminal run status`));
    }
    if (output !== null && status !== 'completed') {
      return Promise.reject(new Error(`a run that ended ${status} cannot carry an output`));
    }
    const record = this.#records.get(runId);
    if (record === undefined) return Promise.resolve();
    if (isTerminalRunStatus(record.status)) return Promise.resolve();
    if (record.status === 'awaiting_approval') this.#events.reopen(runId);
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
      output,
    });
    this.#events.close(runId);
    return Promise.resolve();
  }

  awaitApproval(runId: string, call: ApprovalCall): Promise<void> {
    const record = this.#records.get(runId);
    if (record?.status !== 'running') return Promise.resolve();
    const appended = this.#events.write(runId, RUN_STATUS_EVENT, {
      status: 'awaiting_approval',
      error: null,
    });
    if (appended.kind !== 'appended') return Promise.reject(new Error(appended.reason));
    this.#records.set(runId, {
      ...record,
      status: 'awaiting_approval',
      endedAt: this.#now(),
      pendingApproval: call,
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
