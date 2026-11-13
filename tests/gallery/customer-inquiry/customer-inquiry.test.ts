import { describe } from 'vitest';
import { defineDefinitionCases } from './customer-inquiry.definition.test-support.ts';
import { defineCrmCases } from './customer-inquiry.crm.test-support.ts';
import { defineBackendCases } from './customer-inquiry.backend.test-support.ts';
describe('customer inquiry agent', () => {
  defineDefinitionCases();
  defineCrmCases();
  defineBackendCases();
});
