/**
 * Use case 1, the manual search agent: the definition passes the contract, the platform's
 * `search_files` finds the clause inside the scope the portal's backend gives each run, and the
 * backend turns a run into a cited answer it has checked. See `../README.md` for the three tiers
 * and what each proves.
 */
import { describe } from 'vitest';

import { defineBackendCases } from './manual-search.backend.test-support.ts';
import { definePdfCases } from './manual-search.pdf.test-support.ts';

describe('manual search agent', () => {
  definePdfCases();
  defineBackendCases();
});
