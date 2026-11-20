/** A.12 scenario 7: enforce cpu / memory / timeout limits. */
import { randomUUID } from 'node:crypto';

import { fail, pass, type A12RunOutcome } from './support.js';
import { createSandbox, type A12ScenarioContext } from './scenario-types.js';
import { REAL_TIMERS, type A12Timer, type A12Timers } from './timers.js';

/**
 * How long past a driver's own declared `maxSessionSeconds` this scenario waits before concluding
 * nothing enforced it. This is patience for the DRIVER's enforcement to land, never the mechanism
 * that stops the turn — ADR-0046 rule 2: "the gate must not supply the force it is testing for."
 * Compare round 1, which called `connection.interrupt()` itself and then asserted the turn had
 * stopped — the harness supplying its own force, which is scenario 8's subject, not scenario 7's,
 * and which passed unconditionally regardless of what (if anything) the driver enforced.
 *
 * The whole budget (`maxSessionSeconds` + this grace) is ONE `setTimeout`, armed once before the
 * turn's first `.next()` and raced by every `.next()` after it. It is never measured with
 * `Date.now()` (issue #562): a driver enforces its ceiling on Node's monotonic timer clock, and
 * comparing that with the wall clock failed an enforcing driver twice over. A forward wall-clock
 * jump (WSL2 steps the guest clock under load) made the budget "elapse" before the driver's limit
 * timer could fire; and after an event-loop stall a synchronous `Date.now()` re-check declared the
 * timeout before the driver's already-due limit timer had been dispatched. With one monotonic
 * timer armed first, a driver's limit timer armed later for a shorter delay expires earlier, and
 * Node dispatches due timers in expiry order, draining microtasks between callbacks.
 *
 * That ordering guarantee is narrower than "any enforcing driver survives any stall". It holds for
 * a driver that (a) arms its limit timer no later than the turn's first events, with no I/O hop
 * between this scenario arming the budget and the driver arming its limit — as the enforcing
 * fixture does — and (b) finishes the enforcement in microtasks once that timer fires. A driver
 * that arms its ceiling after an I/O hop, or whose kill needs another macrotask (`setImmediate`,
 * a process exit over I/O), can still lose to a stall that lands in that gap: once both timers are
 * overdue, this scenario's patience fires in the same timers phase, before the kill lands. That is
 * the same as before issue #562 and is a property of measuring a deadline at all; this grace is
 * what absorbs it in an unstalled process.
 */
const RESOURCE_LIMIT_GRACE_MS = 1_000;

/**
 * The longest delay Node's `setTimeout` honours (2^31 - 1 ms, about 24.8 days). A larger, NaN or
 * infinite delay is clamped to 1 ms with only a process warning, so a budget past it would make
 * this scenario report "nothing enforced it" within milliseconds — a false fail with a misleading
 * detail. Such a ceiling is rejected up front with a precise detail instead.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const TIMED_OUT = Symbol('a12-resource-limit-timed-out');

/**
 * Validated before the driver is touched: a ceiling that is not a finite positive number, or
 * whose budget a single timer cannot hold, cannot be enforced against — reject it precisely
 * rather than let `setTimeout` clamp the budget to 1 ms and blame the driver (ADR-0015).
 */
function resolvePatienceBudget(
  ceilingSeconds: number | null,
): { readonly budgetMs: number; readonly ceilingSeconds: number } | A12RunOutcome {
  if (ceilingSeconds === null) {
    // The `requirement` gates on this exact field, so `run` should never be reached with a
    // null ceiling — this is a defensive `fail`, not a reachable branch, per ADR-0015: a check
    // that cannot proceed must reject, never silently proceed as if a ceiling existed.
    return fail(
      'scenario ran without a declared capabilities.maxSessionSeconds ceiling to enforce against',
    );
  }
  if (!Number.isFinite(ceilingSeconds) || ceilingSeconds <= 0) {
    return fail(
      `capabilities.maxSessionSeconds must be a finite number of seconds greater than 0 to enforce against, but the driver declared ${String(ceilingSeconds)}`,
    );
  }
  const budgetMs = ceilingSeconds * 1_000 + RESOURCE_LIMIT_GRACE_MS;
  if (budgetMs > MAX_TIMER_DELAY_MS) {
    return fail(
      `capabilities.maxSessionSeconds declares ${String(ceilingSeconds)}s, whose budget (${String(budgetMs)}ms with grace) exceeds the longest timer this scenario can arm (${String(MAX_TIMER_DELAY_MS)}ms), so the ceiling cannot be checked`,
    );
  }
  return { budgetMs, ceilingSeconds };
}

/**
 * Drain a turn's events, racing every `.next()` against ONE patience timer armed before the first.
 * No call to `connection.interrupt()` happens here: the ONLY thing that may end this turn is the
 * driver's own enforcement of the ceiling it declared (see `RESOURCE_LIMIT_GRACE_MS` for why not
 * `Date.now()`).
 */
async function drainWithinPatience<TEvent>(
  iterator: AsyncIterator<TEvent>,
  timers: A12Timers,
  budgetMs: number,
): Promise<{ readonly events: TEvent[]; readonly timedOut: boolean }> {
  let patienceTimer: A12Timer | undefined;
  const patience$ = new Promise<typeof TIMED_OUT>((resolve) => {
    patienceTimer = timers.setTimeout(() => {
      resolve(TIMED_OUT);
    }, budgetMs);
  });
  const events: TEvent[] = [];
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), patience$]);
      if (next === TIMED_OUT) return { events, timedOut: true };
      if (next.done) return { events, timedOut: false };
      events.push(next.value);
    }
  } finally {
    timers.clearTimeout(patienceTimer);
  }
}

export async function runEnforceResourceLimits<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, capabilities, probe } = ctx;
  const timers = ctx.timers ?? REAL_TIMERS;
  const budget = resolvePatienceBudget(capabilities.maxSessionSeconds);
  if ('ok' in budget) return budget;
  const { budgetMs, ceilingSeconds } = budget;

  const handle = await createSandbox(driver, 'limits', 'limits');
  try {
    const connection = await driver.startAgent(
      handle,
      probe.agent.buildRequest({ kind: 'long-running', marker: `a12-limits-${randomUUID()}` }),
    );
    const iterator = connection.events[Symbol.asyncIterator]();
    const { events, timedOut } = await drainWithinPatience(iterator, timers, budgetMs);

    if (timedOut) {
      // The budget the driver itself declared has already elapsed with nothing stopping the turn
      // — the verdict is `fail` regardless of what happens next. `interrupt()` here is cleanup so
      // the process can exit, not part of the check: it runs only after the fail is already
      // decided.
      await connection.interrupt();
      for (;;) {
        const next = await iterator.next().catch(() => ({ done: true as const, value: undefined }));
        if (next.done) break;
      }
      return fail(
        `capabilities.maxSessionSeconds claims ${String(ceilingSeconds)}s, but a long-running turn was still running ${String(RESOURCE_LIMIT_GRACE_MS)}ms past that ceiling — nothing enforced it`,
      );
    }

    if (!probe.agent.interpretEvents(events).wasInterrupted) {
      return fail(
        `the turn ended within capabilities.maxSessionSeconds (${String(ceilingSeconds)}s) but its own events never recorded that it had been stopped by an enforced limit`,
      );
    }
    return pass(
      `a long-running turn was stopped by the driver's own enforcement of its declared maxSessionSeconds (${String(ceilingSeconds)}s, +${String(RESOURCE_LIMIT_GRACE_MS)}ms grace) — this scenario never called interrupt() while the turn was live`,
    );
  } finally {
    await driver.destroy(handle);
  }
}
