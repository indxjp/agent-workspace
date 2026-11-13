/**
 * The stale-run sweep. A launch lives in the process that started it — its lifetime timer, its
 * `finish` and its token revocation are all in memory — so a replica that restarts, scales in or
 * runs out of memory mid-run leaves the run `running` (or `queued`) forever: its run token stays
 * live until TTL and every event stream on it polls without end.
 *
 * Every launch ends itself within the maximum run duration and the storage write-back allowance
 * after it (`staleRunAfterMs` in `./launcher.ts`, which also cuts the write-back short of this
 * threshold), so a run still open well past both has no process driving it. The sweep fails each
 * one through {@link RunStore.finish}, the same first-call-wins path an interrupt takes, which
 * revokes the run's tokens and closes its streams. One replica sweeps at a time, under the
 * maintenance lease session retention uses.
 *
 * The same pass ends a run paused at `awaiting_approval` once its approval deadline has passed
 * (ADR-0145 D2.4): `cancelled` with the reason `approval_expired`, so an approval-gated trigger's
 * unfinished-run count (`countUnfinishedRuns`) frees up again.
 */
import { systemClock, type Clock } from '../clock';
import type { RunStore } from './store';

const STALE_RUN_ERROR =
  'The run was ended because no server process was driving it any more: it outlived its maximum duration.';

/** The reason of a paused run nobody decided in time (ADR-0145 D2.4), as a late decision stores it. */
const APPROVAL_EXPIRED_ERROR =
  'approval_expired: no decision was made within 24 hours, so the request was rejected';

const LEASE_NAME = 'stale-run-sweep';
/** Held for one sweep: the sweeper runs every minute (`composition/wiring/run-runtime.ts`). */
const LEASE_TTL_MS = 60_000;

/** How far past a launch's longest life (its run and its write-back) a run counts as stale. */
export const STALE_RUN_SWEEP_MARGIN_MS = 5 * 60_000;

export interface StaleRunSweepDependencies {
  readonly lease: {
    tryAcquire(name: string, ttlMs: number): Promise<null | { release(): Promise<void> }>;
  };
  /** Ids of runs `running` since before `before`, or `queued` since before it. */
  readonly listStaleRunIds: (before: Date) => Promise<readonly string[]>;
  /** Ids of runs paused at `awaiting_approval` whose 24 h approval deadline is before `before`. */
  readonly listExpiredApprovalRunIds: (before: Date) => Promise<readonly string[]>;
  readonly finish: RunStore['finish'];
  /** How long a run may stay open before it counts as stale: `staleRunAfterMs` in `./launcher.ts`. */
  readonly staleAfterMs: number;
  /** Defaults to {@link systemClock}. */
  readonly clock?: Clock;
}

/** One sweep: the number of runs failed, or `null` when another replica holds the lease. */
async function sweepStaleRuns(deps: StaleRunSweepDependencies): Promise<number | null> {
  const held = await deps.lease.tryAcquire(LEASE_NAME, LEASE_TTL_MS);
  if (held === null) return null;
  try {
    const now = (deps.clock ?? systemClock).now();
    const stale = await deps.listStaleRunIds(new Date(now.getTime() - deps.staleAfterMs));
    for (const runId of stale) await deps.finish(runId, 'failed', STALE_RUN_ERROR, true);
    // ADR-0145 D2.4: an undecided request is rejected at its deadline, and the run ends cancelled.
    const expired = await deps.listExpiredApprovalRunIds(now);
    for (const runId of expired)
      await deps.finish(runId, 'cancelled', APPROVAL_EXPIRED_ERROR, true);
    return stale.length + expired.length;
  } finally {
    await held.release();
  }
}

/**
 * Sweep every `intervalMs` on an unref'd timer; the returned function stops it.
 *
 * ponytail: an in-process timer. On the Vercel target a function instance runs it only while it
 * lives; move the sweep onto the retention cron route if orphans there outlive a warm instance.
 */
export function startStaleRunSweeper(
  deps: StaleRunSweepDependencies & {
    readonly intervalMs: number;
    readonly onError: (error: unknown) => void;
  },
): () => void {
  const timer = setInterval(() => void sweepStaleRuns(deps).catch(deps.onError), deps.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
