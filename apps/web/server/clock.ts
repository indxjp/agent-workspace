/**
 * The clock port: how server code asks for the current time.
 *
 * Code that depends on the time takes a `Clock` instead of calling `Date.now()` or `new Date()`
 * itself, and passes the time into a domain's `core/` as a plain `Date` argument. A test can then
 * fix the time instead of waiting for it. Production uses {@link systemClock}; tests use
 * {@link fixedClock}.
 */

/** Where the current time comes from. */
export interface Clock {
  /** The current time. Every call returns a new `Date`, so a caller cannot change the clock. */
  now(): Date;
}

/** The real clock. */
export const systemClock: Clock = Object.freeze({ now: () => new Date() });

/** A clock for tests: it stands still until the test moves it. */
export interface FixedClock extends Clock {
  /** Moves the clock forward. Throws a `RangeError` for a negative or non-finite amount. */
  advance(milliseconds: number): void;
  /** Moves the clock to `time`, forward or back. Throws a `RangeError` for an invalid date. */
  set(time: Date | string): void;
}

/** A clock that reads `start` until the test calls `advance` or `set`. */
export function fixedClock(start: Date | string): FixedClock {
  let current = toEpochMilliseconds(start);
  return {
    now: () => new Date(current),
    advance: (milliseconds) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new RangeError(
          `fixedClock.advance needs a finite, non-negative number of milliseconds, got ${String(milliseconds)}`,
        );
      }
      current += milliseconds;
    },
    set: (time) => {
      current = toEpochMilliseconds(time);
    },
  };
}

function toEpochMilliseconds(time: Date | string): number {
  const milliseconds = new Date(time).getTime();
  if (Number.isNaN(milliseconds)) {
    throw new RangeError(`fixedClock needs a valid date, got ${String(time)}`);
  }
  return milliseconds;
}
