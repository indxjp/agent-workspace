/**
 * Use case 10, the quality defect and past-trouble (過去トラ) analysis agent: the definition passes
 * the contract under a confidential policy ceiling, the QMS API answers like a quality system
 * should, the eight-d skill's script checks a draft, and the backend turns a run into an 8D draft
 * whose every Q-number, 4M count and recurrence flag it has checked.
 *
 * The QMS is an `openapiTool()`, so the project ships no MCP server: a gateway double
 * (`../harness/openapi-gateway.ts`, which lists what it assumes) plays the platform's tool gateway
 * against a loopback fake QMS (`./qms/fake-qms.mjs`). A Claude run names its tools
 * `mcp__qms__searchDefects` and so on; the backend matches them by the `__<operation>` suffix.
 */
import { describe } from 'vitest';
import { defineDefinitionCases } from './quality-defect.definition.test-support.ts';
import { defineQmsCases } from './quality-defect.qms.test-support.ts';
import { defineEightDCases } from './quality-defect.eight-d.test-support.ts';
import { defineBackendCases } from './quality-defect.backend.test-support.ts';
import { defineApprovalCases } from './quality-defect.approval.test-support.ts';
describe('quality defect and past-trouble analysis agent', () => {
  defineDefinitionCases();
  defineQmsCases();
  defineEightDCases();
  defineBackendCases();
  defineApprovalCases();
});
