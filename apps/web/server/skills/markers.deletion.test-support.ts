import { expect, it } from 'vitest';
import { listAll, readWhole } from '@agent-workspace/core/storage/streams';
import { deleteSkill } from './delete';
import { skillDeleteMarkerKey } from './keys';
import { pendingSkillDelete } from './pending-delete';
import {
  getSkillWithId,
  importSkillWithId,
  listSkillsWithIds,
  publishSkillRevisionWithId,
} from './service';
import type { SkillRowsAccess } from './tree';
import type { SkillMarkerFixture } from './markers.harness.test-support';
import { skillMd, importBody } from './markers.fixture.test-support';
export function registerSkillMarkerDeletionTests(
  getFixture: () => Pick<SkillMarkerFixture, 'world'>,
) {
  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a skill delete interrupted half way is finished by its owner with no marker object', async () => {
    const testContext = getFixture();

    const { principal, catalog, shared, puts, storage, rows, skillRowPaths } =
      await testContext.world();
    let failRemove = false;
    const flaky: SkillRowsAccess = {
      ...rows,
      storage: {
        ...storage,
        remove: (ctx, area, path, options) =>
          failRemove ? Promise.reject(new Error('blip')) : storage.remove(ctx, area, path, options),
      },
    };
    expect(
      (await importSkillWithId(shared, catalog, principal, importBody('A'), rows)).status,
    ).toBe(201);
    const published = await publishSkillRevisionWithId(
      shared,
      catalog,
      principal,
      'dup',
      { files: importBody('A').files },
      rows,
    );
    expect(published.status).toBe(201);

    failRemove = true;
    await expect(deleteSkill(shared, catalog, 'dup', flaky)).rejects.toThrow('blip');

    const [left] = await catalog.listSkills();
    expect(left).toMatchObject({
      name: 'dup',
      pendingDelete: { ownerPrincipalId: principal.ownerPrincipalId, revisions: [1] },
    });
    expect(await listAll(shared, 'skill-deletes')).toEqual([]);
    expect(await skillRowPaths()).toContain('.skills/dup@1/SKILL.md');

    failRemove = false;
    expect(await deleteSkill(shared, catalog, 'dup', rows)).toEqual({ status: 204, body: null });
    expect(await catalog.listSkills()).toEqual([]);
    expect(await skillRowPaths()).toEqual([]);
    expect(legacyPuts(puts)).toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a delete that cannot finish hides the skill from list and get', async () => {
    const testContext1 = getFixture();

    const { principal, catalog, shared, storage, rows } = await testContext1.world();
    const flaky: SkillRowsAccess = {
      ...rows,
      storage: { ...storage, remove: () => Promise.reject(new Error('blip')) },
    };
    await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
    await expect(deleteSkill(shared, catalog, 'dup', flaky)).rejects.toThrow('blip');

    const listed = await listSkillsWithIds(shared, catalog, principal, rows);
    expect(listed.body).toEqual({ skills: [] });
    expect(await getSkillWithId(shared, catalog, principal, 'dup', rows)).toMatchObject({
      status: 404,
    });
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a delete refused as in use leaves the skill live and unmarked', async () => {
    const testContext2 = getFixture();

    const { principal, catalog, assign, shared, puts, rows } = await testContext2.world();
    await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
    await assign('dup');

    expect(await deleteSkill(shared, catalog, 'dup', rows)).toMatchObject({
      status: 409,
      body: { error: { code: 'skill_in_use' } },
    });

    expect((await catalog.listSkills())[0]).toMatchObject({ name: 'dup', pendingDelete: null });
    expect(legacyPuts(puts)).toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a delete recorded only by a legacy marker object is finished by its owner', async () => {
    const testContext3 = getFixture();

    const { principal, catalog, shared, rows, saveRow, skillRowPaths, putLegacy } =
      await testContext3.world();
    await saveRow('.skills/dup/SKILL.md', skillMd('A'));
    await saveRow('.skills/dup@1/SKILL.md', skillMd('A'));
    await putLegacy(skillDeleteMarkerKey('dup'), {
      ownerPrincipalId: principal.ownerPrincipalId,
      revisions: [1],
    });

    expect(await pendingSkillDelete(shared, catalog, 'dup')).toEqual({
      ownerPrincipalId: principal.ownerPrincipalId,
      revisions: [1],
    });
    expect(await deleteSkill(shared, catalog, 'dup', rows)).toEqual({ status: 204, body: null });

    expect(await skillRowPaths()).toEqual([]);
    expect(await readWhole(shared, skillDeleteMarkerKey('dup'))).toBeNull();
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a legacy delete marker on a live row is read and its column backfilled', async () => {
    const testContext4 = getFixture();

    const { principal, catalog, shared, rows, putLegacy } = await testContext4.world();
    await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
    const pending = { ownerPrincipalId: principal.ownerPrincipalId, revisions: [2, 5] };
    await putLegacy(skillDeleteMarkerKey('dup'), pending);

    expect(await pendingSkillDelete(shared, catalog, 'dup')).toEqual(pending);

    expect((await catalog.listSkills())[0]?.pendingDelete).toEqual(pending);
    expect(await readWhole(shared, skillDeleteMarkerKey('dup'))).not.toBeNull();
  });
}

import { legacyPuts } from './markers.fixture.test-support';
