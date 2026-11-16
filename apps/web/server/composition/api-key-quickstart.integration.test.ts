const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
import { describe } from 'vitest';

import { createApiKeyQuickstartFixture } from './api-key-quickstart.fixture.test-support';
import { registerApiKeyQuickstartQuickstartTests } from './api-key-quickstart.quickstart.test-support';
import { registerApiKeyQuickstartAuthorizationTests } from './api-key-quickstart.authorization.test-support';
import { registerApiKeyQuickstartKeyLifecycleTests } from './api-key-quickstart.keylifecycle.test-support';
import { registerApiKeyQuickstartPreflightTests } from './api-key-quickstart.preflight.test-support';
describe.skipIf(!hasDatabase)('the SDK quickstart with an API key (issue #388)', () => {
  const fixture = createApiKeyQuickstartFixture(process.env);
  registerApiKeyQuickstartQuickstartTests(() => fixture);
  registerApiKeyQuickstartAuthorizationTests(() => fixture);
  registerApiKeyQuickstartKeyLifecycleTests(() => fixture);
  registerApiKeyQuickstartPreflightTests(() => fixture);
});
