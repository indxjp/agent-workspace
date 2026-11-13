const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
import { describe } from 'vitest';

import { createTokenExchangeFixture } from './token-exchange.fixture.test-support';
import { registerTokenExchangeAuditsTests } from './token-exchange.audits.test-support';
import { registerTokenExchangeActingPersonTests } from './token-exchange.actingperson.test-support';
import { registerTokenExchangeAccessTests } from './token-exchange.access.test-support';
import { registerTokenExchangeLifetimeTests } from './token-exchange.lifetime.test-support';
describe.skipIf(!hasDatabase)('a sample app backend acting as a person (ADR-0161)', () => {
  const fixture = createTokenExchangeFixture(process.env);
  registerTokenExchangeAuditsTests(() => fixture);
  registerTokenExchangeActingPersonTests(() => fixture);
  registerTokenExchangeAccessTests(() => fixture);
  registerTokenExchangeLifetimeTests(() => fixture);
});
