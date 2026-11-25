import { expect, it } from 'vitest';
import { ensureBuiltinSkills } from './builtin';
import type { SkillMarkerFixture } from './markers.harness.test-support';
import { BUILTIN } from './markers.fixture.test-support';
export function registerSkillMarkerBuiltinsTests(
  getFixture: () => Pick<SkillMarkerFixture, 'world'>,
) {
  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a built-in install records its digest on the row and writes no marker object', async () => {
    const testContext1 = getFixture();

    const { principal, catalog, shared, puts, rows } = await testContext1.world();

    await ensureBuiltinSkills(shared, catalog, principal, [BUILTIN], rows);

    const [row] = await catalog.listSkills();
    expect(row?.builtinDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.pendingDelete).toBeNull();
    expect(legacyPuts(puts)).toEqual([]);
  });
}

import { legacyPuts } from './markers.fixture.test-support';
