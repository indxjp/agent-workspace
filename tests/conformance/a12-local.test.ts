/**
 * `tests/conformance/a12-local.test.ts` — the run the wave plan's Accept line actually names:
 * *"`pnpm vitest run tests` runs it against the `local` driver and reports, per scenario, `pass` /
 * `fail` / `unsupported-by-capability`."*
 *
 * `local`'s own real capabilities (`LOCAL_RUNTIME_CAPABILITIES`, `packages/runtime/src/local.ts`,
 * unmodified) decide every verdict below through `runA12ConformanceSuite` — nothing here overrides
 * or narrows them, and nothing here is a mock of the driver itself. Five scenarios need nothing
 * `local` cannot honestly claim (create/destroy, a turn's events, file hydration over the mounted
 * workspace, session resume on a fresh sandbox, interrupt) and are expected to `pass` for real.
 * Four need something `local`'s own capability record says it does not have — enforced network
 * policy (`networkPolicies: ['open']` only), an enforced session ceiling (`maxSessionSeconds:
 * null`), and any isolation boundary at all (`isolation: 'none'`) — and are expected to be
 * honestly declared `unsupported-by-capability`, never forced to a weaker `pass`. The tenth,
 * `no-host-claude-config-visible`, has no capability field a driver can decline it through
 * (§14.7 is a baseline obligation, per this task's own ADR) and `local` genuinely cannot meet it —
 * its own `LOCAL_RUNTIME_WARNINGS` already says sessions share the host filesystem with no
 * enforcement, and the scenario proves it by seeding its own marker at a host location it
 * designates and asking the driver to read it back (round 3's fix, ADR-0047).
 *
 * Round 2's version of this scenario asked about THIS machine's real `homedir()/.claude`, which
 * made the honest verdict a fact about the machine running the test — `pass` on a CI runner with
 * no `~/.claude` at all, `fail` everywhere else — and this file computed its expectation from
 * `existsSync` accordingly. Round 3 closes that gap (ADR-0047: a probe establishes its own
 * precondition, it never inherits one from the host): the marker exists because THIS scenario just
 * wrote it, so `local` — which shares the host filesystem with no isolation boundary at all — fails
 * this scenario for real on every machine, unconditionally, which is what `EXPECTED_VERDICTS` below
 * now asserts as a fixed constant rather than a machine-dependent guess.
 */
import { describe, expect, it } from 'vitest';

import { runA12ConformanceSuite } from './harness.js';
import {
  createLocalFixtureDriver,
  LOCAL_RUNTIME_CAPABILITIES,
  localFixtureProbe,
} from './fixtures/local-fixture.js';
import type { A12ScenarioId, A12Verdict } from './types.js';

const EXPECTED_VERDICTS: Record<A12ScenarioId, A12Verdict> = {
  'create-and-destroy': 'pass',
  'trivial-agent-turn': 'pass',
  'hydrate-and-collect-files': 'pass',
  'resume-after-sandbox-gone': 'pass',
  'enforce-network-none': 'unsupported-by-capability',
  'enforce-network-restricted': 'unsupported-by-capability',
  'enforce-resource-limits': 'unsupported-by-capability',
  'interrupt-running-agent': 'pass',
  'concurrent-sessions-file-isolation': 'unsupported-by-capability',
  'no-host-claude-config-visible': 'fail',
};

describe('A.12 against the real local driver', () => {
  it('reports the expected verdict for every scenario — pass, fail, or unsupported-by-capability, exactly as earned', async () => {
    const driver = createLocalFixtureDriver();
    const report = await runA12ConformanceSuite(
      driver,
      LOCAL_RUNTIME_CAPABILITIES,
      localFixtureProbe,
    );

    console.log(
      `A.12 vs local:\n${report.results
        .map((result) => `  ${result.verdict.padEnd(24)} ${result.id} — ${result.detail}`)
        .join('\n')}`,
    );

    expect(report.driverId).toBe('local');
    // `local` fails the one baseline, ungated scenario it cannot meet (no-host-claude-config-
    // visible) unconditionally now — round 3's fix (ADR-0047) seeds its own marker rather than
    // asking about this machine's real ~/.claude, so the verdict is a fixed fact about `local`
    // (isolation: 'none', no boundary at all), never a guess about what this host contains.
    expect(report.ok).toBe(false);
    expect(report.dishonestCapabilityClaims.map((result) => result.id)).toEqual([
      'no-host-claude-config-visible',
    ]);

    const actual = Object.fromEntries(report.results.map((result) => [result.id, result.verdict]));
    expect(actual).toEqual(EXPECTED_VERDICTS);

    // Every `unsupported-by-capability` verdict must name the capability field it is honest
    // about, not just assert the verdict — ADR-0016: a claim like this is checked, not narrated.
    const networkNone = report.results.find((result) => result.id === 'enforce-network-none');
    expect(networkNone?.detail).toMatch(/networkPolicies/);
    const isolation = report.results.find(
      (result) => result.id === 'concurrent-sessions-file-isolation',
    );
    expect(isolation?.detail).toMatch(/isolation/);
    const resourceLimits = report.results.find((result) => result.id === 'enforce-resource-limits');
    expect(resourceLimits?.detail).toMatch(/maxSessionSeconds/);

    // Named for what it is, and driven through a real read of a marker THIS scenario seeded —
    // never inferred from a value the probe fabricated, and never dependent on this host's real
    // ~/.claude (ADR-0046, ADR-0047).
    const hostConfig = report.results.find(
      (result) => result.id === 'no-host-claude-config-visible',
    );
    expect(hostConfig?.detail).toMatch(/readable from inside the sandbox/);
  }, 20_000);
});
