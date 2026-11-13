/**
 * The webhook retry policy (N-3, issue #250, ADR-SDK-18-N3-250 D4). Pure: the time and the
 * randomness are arguments.
 *
 * After failed attempt _n_ the next attempt is due after the _n_-th delay below, multiplied by a
 * uniform jitter factor in [0.8, 1.2]. Seven delays make eight attempts over about 21 hours; after
 * the eighth failure there is no next attempt and the delivery is `failed`.
 */

/** The base delay after each failed attempt, in milliseconds: 30 s, 2 min, 10 min, 30 min, 2 h, 6 h, 12 h. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
];

/** The most attempts one delivery gets: one first attempt and one per delay. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;

/** The jitter factor's bounds (ADR D4). */
export const WEBHOOK_JITTER_MIN = 0.8;
export const WEBHOOK_JITTER_MAX = 1.2;

/**
 * When the attempt after failed attempt `attempts` (counting from 1) is due, or `null` once the
 * attempts are exhausted. `random` is a uniform draw in [0, 1); a value outside it is clamped, so a
 * bad source cannot move a retry outside the jitter bounds.
 */
export function nextAttemptAt(
  attempts: number,
  now: Date,
  random: () => number = Math.random,
): Date | null {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError('attempts must be a positive safe integer');
  }
  const base = WEBHOOK_RETRY_DELAYS_MS[attempts - 1];
  if (base === undefined) return null;
  const draw = Math.min(1, Math.max(0, random()));
  const factor = WEBHOOK_JITTER_MIN + (WEBHOOK_JITTER_MAX - WEBHOOK_JITTER_MIN) * draw;
  return new Date(now.getTime() + Math.round(base * factor));
}
