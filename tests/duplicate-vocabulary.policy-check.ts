// Closed vocabularies owned by packages/contracts are not re-declared (F-12): every tracked source
// file is scanned and the re-declarations found must equal the allowlist, which can only shrink. A
// static check of the `policy-check` lane (`pnpm policy:check`); the rule's unit cases are
// tests/duplicate-vocabulary.test.ts.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { findRedeclarations } from './fitness/vocabulary-scan.js';
import {
  ALLOWLIST,
  compare,
  read,
  root,
  tracked,
  trackedContractVocabularies,
} from './fitness/vocabulary-tree.js';

describe('closed vocabularies owned by packages/contracts are not re-declared (F-12)', () => {
  const vocabularies = trackedContractVocabularies();

  it('has exactly the allowlisted re-declarations, so the list can only shrink', () => {
    const files = tracked('apps', 'packages', 'ui', 'scripts').filter(
      (file) =>
        /\.(?:ts|tsx|mts)$/u.test(file) &&
        !/\.(?:test|spec)\.tsx?$/u.test(file) &&
        !file.endsWith('.d.ts') &&
        !file.startsWith('packages/contracts/'),
    );
    const allowed = JSON.parse(readFileSync(root + ALLOWLIST, 'utf8')) as string[];
    const { added, stale } = compare(findRedeclarations(read(files), vocabularies), allowed);
    expect(added, `re-declared contracts vocabulary: import it from contracts instead`).toEqual([]);
    expect(stale, `stale entries: delete them from ${ALLOWLIST}`).toEqual([]);
    // A scan of every tracked source file, like the catalog-fake rule's: about 4 s alone.
  }, 60_000);
});
