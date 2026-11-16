import { watchRunForCancellation } from './cancellation-watch';
import type { RunStore } from './store';

/**
 * The error a launch concludes with when its cancellation watch saw the run stopped by someone
 * else (an interrupt on any replica, the stale sweep, an approval expiry). `finish` is
 * first-call-wins, so the stored status and error stay that writer's; this names the telemetry's.
 */
export const STOPPED_WHILE_LIVE = 'the run was stopped while it was live';

export interface HeldRunWatch {
  /** Aborts once the watch has seen the run stopped by someone else, and stopped its runtime. */
  readonly signal: AbortSignal;
  /** Stop watching; called before the launch writes its own stop. Idempotent. */
  readonly stop: () => void;
}

/**
 * Watch a run this launch holds, from `markRunning` to its conclusion (ADR-0151-FU-1440 D1, issue
 * #261). A stop committed by another writer aborts the storage write-back (`interrupted`) and the
 * run's fetch and relay (the returned signal), and raises the runtime's private interrupt. When an
 * interrupt served by this process already did that through the live-run registry, `interrupted`
 * is aborted and the watch does nothing more: `interrupted` is the once-per-launch flag.
 */
export function watchHeldRun(
  store: RunStore,
  runId: string,
  intervalMs: number,
  interrupted: AbortController,
  signalRuntime: () => Promise<void>,
): HeldRunWatch {
  const stoppedElsewhere = new AbortController();
  const stop = watchRunForCancellation({
    runId,
    readStatus: async (id) => (await store.get(id))?.status ?? null,
    intervalMs,
    onStopped: () => {
      if (interrupted.signal.aborted) return;
      const reason = new Error(STOPPED_WHILE_LIVE);
      interrupted.abort(reason);
      stoppedElsewhere.abort(reason);
      void signalRuntime();
    },
  });
  return { signal: stoppedElsewhere.signal, stop };
}
