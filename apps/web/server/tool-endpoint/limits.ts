/**
 * Per-credential rate limit for the public MCP project endpoint (ADR-0134 part 2), keyed by the API
 * key's id so one noisy client cannot starve another and the key's secret is never held.
 *
 * ponytail: per-process counters, so each replica admits its own limit and a restart resets them;
 * move them to PostgreSQL when the control plane runs more than one replica.
 */
import { perMinuteLimiter, type Admission } from '../http/rate-limit';

/** Per minute and per credential: every call that passes the credential check. */
export const TOOL_ENDPOINT_RATE_LIMITS = { callsPerMinute: 120 } as const;

const calls = perMinuteLimiter(TOOL_ENDPOINT_RATE_LIMITS.callsPerMinute);

export function admitToolEndpointCall(credentialId: string, nowMs: number): Admission {
  return calls.admit(credentialId, nowMs);
}

export function resetToolEndpointLimits(): void {
  calls.clear();
}
