/**
 * The agent auto-archive sweep (issue #1851, slice 4). An agent made by an agent and unused for
 * {@link AGENT_AUTO_ARCHIVE_DAYS} days is archived: `archived_at` is set and one `agent-changed`
 * audit row names it. A person-made agent is never touched.
 *
 * "Agent-made" is the lineage: a version and a run recorded when an agent saved the row. A deleted
 * creator clears `agentId` only, so that agent is still agent-made. The repository query narrows
 * the candidates; {@link autoArchivable} decides, so the rule is stated once and does not rest on
 * the query's prefilter.
 *
 * **A restore gives a fresh window.** The query leaves out an agent whose audit trail has a restore
 * (`agent-changed` with `archived: false`) inside the same {@link AGENT_AUTO_ARCHIVE_DAYS} days, so
 * an agent restored after 30 idle days is not archived again within the hour.
 *
 * **Once an hour.** The trigger cron delivers every minute and the timer polls, so a sweep is
 * skipped when this process swept less than {@link AGENT_ARCHIVE_MIN_INTERVAL_MS} ago. The marker
 * is in memory: a stored one needs a table, and the sweep is idempotent, so N warm instances cost
 * at most N sweeps an hour. A lease held open for the hour would pin a pooled connection until its
 * in-process timer fires, which a frozen serverless instance never runs.
 *
 * **Overlap is harmless.** The lease only keeps replicas from sweeping together, and its TTL frees
 * it for a sweep that outlives it. Two overlapping sweeps archive nothing twice: the update is
 * guarded by `archived_at is null` and the audit row is written for the rows it returned.
 *
 * This file knows no persistence: the composition root binds {@link AgentArchiveStore}.
 */
import type { AgentCreatedByAgent } from '@indx-workspace/contracts/agents';
import type { Logger } from '@agent-workspace/core/telemetry';

/** An agent-made agent with no run and no creation inside this many days is archived. */
export const AGENT_AUTO_ARCHIVE_DAYS = 30;

/** Candidates read and archived per query, so one workspace never loads all its agents at once. */
export const AGENT_ARCHIVE_PAGE_SIZE = 100;

/** The sweep runs at most this often in one process. */
export const AGENT_ARCHIVE_MIN_INTERVAL_MS = 60 * 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const LEASE_NAME = 'agent-auto-archive';
const LEASE_TTL_MS = 10 * 60_000;

export interface ArchiveCandidate {
  readonly id: string;
  readonly createdAt: Date;
  /** The newest run of any session of the agent, or `null` when it never ran. */
  readonly lastRunAt: Date | null;
  /** The agent's lineage; `null` for a person-made agent. */
  readonly createdByAgent: AgentCreatedByAgent | null;
}

/** One workspace's agents, as the sweep needs them. */
export interface AgentArchiveStore {
  /**
   * Not-yet-archived agents created before `createdBefore` and not restored since
   * `notRestoredSince`, by id after `afterId`.
   */
  listArchiveCandidates(input: {
    readonly createdBefore: Date;
    readonly notRestoredSince: Date;
    readonly afterId: string | null;
    readonly limit: number;
  }): Promise<readonly ArchiveCandidate[]>;
  /** Archives these agents at `at` and returns the ids it archived (not already archived). */
  archive(ids: readonly string[], at: Date): Promise<readonly string[]>;
}

export interface AgentArchiveSweepDependencies {
  listWorkspaceIds(): Promise<readonly string[]>;
  tryAcquireMaintenanceLease(
    name: string,
    ttlMs: number,
  ): Promise<null | { release(): Promise<void> }>;
  /** `null` when the workspace no longer resolves. */
  storeFor(workspaceId: string): Promise<AgentArchiveStore | null>;
  now(): Date;
  log: Pick<Logger, 'error'>;
}

export interface AgentArchiveSweepResult {
  readonly leaseHeld: boolean;
  /** The sweep ran less than {@link AGENT_ARCHIVE_MIN_INTERVAL_MS} ago in this process. */
  readonly throttled: boolean;
  readonly workspaces: number;
  readonly archived: number;
  /** Workspaces whose sweep threw; the next sweep tries again. */
  readonly failed: number;
}

/** Agent-made, not run and not created within the window. Archived agents are not candidates. */
export function autoArchivable(candidate: ArchiveCandidate, now: Date): boolean {
  if (candidate.createdByAgent === null) return false;
  const cutoff = now.getTime() - AGENT_AUTO_ARCHIVE_DAYS * DAY_MS;
  return (
    candidate.createdAt.getTime() < cutoff &&
    (candidate.lastRunAt === null || candidate.lastRunAt.getTime() < cutoff)
  );
}

async function sweepWorkspace(store: AgentArchiveStore, now: Date): Promise<number> {
  const createdBefore = new Date(now.getTime() - AGENT_AUTO_ARCHIVE_DAYS * DAY_MS);
  let archived = 0;
  let afterId: string | null = null;
  for (;;) {
    const page = await store.listArchiveCandidates({
      createdBefore,
      notRestoredSince: createdBefore,
      afterId,
      limit: AGENT_ARCHIVE_PAGE_SIZE,
    });
    const due = page.filter((candidate) => autoArchivable(candidate, now));
    if (due.length > 0) {
      archived += (
        await store.archive(
          due.map((candidate) => candidate.id),
          now,
        )
      ).length;
    }
    const last = page[page.length - 1];
    if (last === undefined || page.length < AGENT_ARCHIVE_PAGE_SIZE) return archived;
    afterId = last.id;
  }
}

/**
 * One process's sweep over every workspace. Call it as often as you like: it sweeps at most once
 * per {@link AGENT_ARCHIVE_MIN_INTERVAL_MS}, and every caller in the process shares that marker.
 * A call that finds the lease held by another replica sweeps nothing and is tried again next time.
 */
export function createAgentArchiveSweep(
  deps: AgentArchiveSweepDependencies,
): () => Promise<AgentArchiveSweepResult> {
  let lastSweptAt: Date | null = null;
  return async () => {
    const now = deps.now();
    if (
      lastSweptAt !== null &&
      now.getTime() - lastSweptAt.getTime() < AGENT_ARCHIVE_MIN_INTERVAL_MS
    ) {
      return { leaseHeld: false, throttled: true, workspaces: 0, archived: 0, failed: 0 };
    }
    const held = await deps.tryAcquireMaintenanceLease(LEASE_NAME, LEASE_TTL_MS);
    if (held === null) {
      return { leaseHeld: true, throttled: false, workspaces: 0, archived: 0, failed: 0 };
    }
    lastSweptAt = now;
    try {
      const workspaceIds = await deps.listWorkspaceIds();
      let archived = 0;
      let failed = 0;
      for (const workspaceId of workspaceIds) {
        try {
          const store = await deps.storeFor(workspaceId);
          if (store !== null) archived += await sweepWorkspace(store, now);
        } catch (error) {
          failed += 1;
          deps.log.error(`[agent-archive] workspace ${workspaceId} failed`, { error });
        }
      }
      return {
        leaseHeld: false,
        throttled: false,
        workspaces: workspaceIds.length,
        archived,
        failed,
      };
    } finally {
      await held.release();
    }
  };
}

/**
 * Call `sweep` every `intervalMs` on an unref'd timer; the returned function stops it. The timer
 * is for long-lived servers; where `CRON_SECRET` is set the trigger cron route calls the same
 * `sweep` on each delivery instead (see `triggers/schedule-cron.ts`). `intervalMs` should be well
 * under {@link AGENT_ARCHIVE_MIN_INTERVAL_MS}: a tick an hour apart lands a few milliseconds short
 * of the throttle and would wait for the next one.
 */
export function startAgentArchiveScheduler(options: {
  readonly sweep: () => Promise<AgentArchiveSweepResult>;
  readonly intervalMs: number;
  readonly onError: (error: unknown) => void;
}): () => void {
  const timer = setInterval(() => void options.sweep().catch(options.onError), options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
