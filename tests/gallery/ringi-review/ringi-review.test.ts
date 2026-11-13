/**
 * Use case 4, the ringi review agent: the definition passes the contract and can comment but not
 * decide, the rules and past ringi are found with the built-in `search_files` (narrowed per filer by
 * the backend's `fileScope`), the authority server applies the matrix deterministically, the
 * backend starts one typed review per ringi revision for the filer and re-checks it (決裁区分,
 * missing fields, citations), and a second run posts exactly that checked comment through an
 * `openapiTool` call, which pauses the run until a person approves it. The workflow system verifies
 * who is asking (ADR-0142) and refuses a comment on another department's ringi. See `../README.md`
 * for the three tiers and what each proves.
 */
import { describe } from 'vitest';

import { defineDefinitionCases } from './ringi-review.definition.test-support.ts';
import { definePostingCases } from './ringi-review.posting.test-support.ts';
import { defineReviewCases } from './ringi-review.review.test-support.ts';
import { defineScopeCases } from './ringi-review.scope.test-support.ts';
import { defineTriggerCases } from './ringi-review.trigger.test-support.ts';

describe('ringi review agent', () => {
  defineDefinitionCases();
  defineScopeCases();
  defineReviewCases();
  definePostingCases();
  defineTriggerCases();
});
