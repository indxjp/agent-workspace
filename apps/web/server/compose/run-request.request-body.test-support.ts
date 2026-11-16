import { registerContractCases } from './run-request.request-body-contract.test-support';
import { registerEnginePolicyCases } from './run-request.request-body-engine-policy.test-support';
import { registerGatewayTokenCases } from './run-request.request-body-gateway-token.test-support';
import { registerProjectPolicyCases } from './run-request.request-body-project-policy.test-support';
import { registerResourcesCases } from './run-request.request-body-resources.test-support';
import { createRequestBodyFixture } from './run-request.request-body.fixture.test-support';

import { describe } from 'vitest';

export function registerRequestBodyTests() {
  describe('buildRunRequestFor', () => {
    const fixture = createRequestBodyFixture();
    registerContractCases();
    registerResourcesCases();
    registerProjectPolicyCases(fixture);
    registerEnginePolicyCases();
    registerGatewayTokenCases();
  });
}
