import { describe } from 'vitest';

import { registerClientLifecycleCases } from './endpoint-clients.crud.test-support.js';
import { createEndpointClientFixture } from './endpoint-clients.fixture.test-support.js';
import { registerBoundKeyCases } from './endpoint-clients.keys.test-support.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('EndpointClientRepository (ADR-0134)', () => {
  const fixture = createEndpointClientFixture();
  registerClientLifecycleCases(fixture);
  describe('bound keys', () => registerBoundKeyCases(fixture));
});
