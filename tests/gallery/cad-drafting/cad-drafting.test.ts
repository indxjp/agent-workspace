/**
 * Use case 2, the CAD drawing agent: the definition passes the contract, the platform's
 * `search_files` finds similar past drawings inside the designer's `fileScope`, the dxf-draft skill
 * writes a draft whose geometry is exactly the request, and the design desk's backend refuses a
 * draft that invents a dimension or loses a hole.
 */
import { describe } from 'vitest';
import {
  defineDefinitionCases,
  defineSearchCases,
} from './cad-drafting.definition.test-support.ts';
import { defineSkillScriptCases } from './cad-drafting.skill-script.test-support.ts';
import { defineBackendCases } from './cad-drafting.backend.test-support.ts';

describe('CAD drawing agent', () => {
  defineDefinitionCases();
  defineSkillScriptCases();
  defineSearchCases();
  defineBackendCases();
});
