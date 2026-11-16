/**
 * Per-run rate limit for `POST /api/builder/mcp` (the run-token door), keyed by the run the verified
 * token names, so one runaway run cannot starve another and the token itself is never held. The
 * per-run tool-call limit in the core bounds journaled calls; this bounds every request, `tools/list`
 * and refused calls included.
 *
 * ponytail: per-process counters, so each replica admits its own limit and a restart resets them;
 * move them to PostgreSQL when the control plane runs more than one replica.
 */
import { perMinuteLimiter, type Admission } from '../../http/rate-limit';

/** Per minute and per run: every request that passes the token check. Matches the sibling tool endpoints. */
export const BUILDER_DOOR_RATE_LIMITS = { callsPerMinutePerRun: 120 } as const;

const calls = perMinuteLimiter(BUILDER_DOOR_RATE_LIMITS.callsPerMinutePerRun);

export function admitBuilderDoorCall(runId: string, nowMs: number): Admission {
  return calls.admit(runId, nowMs);
}

export function resetBuilderDoorLimits(): void {
  calls.clear();
}
