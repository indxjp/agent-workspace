import { describe } from 'vitest';

import {
  registerDeliveryClaimCases,
  registerDeliveryConstraintCases,
  registerDeliveryWindowCases,
} from './triggers.deliveries.test-support.js';
import { createTriggerFixture } from './triggers.fixture.test-support.js';
import {
  registerDeliveryLimitCases,
  registerIngressLookupCases,
} from './triggers.ingress.test-support.js';
import {
  registerTriggerFieldCases,
  registerTriggerIntegrityCases,
  registerTriggerUpdateCases,
} from './triggers.shape.test-support.js';
import {
  registerTenantScopingCases,
  registerWebhookSecretCases,
} from './triggers.tenancy.test-support.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('TriggerRepository (ADR-0144)', () => {
  const fixture = createTriggerFixture();

  describe('delivery dedupe', () => {
    registerDeliveryClaimCases(fixture);
    registerDeliveryConstraintCases(fixture);
    registerDeliveryWindowCases(fixture);
  });

  describe('tenant scoping', () => {
    registerTenantScopingCases(fixture);
  });

  describe('webhook secret', () => {
    registerWebhookSecretCases(fixture);
  });

  describe('ingress lookup and limits', () => {
    registerIngressLookupCases(fixture);
    registerDeliveryLimitCases(fixture);
  });

  describe('shape', () => {
    registerTriggerFieldCases(fixture);
    registerTriggerUpdateCases(fixture);
    registerTriggerIntegrityCases(fixture);
  });
});
