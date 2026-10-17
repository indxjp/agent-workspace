/**
 * `tests/conformance/harness.ts` — the one exported function the wave plan's Accept line names:
 * *"one exported harness ... taking a driver and its declared `RuntimeCapabilities` and
 * executable against any driver."*
 *
 * `runA12ConformanceSuite` is deliberately the only thing here a caller needs. It does not read
 * `driver.capabilities` itself — `capabilities` is a separate argument — because A.12's honesty
 * rule is a claim made *about* a capability record, and the one test required to prove the rule
 * (`tests/conformance/a12-honesty.test.ts`) needs to pass a capability record the fixture driver
 * does not actually have, exactly as the Wave 3 plan's cell describes: *"flip a capability
 * field to true in a fixture driver that cannot honour it, and the harness fails."* Every other
 * caller passes `driver.capabilities` itself, which is what makes the two-argument shape also the
 * honest one in the ordinary case.
 */
import { a12Scenarios } from './scenarios.js';
import type {
  A12Probe,
  A12Report,
  A12ScenarioResult,
  RuntimeCapabilities,
  RuntimeDriver,
} from './types.js';

export async function runA12ConformanceSuite<TRequest, TEvent>(
  driver: RuntimeDriver<TRequest, TEvent>,
  capabilities: RuntimeCapabilities,
  probe: A12Probe<TRequest, TEvent>,
): Promise<A12Report> {
  const results: A12ScenarioResult[] = [];

  for (const scenario of a12Scenarios<TRequest, TEvent>()) {
    const requirement = scenario.requirement(capabilities, driver);

    // ADR-0015: the capability record is asked a positive question — "does it claim this
    // scenario?" — and `unsupported-by-capability` is the answer only when that question comes
    // back false. The scenario's `run()` is never even called in that case, which is what keeps a
    // driver from being able to pass by weakening a scenario it does not actually support: there
    // is no code path in which a declared-unsupported scenario is also attempted.
    if (!requirement.met) {
      results.push({
        id: scenario.id,
        name: scenario.name,
        verdict: 'unsupported-by-capability',
        detail: requirement.reason,
      });
      continue;
    }

    try {
      const outcome = await scenario.run({ driver, capabilities, probe });
      results.push({
        id: scenario.id,
        name: scenario.name,
        verdict: outcome.ok ? 'pass' : 'fail',
        detail: outcome.ok
          ? outcome.detail
          : `capabilities claimed support for this scenario, and it failed: ${outcome.detail}`,
      });
    } catch (error) {
      // A scenario whose own machinery throws (a rejected promise it did not expect, a timeout)
      // is not a silent skip either — ADR-0015's "a check that cannot run must fail" applies to
      // the harness's own execution, not only to the scenarios' internal assertions.
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: scenario.id,
        name: scenario.name,
        verdict: 'fail',
        detail: `capabilities claimed support for this scenario, and running it threw: ${message}`,
      });
    }
  }

  const dishonestCapabilityClaims = results.filter((result) => result.verdict === 'fail');

  return {
    driverId: driver.id,
    results,
    ok: dishonestCapabilityClaims.length === 0,
    dishonestCapabilityClaims,
  };
}

/**
 * Throws a single, readable error naming every scenario A.12's honesty rule calls a hard failure
 * (capabilities claimed support, the scenario failed), or does nothing if there are none.
 *
 * A convenience for test files (`expect(() => assertHonestReport(report)).not.toThrow()` /
 * `.toThrow(/.../)`), not used by `runA12ConformanceSuite` itself — the harness always returns a
 * report rather than throwing, so a caller can inspect every scenario's verdict even when some of
 * them failed.
 */
export function assertHonestReport(report: A12Report): void {
  if (report.dishonestCapabilityClaims.length === 0) {
    return;
  }
  const lines = report.dishonestCapabilityClaims.map(
    (result) => `  - ${result.id} (${result.name}): ${result.detail}`,
  );
  throw new Error(
    `driver ${JSON.stringify(report.driverId)} claimed capabilities it did not honour, in ` +
      `${String(report.dishonestCapabilityClaims.length)} scenario(s):\n${lines.join('\n')}`,
  );
}
