/**
 * Per-credential rate limits for the public A2A route (ADR-0135), keyed by the API key's id so one
 * noisy client cannot starve another and the key's secret is never held.
 *
 * ponytail: per-process counters, so each replica admits its own limit and a restart resets them;
 * move them to PostgreSQL when the control plane runs more than one replica.
 */
import { admitClient, perMinuteLimiter, type Admission } from '../http/rate-limit';

/**
 * Per minute and per credential: every call, and the calls that start a run. The agent card is
 * public, so its fetches are counted per client address instead.
 */
export const A2A_RATE_LIMITS = {
  callsPerMinute: 120,
  messagesPerMinute: 30,
  cardFetchesPerAddressPerMinute: 60,
} as const;

const calls = perMinuteLimiter(A2A_RATE_LIMITS.callsPerMinute);
const messages = perMinuteLimiter(A2A_RATE_LIMITS.messagesPerMinute);
const cardFetches = perMinuteLimiter(A2A_RATE_LIMITS.cardFetchesPerAddressPerMinute);

export const admitA2aCardFetch = (
  headers: Headers,
  nowMs: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Admission =>
  admitClient(cardFetches, A2A_RATE_LIMITS.cardFetchesPerAddressPerMinute, headers, nowMs, env);

export function admitA2aCall(credentialId: string, nowMs: number): Admission {
  return calls.admit(credentialId, nowMs);
}

export function admitA2aMessage(credentialId: string, nowMs: number): Admission {
  return messages.admit(credentialId, nowMs);
}

export function resetA2aLimits(): void {
  calls.clear();
  messages.clear();
  cardFetches.clear();
}
