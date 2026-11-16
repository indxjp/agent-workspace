/**
 * Use case 9, the skill-transfer and maintenance troubleshooting agent: the definition passes the
 * contract, the built-in `search_files` finds the plant's past troubles, notes and manuals inside
 * the folders each technician may see (`runs.start({ fileScope })`), the maintenance system's
 * `logResolution` (an `openapiTool`) writes a resolved case back only for an approved call, and the
 * tablet's backend drives
 * a multi-turn diagnosis whose every turn it checks (safety first, one cited step at a time, a
 * resolution only when it was logged, escalation to the expert).
 */
import { describe } from 'vitest';
import { defineDefinitionCases } from './maintenance-troubleshooting.definition.test-support.ts';
import {
  defineToolCases,
  defineAccessCases,
} from './maintenance-troubleshooting.tools.test-support.ts';
import { defineSessionCases } from './maintenance-troubleshooting.session.test-support.ts';
import { defineCheckCases } from './maintenance-troubleshooting.checks.test-support.ts';
describe('maintenance troubleshooting agent', () => {
  defineDefinitionCases();
  defineToolCases();
  defineSessionCases();
  defineCheckCases();
  defineAccessCases();
});
