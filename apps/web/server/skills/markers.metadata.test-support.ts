import { expect, it } from 'vitest';
import { listAll } from '@agent-workspace/core/storage/streams';
import { importSkillWithId } from './service';
import type { SkillMarkerFixture } from './markers.harness.test-support';
import { importBody } from './markers.fixture.test-support';
export function registerSkillMarkerMetadataTests(
  getFixture: () => Pick<SkillMarkerFixture, 'world'>,
) {
  // @story US-STO-08
  it('[US-STO-08][unit][sdk] an import records the skill on its row and writes no skill-meta object', async () => {
    const testContext = getFixture();

    const { principal, catalog, shared, puts, rows } = await testContext.world();

    const imported = await importSkillWithId(shared, catalog, principal, importBody('A'), rows);

    expect(imported.status).toBe(201);
    expect((await catalog.listSkills())[0]?.meta).toMatchObject({ name: 'dup', enabled: true });
    expect(await listAll(shared, 'skill-meta')).toEqual([]);
    expect(legacyPuts(puts)).toEqual([]);
  });
}

import { legacyPuts } from './markers.fixture.test-support';
