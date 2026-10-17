/**
 * Per-client admission for every bootstrap-password check: the sign-in screen's server action and
 * `POST /api/setup`, both of which call `signIn()` before any session exists. Kept out of
 * `session.ts` because the proxy imports that module and these counters need `node:` built-ins.
 */
import { admitClient, perMinuteLimiter, type Admission } from '../http/rate-limit';

/** Password attempts per client per minute; plenty for a person, nothing for a guesser. */
export const SIGN_IN_ATTEMPTS_PER_MINUTE = 10;

const attempts = perMinuteLimiter(SIGN_IN_ATTEMPTS_PER_MINUTE);

/** Count one password attempt from the client `headers` identify, or say when to retry. */
export function admitSignInAttempt(
  headers: Headers,
  nowMs: number = Date.now(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Admission {
  return admitClient(attempts, SIGN_IN_ATTEMPTS_PER_MINUTE, headers, nowMs, env);
}

/** Forget every client's count. Tests only. */
export function resetSignInAttempts(): void {
  attempts.clear();
}
