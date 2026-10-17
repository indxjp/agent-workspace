/**
 * `tests/conformance/a12-resource-limit-clock.test.ts` — the regression test for issue #562:
 * A.12's `enforce-resource-limits` scenario failed against the enforcing container fixture under
 * full-suite load on Linux (WSL2), although the fixture enforces its declared ceiling every time.
 *
 * The cause was the scenario's clock, not load as such. It measured its patience budget with
 * `Date.now()` while the fixture enforces `maxSessionSeconds` on Node's monotonic timer clock, so
 * two different clocks were compared:
 *
 * 1. A forward wall-clock jump (WSL2 corrects the guest clock against the host in steps) made the
 *    scenario's budget "elapse" before the fixture's monotonic limit timer could fire — the issue's
 *    run reported the whole file at 965 ms, under the 1 s ceiling, yet the budget of 2 s had gone.
 * 2. After an event-loop stall longer than the remaining grace, the scenario's synchronous
 *    `Date.now()` re-check ran before the fixture's already-due limit timer was dispatched, so the
 *    scenario pre-empted the driver it was observing.
 *
 * Each case below reproduces one cause deterministically against the real enforcing fixture, and
 * failed on the scenario as it stood before the fix. Only `Date` is faked; timers are always real,
 * because the fix's whole claim is about the order real timers fire in.
 */
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runA12ConformanceSuite } from './harness.js';
import { a12Scenarios } from './scenarios.js';
import {
  CONTAINER_FIXTURE_CAPABILITIES,
  containerFixtureProbe,
  createContainerFixtureDriver,
} from './fixtures/container-fixture.js';
import type { FixtureEvent, FixtureRequest } from './fixtures/common.js';

const SCENARIO_ID = 'enforce-resource-limits';

/** How far each `Date.now()` call leaps ahead of the previous one in case (a). */
const WALL_CLOCK_STEP_MS = 10_000;

/** Longer than the scenario's whole budget (1 s ceiling + 1 s grace), so both timers are overdue. */
const EVENT_LOOP_STALL_MS = 2_500;

function busyWait(durationMs: number): void {
  const until = performance.now() + durationMs;
  while (performance.now() < until) {
    // Deliberately synchronous: this models a loaded process that cannot run any timer callback.
  }
}

describe('A.12 enforce-resource-limits measures its budget on the monotonic timer clock (#562)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes against the enforcing fixture while the wall clock jumps forward', async () => {
    const realDateNow = Date.now.bind(Date);
    let jumps = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      jumps += 1;
      return realDateNow() + jumps * WALL_CLOCK_STEP_MS;
    });

    const report = await runA12ConformanceSuite(
      createContainerFixtureDriver(),
      CONTAINER_FIXTURE_CAPABILITIES,
      containerFixtureProbe,
    );
    const result = report.results.find((candidate) => candidate.id === SCENARIO_ID);

    expect(result?.detail).not.toMatch(/nothing enforced it/);
    expect(result?.verdict).toBe('pass');
  }, 20_000);

  it('passes against the enforcing fixture after an event-loop stall past the whole budget', async () => {
    const scenario = a12Scenarios<FixtureRequest, FixtureEvent>().find(
      (candidate) => candidate.id === SCENARIO_ID,
    );
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;

    const stall = setTimeout(() => {
      busyWait(EVENT_LOOP_STALL_MS);
    }, 50);
    try {
      const outcome = await scenario.run({
        driver: createContainerFixtureDriver(),
        capabilities: CONTAINER_FIXTURE_CAPABILITIES,
        probe: containerFixtureProbe,
      });

      expect(outcome.detail).not.toMatch(/nothing enforced it/);
      expect(outcome.ok).toBe(true);
    } finally {
      clearTimeout(stall);
    }
  }, 20_000);

  // A ceiling no single timer can hold used to be clamped by `setTimeout` to 1 ms, so the scenario
  // reported "still running 1000ms past that ceiling — nothing enforced it" within milliseconds.
  // It is now rejected before the driver is touched, with a detail that names the real problem.
  it.each([
    { ceiling: 2_147_484, reason: /exceeds the longest timer/ },
    { ceiling: Number.POSITIVE_INFINITY, reason: /finite number of seconds greater than 0/ },
    { ceiling: Number.NaN, reason: /finite number of seconds greater than 0/ },
    { ceiling: 0, reason: /finite number of seconds greater than 0/ },
    { ceiling: -1, reason: /finite number of seconds greater than 0/ },
  ])(
    'rejects a declared ceiling of $ceiling precisely instead of blaming the driver',
    async ({ ceiling, reason }) => {
      const scenario = a12Scenarios<FixtureRequest, FixtureEvent>().find(
        (candidate) => candidate.id === SCENARIO_ID,
      );
      expect(scenario).toBeDefined();
      if (scenario === undefined) return;

      const outcome = await scenario.run({
        driver: createContainerFixtureDriver(),
        capabilities: { ...CONTAINER_FIXTURE_CAPABILITIES, maxSessionSeconds: ceiling },
        probe: containerFixtureProbe,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.detail).not.toMatch(/nothing enforced it/);
      expect(outcome.detail).toMatch(reason);
    },
  );
});
