import { registerCompatibilityCases } from './run-request.policy-ceiling-compatibility.test-support';
import { registerConnectorsCases } from './run-request.policy-ceiling-connectors.test-support';
import { registerLimitsCases } from './run-request.policy-ceiling-limits.test-support';
import { registerPreflightCases } from './run-request.policy-ceiling-preflight.test-support';
import { createPolicyCeilingFixture } from './run-request.policy-ceiling.fixture.test-support';

import { describe } from 'vitest';

export function registerPolicyCeilingTests() {
  describe('buildRunRequestFor meets the policy ceiling (S2-04c)', () => {
    const fixture = createPolicyCeilingFixture();
    registerLimitsCases(fixture);
    registerPreflightCases(fixture);
    registerConnectorsCases(fixture);
    registerCompatibilityCases(fixture);
  });
}
