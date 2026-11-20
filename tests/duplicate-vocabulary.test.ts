// The duplicate-vocabulary rule (F-12) on planted fixtures, against the real contracts tuples. Its
// run over every tracked source file, against the allowlist, is
// tests/duplicate-vocabulary.policy-check.ts (`pnpm policy:check`).
import { describe, expect, it } from 'vitest';

import { findRedeclarations } from './fitness/vocabulary-scan.js';
import { compare, trackedContractVocabularies } from './fitness/vocabulary-tree.js';

describe('closed vocabularies owned by packages/contracts are not re-declared (F-12)', () => {
  const vocabularies = trackedContractVocabularies();

  it('finds the contracts tuples this rule is about', () => {
    for (const name of [
      'RUN_STATUSES',
      'TERMINAL_RUN_STATUSES',
      'SESSION_STATUSES',
      'MEMBERSHIP_ROLES',
      'EVALUATION_RUN_STATUSES',
    ]) {
      expect(vocabularies.has(name), name).toBe(true);
    }
  });

  it('flags a planted literal array and a planted union, and ignores subsets', () => {
    const planted = new Map([
      ['a.ts', "const X = ['owner', 'viewer', 'admin', 'builder', 'guest'] as const;"],
      ['b.ts', "type S = 'archived' | 'active';"],
      ['c.ts', "const Y = ['completed', 'failed'];"],
    ]);
    expect(findRedeclarations(planted, vocabularies)).toEqual([
      'a.ts::MEMBERSHIP_ROLES',
      'b.ts::SESSION_STATUSES',
    ]);
  });

  it('fails on a new re-declaration and on a stale allowlist entry', () => {
    expect(compare(['a.ts::RUN_STATUSES'], [])).toEqual({
      added: ['a.ts::RUN_STATUSES'],
      stale: [],
    });
    expect(compare([], ['a.ts::RUN_STATUSES'])).toEqual({
      added: [],
      stale: ['a.ts::RUN_STATUSES'],
    });
  });
});
