/**
 * The timer clock A.12's `enforce-resource-limits` scenario and the fixture drivers measure a
 * session ceiling on.
 *
 * A real driver is checked on real time: the harness defaults to {@link REAL_TIMERS}, so a
 * ceiling of one second is one second of Node's monotonic timer clock. The fixture drivers under
 * `fixtures/` only stand in for a driver, and the scenario's verdict depends on the ORDER two
 * timers fire in — the driver's own limit timer before the scenario's patience budget — not on how
 * long a second is. {@link FIXTURE_TIMERS} keeps both on real Node timers, so that order is the
 * one issue #562 is about, and divides every delay by {@link FIXTURE_TIME_COMPRESSION}: a 1 s
 * ceiling with its 1 s grace becomes 100 ms and 100 ms, and a fixture run that used to wait one
 * or two seconds per suite waits a tenth of that.
 *
 * The scenario and the fixture driver it observes must share one clock. A fixture defaults to
 * {@link FIXTURE_TIMERS}, so a harness left on real time only gives it more patience than it
 * needs; the A.12 tests pass {@link FIXTURE_TIMERS} to the harness as well.
 */

export type A12Timer = ReturnType<typeof setTimeout>;

export interface A12Timers {
  /** Arms one timer for `delayMs` of this clock's time. */
  readonly setTimeout: (callback: () => void, delayMs: number) => A12Timer;
  readonly clearTimeout: (timer: A12Timer | undefined) => void;
}

export const REAL_TIMERS: A12Timers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => {
    clearTimeout(timer);
  },
};

/**
 * Real Node timers whose every delay is `factor` times shorter. The grace between the two timers
 * shrinks by the same factor, which is why the factor stays small: the fixture arms its limit
 * within microtasks of the scenario arming its budget, so 100 ms of grace is still several orders
 * of magnitude more than the gap it has to absorb.
 */
export function compressedTimers(factor: number): A12Timers {
  if (!Number.isFinite(factor) || factor < 1) {
    throw new Error(
      `a timer compression factor must be a finite number >= 1, not ${String(factor)}`,
    );
  }
  return {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs / factor),
    clearTimeout: (timer) => {
      clearTimeout(timer);
    },
  };
}

export const FIXTURE_TIME_COMPRESSION = 10;

export const FIXTURE_TIMERS: A12Timers = compressedTimers(FIXTURE_TIME_COMPRESSION);
