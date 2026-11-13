import type {
  RunEventRepository as CoreRunEventRepository,
  RunEventRepositoryProvider as CoreRunEventRepositoryProvider,
  RunRepository as CoreRunRepository,
  RunRepositoryProvider as CoreRunRepositoryProvider,
  WorkspaceScope as CoreWorkspaceScope,
  WorkspaceScopeResolver as CoreWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { MODEL_PROVIDERS, type ModelProvider } from '@indx-workspace/contracts/runs';
import { openRepositoryStream } from './repository-stream';

import { RunId, WorkspaceId } from '../newtypes';
import { storableJson } from './storable-text';
import { classifyEventName, classifyPlatformEventName, renderEventData } from './sse';
import { RecentRunWorkspaces } from './recent-run-workspaces';
import {
  ApprovalDecisionError,
  ChildRunLimitError,
  eventRetentionLimit,
  IdempotencyKeyTakenError,
  isStoppedRunStatus,
  isTerminalRunStatus,
  ParentRunStoppedError,
  SessionBusyError,
  type AppendEventInput,
  type AppendResult,
  type ApprovalCall,
  type CreateRunInput,
  type ListRunsInput,
  type PlatformEventInput,
  type RunListPage,
  type RunRecord,
  type RunStore,
  type RunStreamHandle,
} from './store';

/** A provider read back from the database, narrowed by a positive assertion (ADR-0015). */
function parseModelProvider(value: string): ModelProvider {
  if (!(MODEL_PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(`${JSON.stringify(value)} is not a recognised model provider`);
  }
  return value as ModelProvider;
}

/** The repositories of one workspace scope that serve one run. */
interface RunRepositories {
  readonly runs: CoreRunRepository;
  readonly events: CoreRunEventRepository;
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
  return new RepositoryRunStore(dependencies);
}

class RepositoryRunStore implements RunStore {
  private readonly maxEvents: number;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly recentRuns = new RecentRunWorkspaces();

  constructor(private readonly dependencies: RepositoryRunStoreDependencies) {
    this.maxEvents = eventRetentionLimit(dependencies.maxEventsPerRun);
  }

  private async lookUpWorkspaceOfRun(runId: string): Promise<WorkspaceId | null> {
    const found = await this.dependencies.findRunWorkspace(runId);
    return found === null ? null : WorkspaceId.fromStore(found);
  }

  private async scopeFor(workspaceId: string): Promise<CoreWorkspaceScope> {
    const scope = await this.dependencies.scopes.forWorkspaceId(workspaceId);
    if (scope === null) {
      throw new Error(
        `no workspace has id ${workspaceId}; a run store cannot be scoped to a workspace that does not exist`,
      );
    }
    return scope;
  }

  /** The run repository of `workspaceId`'s scope. */
  private async runRepositoryOfWorkspace(workspaceId: string): Promise<CoreRunRepository> {
    return this.dependencies.repositories.forScope(await this.scopeFor(workspaceId));
  }

  private async repositoriesServingRun(runId: string): Promise<RunRepositories | null> {
    const workspaceId = this.recentRuns.get(runId) ?? (await this.lookUpWorkspaceOfRun(runId));
    // The explicit else: no workspace means no run, and every caller turns that into the same
    // answer the in-memory store gives for an id it has never seen.
    if (workspaceId === null) return null;
    // The database has a run with this id, so it is a stored id.
    this.recentRuns.remember(RunId.fromStore(runId), workspaceId);
    const scope = await this.scopeFor(workspaceId);
    return {
      runs: this.dependencies.repositories.forScope(scope),
      events: this.dependencies.events.forScope(scope),
    };
  }

  private async runRepositoryOf(runId: string): Promise<CoreRunRepository | null> {
    return (await this.repositoriesServingRun(runId))?.runs ?? null;
  }

  private notifyWaiters(runId: string): void {
    for (const notify of [...(this.waiters.get(runId) ?? [])]) notify();
  }

  private async appendEvent(runId: string, type: string, data: unknown): Promise<AppendResult> {
    const payload = renderEventData(data);
    if (payload.kind !== 'ok') return { kind: 'rejected', reason: payload.reason };
    const repositories = await this.repositoriesServingRun(runId);
    if (repositories === null) return { kind: 'rejected', reason: `no run ${runId}` };
    const stored = await repositories.runs.get(runId);
    if (stored === null) return { kind: 'rejected', reason: `no run ${runId}` };
    if (isStoppedRunStatus(stored.status)) {
      return { kind: 'rejected', reason: `run ${runId} is finished; its event log is closed` };
    }
    const event = await repositories.events.append(
      runId,
      type,
      // The runtime's output is arbitrary text (a binary file read as UTF-8 holds NULs, a cut
      // emoji a lone surrogate); jsonb refuses both, which would otherwise fail the whole run.
      storableJson(data),
      this.maxEvents,
    );
    if (event === null) return { kind: 'rejected', reason: `no run ${runId}` };
    this.notifyWaiters(runId);
    return { kind: 'appended', event };
  }

  async create(input: CreateRunInput): Promise<RunRecord> {
    const repository = await this.runRepositoryOfWorkspace(input.workspaceId);
    const outcome = await repository.create(runRowInput(input, this.maxEvents));
    if (outcome.kind === 'approval-expired') this.notifyWaiters(outcome.runId);
    const run = requireCreatedRun(input, outcome);
    this.recentRuns.remember(RunId.fromStore(run.id), WorkspaceId.fromStore(input.workspaceId));
    // A decision completed the paused run in the same commit; its open streams may end now.
    if (input.decides !== undefined) this.notifyWaiters(input.decides);
    // `agentId` comes back from the session the run belongs to, never from the caller: the
    // `runs` table stores no `agent_id`, precisely so it cannot disagree with the session's.
    return run;
  }

  async get(runId: string): Promise<RunRecord | null> {
    const repository = await this.runRepositoryOf(runId);
    if (repository === null) return null;
    return repository.get(runId);
  }

  async findByIdempotencyKey(workspaceId: string, principalId: string, key: string) {
    const repository = await this.runRepositoryOfWorkspace(workspaceId);
    const found = await repository.findByIdempotencyKey(principalId, key);
    if (found === null) return null;
    this.recentRuns.remember(RunId.fromStore(found.run.id), WorkspaceId.fromStore(workspaceId));
    return { run: found.run, requestHash: found.requestHash };
  }

  async markRunning(runId: string): Promise<boolean> {
    const repository = await this.runRepositoryOf(runId);
    // A run this store does not have is a no-op, exactly as in memory: the launcher marks a run
    // running without first asking whether it still exists.
    if (repository === null) return false;
    const outcome = await repository.markRunning(runId);
    // `moved` is the only outcome that transitioned the row; `no-op` (not queued any more) and
    // `not-found` both mean this call did not, which is what the port promises to report.
    return outcome.kind === 'moved';
  }

  async finish(...args: Parameters<RunStore['finish']>): Promise<void> {
    const [runId, status, error, emitStatusEvent = false, output = null] = args;

    // Refused before any lookup, so an invalid status is the same failure whether or not the
    // run exists.
    if (!isTerminalRunStatus(status)) {
      throw new Error(`${status} is not a terminal run status`);
    }
    const repository = await this.runRepositoryOf(runId);
    if (repository === null) return;
    const outcome = await repository.finish(
      runId,
      status,
      error,
      emitStatusEvent ? this.maxEvents : undefined,
      output,
    );
    // The log is closed on `moved` and on `no-op` alike: `no-op` means the run was already
    // terminal, and a log left open on a terminal run is a stream that never ends.
    if (outcome.kind !== 'not-found') this.notifyWaiters(runId);
  }

  async awaitApproval(runId: string, call: ApprovalCall): Promise<void> {
    const repository = await this.runRepositoryOf(runId);
    if (repository === null) return;
    const outcome = await repository.awaitApproval(runId, call, this.maxEvents);
    if (outcome.kind !== 'not-found') this.notifyWaiters(runId);
  }

  async snapshotModel(
    runId: string,
    input: { readonly connectionId: string; readonly model: string; readonly provider: string },
  ): Promise<void> {
    const repository = await this.runRepositoryOf(runId);
    if (repository === null) return;
    await repository.snapshotModel(runId, {
      connectionId: input.connectionId,
      model: input.model,
      provider: parseModelProvider(input.provider),
    });
  }

  async append(runId: string, event: AppendEventInput): Promise<AppendResult> {
    const name = classifyEventName(event.type);
    if (name.kind !== 'ok') return { kind: 'rejected', reason: name.reason };
    return this.appendEvent(runId, name.name, event.data);
  }

  async appendPlatformEvent(runId: string, event: PlatformEventInput): Promise<AppendResult> {
    const name = classifyPlatformEventName(event.type);
    if (name.kind !== 'ok') return { kind: 'rejected', reason: name.reason };
    return this.appendEvent(runId, name.name, event.data);
  }

  async openStream(runId: string, after: bigint | null): Promise<RunStreamHandle | null> {
    const repositories = await this.repositoriesServingRun(runId);
    if (repositories === null || (await repositories.runs.get(runId)) === null) return null;
    return openRepositoryStream({ runId, after, repositories, waiters: this.waiters });
  }

  async listRuns(workspaceId: string, input: ListRunsInput): Promise<RunListPage> {
    const repository = await this.runRepositoryOfWorkspace(workspaceId);
    const page = await repository.listRuns(input);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  async listChildren(
    workspaceId: string,
    parentRunId: string,
    limit: number,
  ): Promise<readonly RunRecord[]> {
    const repository = await this.runRepositoryOfWorkspace(workspaceId);
    return repository.listChildren(parentRunId, limit);
  }
}

type CoreCreateOutcome = Awaited<ReturnType<CoreRunRepository['create']>>;
type CoreCreateInput = Parameters<CoreRunRepository['create']>[0];

/** The row a run store `create` asks the repository to insert; optional fields stay absent. */
function runRowInput(input: CreateRunInput, maxEvents: number): CoreCreateInput {
  return {
    id: input.id,
    sessionId: input.sessionId,
    engine: input.engine,
    prompt: input.prompt ?? null,
    outputSchema: input.outputSchema ?? null,
    subject: input.subject ?? null,
    limitsOverride: input.limitsOverride ?? null,
    spendCeilingUsd: input.spendCeilingUsd ?? null,
    ...(input.idempotency === undefined ? {} : { idempotency: input.idempotency }),
    ...(input.approvedToolCalls === undefined
      ? {}
      : { approvedToolCalls: input.approvedToolCalls }),
    ...(input.decides === undefined
      ? {}
      : { decides: { runId: input.decides, statusEventMaxEvents: maxEvents } }),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    ...(input.agentTeamVersionId === undefined
      ? {}
      : { agentTeamVersionId: input.agentTeamVersionId }),
  };
}

/** The run a successful create inserted, or the named failure its outcome stands for. */
function requireCreatedRun(input: CreateRunInput, outcome: CoreCreateOutcome): RunRecord {
  if (outcome.kind === 'duplicate-id') {
    // The same message the in-memory store rejects with, because `api.ts` and the conformance
    // suite both read it and two spellings of one failure is two failures to handle.
    throw new Error(`run ${input.id} already exists`);
  }
  if (outcome.kind === 'session-busy') throw new SessionBusyError(input.sessionId);
  if (outcome.kind === 'child-limit') throw new ChildRunLimitError(outcome.runId);
  if (outcome.kind === 'parent-stopped') throw new ParentRunStoppedError(outcome.runId);
  if (outcome.kind === 'idempotency-key-taken') throw new IdempotencyKeyTakenError(outcome.key);
  if (outcome.kind === 'already-decided') {
    throw new ApprovalDecisionError(outcome.runId, 'already-decided');
  }
  if (outcome.kind === 'approval-expired') {
    // The paused run was cancelled in that call, so its stream has ended.
    throw new ApprovalDecisionError(outcome.runId, 'expired');
  }
  if (outcome.kind === 'unknown-session') {
    throw new Error(
      `no session ${input.sessionId} in workspace ${input.workspaceId}; a run row references its session (runs_session_workspace_fk)`,
    );
  }

  return outcome.run;
}
