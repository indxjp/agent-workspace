/**
 * Rate limits on the OAuth endpoints (ADR-0134 part 3). A `client_id` is public, so it is counted
 * only after the client authenticated: nobody can lock a client out by naming it. Guessing a secret
 * is bounded by the failed authentications of the source address instead, checked before the
 * secret is.
 *
 * ponytail: per-process counters, so each replica admits its own limit and a restart resets them;
 * move them to PostgreSQL when the control plane runs more than one replica.
 */
import { admitClient, clientBucket, perMinuteLimiter, type Admission } from '../http/rate-limit';

export const OAUTH_RATE_LIMITS = {
  perClientPerMinute: 60,
  perAddressPerMinute: 120,
  failedAuthPerAddressPerMinute: 10,
  authorizePerSessionPerMinute: 30,
} as const;

const byClient = perMinuteLimiter(OAUTH_RATE_LIMITS.perClientPerMinute);
const byAddress = perMinuteLimiter(OAUTH_RATE_LIMITS.perAddressPerMinute);
const bySession = perMinuteLimiter(OAUTH_RATE_LIMITS.authorizePerSessionPerMinute);
const byFailure = perMinuteLimiter(OAUTH_RATE_LIMITS.failedAuthPerAddressPerMinute);

type Env = Readonly<Record<string, string | undefined>>;

/** Whether the source address may attempt client authentication; counts nothing. */
export function admitOAuthAuthAttempt(
  headers: Headers,
  nowMs: number,
  env: Env = process.env,
): Admission {
  const bucket = clientBucket(OAUTH_RATE_LIMITS.failedAuthPerAddressPerMinute, headers, env);
  return byFailure.peek(bucket.key, nowMs, bucket.limit);
}

/** Count one failed client authentication against the source address. */
export function recordOAuthAuthFailure(
  headers: Headers,
  nowMs: number,
  env: Env = process.env,
): void {
  admitClient(byFailure, OAUTH_RATE_LIMITS.failedAuthPerAddressPerMinute, headers, nowMs, env);
}

export const admitOAuthAddress = (
  headers: Headers,
  nowMs: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Admission => admitClient(byAddress, OAUTH_RATE_LIMITS.perAddressPerMinute, headers, nowMs, env);

export const admitOAuthClient = (clientId: string, nowMs: number): Admission =>
  byClient.admit(clientId, nowMs);

export const admitOAuthSession = (principalId: string, nowMs: number): Admission =>
  bySession.admit(principalId, nowMs);

export function resetOAuthLimits(): void {
  byClient.clear();
  byAddress.clear();
  bySession.clear();
  byFailure.clear();
}
