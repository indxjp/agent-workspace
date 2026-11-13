import { describe } from 'vitest';
import { defineDefinitionCases } from './quotation.definition.test-support.ts';
import { defineCostModelCases } from './quotation.cost-model.test-support.ts';
import { defineBackendCases } from './quotation.backend.test-support.ts';
describe('quotation agent', () => {
  defineDefinitionCases();
  defineCostModelCases();
  defineBackendCases();
});
