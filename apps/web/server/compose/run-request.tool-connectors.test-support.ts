import { registerEngineCompatibilityCases } from './run-request.tool-connectors-engine-compatibility.test-support';
import { registerProtocolCases } from './run-request.tool-connectors-protocol.test-support';
import { registerSnapshotCases } from './run-request.tool-connectors-snapshot.test-support';
import { createToolConnectorsFixture } from './run-request.tool-connectors.fixture.test-support';

import { describe } from 'vitest';

export function registerToolConnectorsTests() {
  describe('buildRunRequestFor — tool connectors through the gateway (S2-02f, #531)', () => {
    const fixture = createToolConnectorsFixture();
    registerProtocolCases(fixture);
    registerSnapshotCases(fixture);
    registerEngineCompatibilityCases(fixture);
  });
}
