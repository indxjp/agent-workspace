import { describe } from 'vitest';

import { createRunUsageFixture } from './run-usage.fixture.test-support.js';
import { registerPublicShareCases } from './run-usage.public-share.test-support.js';
import { registerReportingCases } from './run-usage.reporting.test-support.js';
import {
  registerLateSettlementCases,
  registerSettlementCases,
} from './run-usage.settlement.test-support.js';
import { registerWireProtocolCases } from './run-usage.wire-protocol.test-support.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

// One suite, registered in this order: the reporting cases run last because they read the
// accounting state the earlier cases leave behind.
describe.skipIf(!hasDatabase)('RunRepository usage settlement', () => {
  const fixture = createRunUsageFixture();
  registerSettlementCases(fixture);
  registerPublicShareCases(fixture);
  registerLateSettlementCases(fixture);
  registerWireProtocolCases(fixture);
  registerReportingCases(fixture);
});
