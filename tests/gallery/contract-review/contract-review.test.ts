import { describe } from 'vitest';
import { defineDefinitionCases } from './contract-review.definition.test-support.ts';
import { definePlaybookCases } from './contract-review.playbook.test-support.ts';
import { defineAccessCases } from './contract-review.access.test-support.ts';
import { defineApprovalCases } from './contract-review.approval.test-support.ts';
describe('contract review agent', () => {
  defineDefinitionCases();
  definePlaybookCases();
  defineAccessCases();
  defineApprovalCases();
});
