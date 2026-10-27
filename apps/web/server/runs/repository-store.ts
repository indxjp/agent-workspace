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
  type SseEvent,
} from './sse';
import {
  ApprovalDecisionError,
  eventRetentionLimit,
  IdempotencyKeyTakenError,
  isStoppedRunStatus,
  isTerminalRunStatus,
  SessionBusyError,
  type ApprovalCall,
  type AppendEventInput,
  type AppendResult,
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

/** A provider read back from the database, narrowed by a positive assertion (ADR-0015). */
function parseModelProvider(value: string): ModelProvider {
  if (!(MODEL_PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(`${JSON.stringify(value)} is not a recognised model provider`);
  }
  return value as ModelProvider;
}

/** How many events one stream reads per query, so a replay of a long run is never one huge read. */
const EVENT_PAGE_SIZE = 500;
/** A stream's poll interval: the first wait, and the longest one a quiet run backs off to. */
const POLL_MIN_MS = 250;
const POLL_MAX_MS = 2_000;
/** How many run-to-workspace lookups one repository store remembers. */
const REMEMBERED_RUN_WORKSPACES = 10_000;

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
  /** Per-run event retention, as `InMemoryRunStoreOptions.maxEventsPerRun`. */
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
  const maxEvents = eventRetentionLimit(dependencies.maxEventsPerRun);
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
    const stored = await repositories.runs.get(runId);
    if (stored === null) return { kind: 'rejected', reason: `no run ${runId}` };
    if (isStoppedRunStatus(stored.status)) {
      return { kind: 'rejected', reason: `run ${runId} is finished; its event log is closed` };
    }
    const event = await repositories.events.append(runId, type, data, maxEvents);
    if (event === null) return { kind: 'rejected', reason: `no run ${runId}` };
    wake(runId);
    return { kind: 'appended', event };
  };

  return {
    async create(input: CreateRunInput): Promise<RunRecord> {
      const repository = dependencies.repositories.forScope(await scopeFor(input.workspaceId));
      const outcome = await repository.create({
        id: input.id,
        sessionId: input.sessionId,
        engine: input.engine,
        prompt: input.prompt ?? null,
        outputSchema: input.outputSchema ?? null,
        subject: input.subject ?? null,
        ...(input.idempotency === undefined ? {} : { idempotency: input.idempotency }),
        ...(input.approvedToolCalls === undefined
          ? {}
          : { approvedToolCalls: input.approvedToolCalls }),
        ...(input.decides === undefined
          ? {}
          : { decides: { runId: input.decides, statusEventMaxEvents: maxEvents } }),
      });
      if (outcome.kind === 'duplicate-id') {
        // The same message the in-memory store rejects with, because `api.ts` and the conformance
        // suite both read it and two spellings of one failure is two failures to handle.
        throw new Error(`run ${input.id} already exists`);
      }
      if (outcome.kind === 'session-busy') throw new SessionBusyError(input.sessionId);
      if (outcome.kind === 'idempotency-key-taken') throw new IdempotencyKeyTakenError(outcome.key);
      if (outcome.kind === 'already-decided') {
        throw new ApprovalDecisionError(outcome.runId, 'already-decided');
      }
      if (outcome.kind === 'approval-expired') {
        // The paused run was cancelled in that call, so its stream has ended.
        wake(outcome.runId);
        throw new ApprovalDecisionError(outcome.runId, 'expired');
      }
      if (outcome.kind === 'unknown-session') {
        throw new Error(
          `no session ${input.sessionId} in workspace ${input.workspaceId}; a run row references its session (runs_session_workspace_fk)`,
        );
      }
      remember(input.id, input.workspaceId);
      // A decision completed the paused run in the same commit; its open streams may end now.
      if (input.decides !== undefined) wake(input.decides);
      // `agentId` comes back from the session the run belongs to, never from the caller: the
      // `runs` table stores no `agent_id`, precisely so it cannot disagree with the session's.
      return outcome.run;
    },

    async get(runId: string): Promise<RunRecord | null> {
      const repository = await repositoryForRun(runId);
      if (repository === null) return null;
      const run = await repository.get(runId);
      return run;
    },

    async findByIdempotencyKey(workspaceId: string, principalId: string, key: string) {
      const repository = dependencies.repositories.forScope(await scopeFor(workspaceId));
      const found = await repository.findByIdempotencyKey(principalId, key);
      if (found === null) return null;
      remember(found.run.id, workspaceId);
      return { run: found.run, requestHash: found.requestHash };
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
      output: RunOutput | null = null,
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
        output,
      );
      // The log is closed on `moved` and on `no-op` alike: `no-op` means the run was already
      // terminal, and a log left open on a terminal run is a stream that never ends.
      if (outcome.kind !== 'not-found') wake(runId);
    },

    async awaitApproval(runId: string, call: ApprovalCall): Promise<void> {
      const repository = await repositoryForRun(runId);
      if (repository === null) return;
      const outcome = await repository.awaitApproval(runId, call, maxEvents);
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
              if (isStoppedRunStatus(run.status)) {
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
      const page = await repository.listRuns(input);
      return { items: page.items, nextCursor: page.nextCursor };
    },
  };
}
