/**
 * Issue #242 (SDK-10, S-22) review round 1: bounded, per-client admission for `aw login`'s
 * pre-authentication routes and its approval `POST`. ADR-0083 §9. The counters and the client key
 * are the shared ones in `../http/rate-limit.ts`.
 */
import {
  admitClient,
  CLIENT_MEMORY,
  FixedWindowLimiter,
  MINUTE_MS,
  type Admission,
} from '../http/rate-limit';

/**
 * Per client per minute. Start: a person runs `aw login` a handful of times. Poll: one CLI polls
 * every `CLI_POLL_INTERVAL_SECONDS` (12 a minute), so 60 leaves room for a few concurrent sign-ins
 * behind one NAT. Approve: a person submits the form once per sign-in.
 */
export const CLI_AUTH_LIMITS = {
  start: 10,
  poll: 60,
  approve: 10,
} as const;

export type CliAuthRoute = keyof typeof CLI_AUTH_LIMITS;

const limiters: Record<CliAuthRoute, FixedWindowLimiter> = {
  start: new FixedWindowLimiter({
    limit: CLI_AUTH_LIMITS.start,
    windowMs: MINUTE_MS,
    capacity: CLIENT_MEMORY,
  }),
  poll: new FixedWindowLimiter({
    limit: CLI_AUTH_LIMITS.poll,
    windowMs: MINUTE_MS,
    capacity: CLIENT_MEMORY,
  }),
  approve: new FixedWindowLimiter({
    limit: CLI_AUTH_LIMITS.approve,
    windowMs: MINUTE_MS,
    capacity: CLIENT_MEMORY,
  }),
};

/** Admit one request to `route` from the client `headers` identify, or say when to retry. */
export function admitCliAuthRequest(
  route: CliAuthRoute,
  headers: Headers,
  nowMs: number = Date.now(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Admission {
  return admitClient(limiters[route], CLI_AUTH_LIMITS[route], headers, nowMs, env);
}

/** Forget every client's count. Tests only. */
export function resetCliAuthRateLimits(): void {
  for (const limiter of Object.values(limiters)) limiter.clear();
}
