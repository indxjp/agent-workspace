/**
 * A direct unit test of {@link isWorkspaceUsableForRuns}, the predicate
 * `apps/web/server/composition/register.ts`'s `findAgent`/`openSession` closures use to refuse a
 * new run or session in an archived workspace (issue #119).
 *
 * This file lives here, not next to `register.ts`, because this task's `Owns` cell names
 * `apps/web/server/composition/register.ts` as an exact filename with no test wildcard
 * (`docs/adr/W9-PLAN-the-composition-root-moved-after-the-plan-was-written.md`), so a
 * `register.test.ts` is a file this task cannot create. `apps/web/server/workspaces/**` is a
 * wildcard cell this task does own, and the predicate is exported for exactly this reason —
 * see its own doc comment in `register.ts`.
 */
import { describe, expect, it } from 'vitest';

import { isWorkspaceUsableForRuns } from '../composition/register';

describe('isWorkspaceUsableForRuns', () => {
  it('is usable when active (archivedAt is null)', () => {
    expect(isWorkspaceUsableForRuns({ archivedAt: null })).toBe(true);
  });

  it('is NOT usable once archived', () => {
    expect(isWorkspaceUsableForRuns({ archivedAt: new Date() })).toBe(false);
  });

  it('is NOT usable when the workspace row itself is gone', () => {
    expect(isWorkspaceUsableForRuns(null)).toBe(false);
  });
});
