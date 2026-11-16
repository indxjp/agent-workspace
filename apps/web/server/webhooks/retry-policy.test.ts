import { describe, expect, it } from 'vitest';

import {
  nextAttemptAt,
  WEBHOOK_JITTER_MAX,
  WEBHOOK_JITTER_MIN,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
} from './retry-policy';

const NOW = new Date('2026-10-31T00:00:00.000Z');

const delayAfter = (attempts: number, draw: number): number => {
  const at = nextAttemptAt(attempts, NOW, () => draw);
  if (at === null) throw new Error(`no attempt after ${String(attempts)}`);
  return at.getTime() - NOW.getTime();
};

describe('nextAttemptAt (ADR-SDK-18-N3-250 D4)', () => {
  it('gives eight attempts: seven delays, then none', () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(8);
    expect(WEBHOOK_RETRY_DELAYS_MS).toEqual([
      30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000,
    ]);
    expect(delayAfter(1, 0.5)).toBe(30_000);
    expect(delayAfter(7, 0.5)).toBe(43_200_000);
  });

  it('is monotonic even when one delay draws the most jitter and the next the least', () => {
    for (let attempts = 1; attempts < WEBHOOK_MAX_ATTEMPTS - 1; attempts += 1) {
      expect(delayAfter(attempts, 1), `after ${String(attempts)}`).toBeLessThan(
        delayAfter(attempts + 1, 0),
      );
    }
  });

  it('is capped at the last delay with the most jitter', () => {
    const cap = 12 * 3_600_000 * WEBHOOK_JITTER_MAX;
    for (let attempts = 1; attempts < WEBHOOK_MAX_ATTEMPTS; attempts += 1) {
      expect(delayAfter(attempts, 0.999_999)).toBeLessThanOrEqual(cap);
    }
  });

  it('keeps jitter within [0.8, 1.2] of the base, clamping a stub outside [0, 1)', () => {
    expect(delayAfter(1, 0)).toBe(30_000 * WEBHOOK_JITTER_MIN);
    expect(delayAfter(1, 1)).toBe(30_000 * WEBHOOK_JITTER_MAX);
    expect(delayAfter(2, -5)).toBe(120_000 * WEBHOOK_JITTER_MIN);
    expect(delayAfter(2, 7)).toBe(120_000 * WEBHOOK_JITTER_MAX);
    for (const draw of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const delay = delayAfter(3, draw);
      expect(delay).toBeGreaterThanOrEqual(600_000 * WEBHOOK_JITTER_MIN);
      expect(delay).toBeLessThanOrEqual(600_000 * WEBHOOK_JITTER_MAX);
    }
  });

  it('returns null once the attempts are exhausted', () => {
    expect(nextAttemptAt(WEBHOOK_MAX_ATTEMPTS, NOW, () => 0.5)).toBeNull();
    expect(nextAttemptAt(WEBHOOK_MAX_ATTEMPTS + 3, NOW, () => 0.5)).toBeNull();
  });

  it('refuses an attempt count that is not a positive integer', () => {
    for (const attempts of [0, -1, 1.5, Number.NaN]) {
      expect(() => nextAttemptAt(attempts, NOW)).toThrow(RangeError);
    }
  });
});
