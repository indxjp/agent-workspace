/**
 * The holder's cancellation watch (ADR-0151-FU-1440 D1, issue #261).
 *
 * An interrupt can be served by any replica. It commits the run's stopped status and revokes the
 * run's tokens in one transaction (`stopIn`), so the committed status is the durable cancellation
 * request: no column says more. The replica holding the run's launch learns of it here, by reading
 * the run's status on an interval, and stops what it still drives for the run.
 *
 * The watch only reads. It never writes a status and never revokes a token; the interrupt did both
 * before it answered, which is what keeps "a caller never sees success for a run whose credential
 * is still live" (SDK-03-RUN-235).
 *
 * shortcut: poll, not LISTEN/NOTIFY; one status read per live run per interval on the replica that
 * holds it; upgrade when the lease of ADR-0151-FU-1440 lands (the renewal update replaces the
 * read), or batch the reads per process when they show up in database load (its gap 5).
 */
import { publicRunFailure } from './failures';
import { isStoppedRunStatus, type RunStatus } from './store';

/** How often the holder reads its run's status. Fixed by ADR-0151-FU-1440 D1; the lease TTL is five of these. */
export const CANCELLATION_WATCH_INTERVAL_MS = 2_000;

export interface CancellationWatch {
  readonly runId: string;
  /** The run's stored status, or `null` when the run no longer exists. */
  readonly readStatus: (runId: string) => Promise<RunStatus | null>;
  /** Defaults to {@link CANCELLATION_WATCH_INTERVAL_MS}; a test passes a shorter one. */
  readonly intervalMs?: number;
  /** Called at most once, the first time the run reads stopped or missing. */
  readonly onStopped: () => void;
}

/**
 * Watch `runId` until it reads stopped (terminal or `awaiting_approval`) or missing, then call
 * `onStopped` once and stop. A read that throws is reported and the watch keeps polling. A tick
 * still waiting on the store skips the next one, so reads never overlap. The returned `stop()` is
 * idempotent and also drops a read already in flight: the launch calls it before it writes its own
 * terminal status, which must not be taken for someone else's stop.
 */
export function watchRunForCancellation(watch: CancellationWatch): () => void {
  let stopped = false;
  let reading = false;
  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };
  const tick = async (): Promise<void> => {
    if (reading || stopped) return;
    reading = true;
    try {
      const status = await watch.readStatus(watch.runId);
      if (stopped || (status !== null && !isStoppedRunStatus(status))) return;
      stop();
      watch.onStopped();
    } catch (cause) {
      publicRunFailure(cause, {
        operation: 'watch-run-cancellation',
        publicMessage: 'The run status could not be read while the run was live.',
      });
    } finally {
      reading = false;
    }
  };
  const timer = setInterval(() => void tick(), watch.intervalMs ?? CANCELLATION_WATCH_INTERVAL_MS);
  timer.unref();
  return stop;
}
