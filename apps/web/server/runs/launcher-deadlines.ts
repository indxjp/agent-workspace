import { runStartRefusalError } from '../compose/run-preflight';
import { STALE_RUN_SWEEP_MARGIN_MS } from './stale-sweep';

export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * How long a completed run's storage write-back may take. The run stays `running`, and its session
 * busy, until the write-back ends, so it is bounded.
 */
export const STORAGE_WRITEBACK_DEADLINE_MS = 5 * 60_000;

/**
 * How long a run may stay `running` before the stale-run sweep fails it: its maximum duration, the
 * write-back allowance after it, and the sweep's margin. The write-back is cut short of it.
 */
export function staleRunAfterMs(maxRunDurationMs: number): number {
  return maxRunDurationMs + STORAGE_WRITEBACK_DEADLINE_MS + STALE_RUN_SWEEP_MARGIN_MS;
}

/**
 * What the write-back leaves of the host's function limit, so it stops, records its audit rows and
 * concludes the run before the host ends the function.
 */
export const STORAGE_WRITEBACK_HOST_MARGIN_MS = 10_000;

export function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The write-back's own deadline, cut to what the host's limit leaves and to what the stale-run
 * sweep's threshold leaves (from the stored `startedAt` it measures), each less the margin, at
 * `nowMs`.
 */
export function writeBackDeadlineMs(
  deadlineMs: number,
  hostMaxMs: number | null,
  startedAtMs: number,
  staleAfterMs: number | null,
  storedStartedAt: Date | null,
  nowMs: number,
): number {
  const hostLeftMs =
    hostMaxMs === null
      ? deadlineMs
      : hostMaxMs - (nowMs - startedAtMs) - STORAGE_WRITEBACK_HOST_MARGIN_MS;
  const sinceStartMs = nowMs - (storedStartedAt?.getTime() ?? startedAtMs);
  const staleLeftMs =
    staleAfterMs === null
      ? deadlineMs
      : staleAfterMs - sinceStartMs - STORAGE_WRITEBACK_HOST_MARGIN_MS;
  return Math.max(0, Math.min(deadlineMs, hostLeftMs, staleLeftMs));
}

/** Refuse, by name, a profile deadline that outlives the host's function limit (ADR-0120 LC7). */
export function assertDeadlineFitsHost(
  timeoutSeconds: number | undefined,
  hostMaxMs: number | null,
): void {
  if (hostMaxMs === null || timeoutSeconds === undefined || timeoutSeconds * 1_000 <= hostMaxMs) {
    return;
  }
  throw runStartRefusalError({
    code: 'run_deadline_exceeds_host',
    message:
      `the runtime profile's deadline of ${String(timeoutSeconds)}s is longer than the ` +
      `${String(Math.floor(hostMaxMs / 1_000))}s a run may last on this host. ` +
      'Shorten the timeout of the runtime profile.',
  });
}

/**
 * What is left of the host's function limit once preparation is done, or `null` on a host with
 * none. The host's clock started with the request: preparation (sandbox creation, workspace
 * hydration) already spent part of it. A budget with nothing left is refused like a deadline the
 * host cannot honour, before the runtime is contacted.
 */
export function hostBudgetLeft(
  hostMaxMs: number | null,
  startedAtMs: number,
  nowMs: number,
): number | null {
  if (hostMaxMs === null) return null;
  const remainingMs = hostMaxMs - (nowMs - startedAtMs);
  if (remainingMs > 0) return remainingMs;
  throw runStartRefusalError({
    code: 'run_deadline_exceeds_host',
    message:
      `preparing the run used the whole ${String(Math.floor(hostMaxMs / 1_000))}s a run may ` +
      'last on this host, so it was not started.',
  });
}

/** Name what bounds the run's lifetime, so a failure says whether the host limit ended it. */
export function describeLifetime(
  maxRunDurationMs: number | null,
  hostRemainingMs: number | null,
): string {
  return maxRunDurationMs !== null && maxRunDurationMs === hostRemainingMs
    ? `host-limited lifetime of ${String(maxRunDurationMs)}ms (the host's function limit ended it)`
    : `credential-bounded lifetime of ${String(maxRunDurationMs)}ms`;
}
