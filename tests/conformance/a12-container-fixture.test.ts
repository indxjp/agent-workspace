/**
 * `tests/conformance/a12-container-fixture.test.ts` — the positive counterpart to
 * `a12-honesty.test.ts`: proves `runA12ConformanceSuite` can report a full, honest `pass` on
 * every one of the ten scenarios when a driver's capabilities and its actual behaviour agree,
 * including the four `local` cannot claim (enforced network policy, enforced resource limits, and
 * real cross-session file isolation). ADR-0029: a gate this task writes must be watched failing on
 * a tree it ought to reject (`a12-honesty.test.ts`) *and* passing on one it ought to accept — this
 * file is the second half.
 *
 * See `fixtures/container-fixture.ts`'s header for why this is a fixture and not a claim about
 * the real `docker` driver, which does not exist yet (the Wave 3 plan's 3b-1 row,
 * W3-RT-03, sequenced after this task).
 */
import { describe, expect, it } from 'vitest';

import { runA12ConformanceSuite } from './harness.js';
import {
  CONTAINER_FIXTURE_CAPABILITIES,
  containerFixtureProbe,
  createContainerFixtureDriver,
} from './fixtures/container-fixture.js';

describe('A.12 against a fixture driver that actually enforces what it claims', () => {
  it('reports pass on all ten scenarios, with no unsupported and no failure', async () => {
    const driver = createContainerFixtureDriver();
    const report = await runA12ConformanceSuite(
      driver,
      CONTAINER_FIXTURE_CAPABILITIES,
      containerFixtureProbe,
    );

    console.log(
      `A.12 vs the enforcing container fixture:\n${report.results
        .map((result) => `  ${result.verdict.padEnd(24)} ${result.id} — ${result.detail}`)
        .join('\n')}`,
    );

    expect(report.ok).toBe(true);
    expect(report.dishonestCapabilityClaims).toEqual([]);
    expect(report.results.map((result) => result.verdict)).toEqual(
      report.results.map(() => 'pass'),
    );
    expect(report.results).toHaveLength(10);
  }, 20_000);
});
