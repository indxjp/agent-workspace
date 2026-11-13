/**
 * `testClock`: a clock a test moves by hand (ADR-0164 T4), for `recipeRunner`'s and
 * `serveRecipes`' `clock` and for `recipeHarness`. Production refuses a clock: `serveRecipes`
 * throws `clock_override_refused` under `NODE_ENV=production`.
 */

/** A clock that stands still until it is set or advanced. */
export interface TestClock {
  /** The clock's time; a fresh `Date` each call. */
  now(): Date;
  /** Moves the clock to `at`, forward or back. */
  set(at: Date | string): void;
  /** Moves the clock forward by `ms` milliseconds. */
  advance(ms: number): void;
}

const DEFAULT_START = '2026-01-01T00:00:00.000Z';

function timeOf(at: Date | string): number {
  const time = (typeof at === 'string' ? new Date(at) : at).getTime();
  if (Number.isNaN(time)) throw new TypeError('testClock takes a valid date');
  return time;
}

/** A clock at `start` (2026-01-01T00:00:00Z when not given) that moves only when told. */
export function testClock(start: Date | string = DEFAULT_START): TestClock {
  let time = timeOf(start);
  return {
    now: () => new Date(time),
    set(at) {
      time = timeOf(at);
    },
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError('testClock.advance takes a finite, non-negative number of ms');
      }
      time += ms;
    },
  };
}
