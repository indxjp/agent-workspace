// The allowlist of hand-written catalog fakes is empty (#1745) and stays so: any hand-written fake
// in a tracked test file fails here (the storage design, §07 rule 4). A static check of the
// `policy-check` lane (`pnpm policy:check`); the scan's fixture cases are tests/catalog-fakes.test.ts.
import { describe, expect, it } from 'vitest';

import { trackedTextFiles } from '../scripts/ci/debt-review.mjs';
import { ALLOWLIST, allowlist, compare, findCatalogFakes } from './fitness/catalog-fakes-scan.js';

describe('catalog fakes are not hand-written', () => {
  // It parses every tracked test file: 5.5 s on a laptop, over Vitest's 5 s default on a loaded runner.
  it('every hand-written fake is on the allowlist, and the list only shrinks', () => {
    const files = trackedTextFiles().filter((file) => /\.test\.tsx?$/u.test(file.path));
    const { added, grown, stale, shrunk } = compare(findCatalogFakes(files), allowlist());
    const how =
      'hand-written catalog fake: use `createInMemoryCatalog()` from `@agent-workspace/core/db` ' +
      '(the storage design, §07); a throwing stub becomes `createInMemoryCatalog().failNext(op, error)`';
    expect([...added, ...grown], how).toEqual([]);
    expect(
      [...stale, ...shrunk],
      `fewer fakes than the allowlist records: lower or delete the entry in ${ALLOWLIST}`,
    ).toEqual([]);
  }, 60_000);
});
