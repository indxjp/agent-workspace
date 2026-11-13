import { expect, it } from 'vitest';
import { listAll, readWhole } from '@agent-workspace/core/storage/streams';
import { skillMetaKey } from './keys';
import { getSkillWithId, importSkillWithId } from './service';
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

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a skill that only has its legacy skill-meta object is read and its column backfilled', async () => {
    const testContext1 = getFixture();

    const { principal, catalog, shared, puts, rows, putLegacy } = await testContext1.world();
    await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
    const legacy = {
      name: 'dup',
      enabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    await catalog.setSkillMeta('dup', null);
    await putLegacy(skillMetaKey('dup'), legacy);
    puts.length = 0;

    const read = await getSkillWithId(shared, catalog, principal, 'dup', rows);

    expect(read.status).toBe(200);
    expect((read.body as { skill: { enabled: boolean } }).skill.enabled).toBe(false);
    expect((await catalog.listSkills())[0]?.meta).toEqual(legacy);
    expect(await readWhole(shared, skillMetaKey('dup'))).not.toBeNull();
    expect(puts).toEqual([]);
  });
}

import { legacyPuts } from './markers.fixture.test-support';
