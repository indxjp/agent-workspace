/**
 * `tests/conformance/a12-honesty.test.ts` — the test the wave plan's cell requires by name:
 * *"flip a capability field to true in a fixture driver that cannot honour it, and the harness
 * fails."*
 *
 * The fixture is the real `local` driver, unmodified — `packages/runtime/src/local.ts` is not in
 * this task's `Owns` glob and nothing about it needs to be fake. What is flipped is the second
 * argument `runA12ConformanceSuite` takes: a copy of `LOCAL_RUNTIME_CAPABILITIES` with
 * `networkPolicies` widened to include `"none"`, a claim the real driver cannot honour (its own
 * capability record says `networkPolicies: ['open']`, and its basis for that field says exactly
 * why — see `local.ts`). `networkPolicies` is an array, not a boolean, so "flip a field to `true`"
 * becomes "add the entry the driver does not have" — the array-typed version of the same lie; see
 * this file's header comment on why this field was chosen over inventing a wholly separate fixture
 * driver.
 *
 * A.12, verbatim: *"A driver that cannot pass a scenario declares it unsupported in
 * `RuntimeCapabilities`; it must never pass by weakening the test."* This test proves the harness
 * enforces exactly that: with the honest capability record, `enforce-network-none` is
 * `unsupported-by-capability` (`a12-local.test.ts`); with the lied-about one, the *same* driver,
 * the *same* scenario, is attempted for real and reported `fail`, naming both the capability claim
 * and what was actually observed.
 *
 * Round 2 found `local` also fails `no-host-claude-config-visible` — `isolation: 'none'` genuinely
 * leaks whatever the scenario asks about — but round 2's version of that scenario asked about THIS
 * machine's real `~/.claude`, so whether the failure showed up was a fact about the machine running
 * the test. Round 3 (ADR-0047) makes the scenario seed its own marker instead, so `local` fails it
 * unconditionally now, and this file asserts that as a fixed constant rather than computing it from
 * the host. The second test uses the fully-honest `container-fixture.ts` driver, not `local`, as
 * its positive control regardless — `local` has a real, flip-independent failure of its own now
 * (`no-host-claude-config-visible`), so it cannot serve as a driver whose capabilities and
 * behaviour agree in full.
 */
import { describe, expect, it } from 'vitest';

import { runA12ConformanceSuite } from './harness.js';
import {
  createLocalFixtureDriver,
  LOCAL_RUNTIME_CAPABILITIES,
  localFixtureProbe,
} from './fixtures/local-fixture.js';
import {
  CONTAINER_FIXTURE_CAPABILITIES,
  containerFixtureProbe,
  createContainerFixtureDriver,
} from './fixtures/container-fixture.js';

describe('A.12 honesty rule: a capability claim the driver cannot honour is a hard failure', () => {
  it('fails enforce-network-none when networkPolicies is flipped to claim "none", naming both the claim and the observation', async () => {
    const dishonestCapabilities = {
      ...LOCAL_RUNTIME_CAPABILITIES,
      networkPolicies: [...LOCAL_RUNTIME_CAPABILITIES.networkPolicies, 'none'] as const,
    };
    expect(dishonestCapabilities.networkPolicies).toContain('none');
    // Confirm the flip is real, not vacuous: the honest record really does lack this entry.
    expect(LOCAL_RUNTIME_CAPABILITIES.networkPolicies).not.toContain('none');

    const driver = createLocalFixtureDriver();
    const report = await runA12ConformanceSuite(driver, dishonestCapabilities, localFixtureProbe);

    console.log(
      `A.12 honesty-rule probe (networkPolicies flipped to claim "none" on the real local driver):\n${report.results
        .map((result) => `  ${result.verdict.padEnd(24)} ${result.id} — ${result.detail}`)
        .join('\n')}`,
    );

    expect(report.ok).toBe(false);
    // `enforce-network-none` is the flip this test is about. `no-host-claude-config-visible` always
    // joins it now — a real, flip-independent failure `local` has on every machine since round 3's
    // fix (ADR-0047) stopped depending on whether this host happens to have a real ~/.claude.
    expect(report.dishonestCapabilityClaims.map((result) => result.id)).toEqual([
      'enforce-network-none',
      'no-host-claude-config-visible',
    ]);

    const failure = report.results.find((result) => result.id === 'enforce-network-none');
    expect(failure?.verdict).toBe('fail');
    // Names both: the claim (networkPolicies / "none") and the observation (the blocked host was
    // actually reachable, because `local` enforces nothing).
    expect(failure?.detail).toMatch(/networkPolicies/);
    expect(failure?.detail).toMatch(/"none"/);
    expect(failure?.detail).toMatch(/reached/);

    // The lie is scoped to exactly the one scenario it claimed — every OTHER verdict besides the
    // pre-existing, flip-independent host-config failure is unchanged from the honest run
    // (`a12-local.test.ts`), which is what proves this is a targeted honesty check and not a
    // harness that fails everything once anything is off.
    const otherVerdicts = Object.fromEntries(
      report.results
        .filter(
          (result) =>
            result.id !== 'enforce-network-none' && result.id !== 'no-host-claude-config-visible',
        )
        .map((result) => [result.id, result.verdict]),
    );
    expect(otherVerdicts).toEqual({
      'create-and-destroy': 'pass',
      'trivial-agent-turn': 'pass',
      'hydrate-and-collect-files': 'pass',
      'resume-after-sandbox-gone': 'pass',
      'enforce-network-restricted': 'unsupported-by-capability',
      'enforce-resource-limits': 'unsupported-by-capability',
      'interrupt-running-agent': 'pass',
      'concurrent-sessions-file-isolation': 'unsupported-by-capability',
    });

    // And the host-config scenario itself is `fail`, unconditionally now (mirrors `a12-local.test.ts`).
    const hostConfig = report.results.find(
      (result) => result.id === 'no-host-claude-config-visible',
    );
    expect(hostConfig?.verdict).toBe('fail');
  }, 20_000);

  it('assertHonestReport throws, naming the scenario, for a dishonest report — and does not throw for a fully honest one', async () => {
    const { assertHonestReport } = await import('./harness.js');

    // The positive control has to be a driver whose capabilities and behaviour agree in full —
    // `local` cannot serve as one any more, because it has a real, flip-independent failure
    // (no-host-claude-config-visible; see above). `container-fixture.ts` is exactly the fixture
    // this task built to prove the harness can report a full, honest, ten-for-ten `pass`
    // (`a12-container-fixture.test.ts`), so it is the fully-honest side of this proof instead.
    const honestDriver = createContainerFixtureDriver();
    const honestReport = await runA12ConformanceSuite(
      honestDriver,
      CONTAINER_FIXTURE_CAPABILITIES,
      containerFixtureProbe,
    );
    expect(() => {
      assertHonestReport(honestReport);
    }).not.toThrow();

    const dishonestCapabilities = {
      ...LOCAL_RUNTIME_CAPABILITIES,
      networkPolicies: [...LOCAL_RUNTIME_CAPABILITIES.networkPolicies, 'none'] as const,
    };
    const dishonestDriver = createLocalFixtureDriver();
    const dishonestReport = await runA12ConformanceSuite(
      dishonestDriver,
      dishonestCapabilities,
      localFixtureProbe,
    );
    expect(() => {
      assertHonestReport(dishonestReport);
    }).toThrowError(/enforce-network-none/);
  }, 20_000);
});
