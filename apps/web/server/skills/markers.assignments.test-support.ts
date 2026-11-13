import { expect, it } from 'vitest';
import { deleteSkill } from './delete';
import { skillDeleteMarkerKey } from './keys';
import { pendingSkillDelete } from './pending-delete';
import { importSkillWithId, listSkillsWithIds } from './service';
import type { SkillRowsAccess } from './tree';
import type { SkillMarkerFixture } from './markers.harness.test-support';
import { importBody } from './markers.fixture.test-support';
export function registerSkillMarkerAssignmentsTests(
  getFixture: () => Pick<SkillMarkerFixture, 'world'>,
) {
  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a skill whose delete is pending is refused to an assignment, and the delete still completes', async () => {
    const testContext = getFixture();

    const { principal, catalog, tryAssign, shared, storage, rows, skillRowPaths } =
      await testContext.world();
    const flaky: SkillRowsAccess = {
      ...rows,
      storage: { ...storage, remove: () => Promise.reject(new Error('blip')) },
    };
    await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
    await expect(deleteSkill(shared, catalog, 'dup', flaky)).rejects.toThrow('blip');
    expect((await catalog.listSkills())[0]?.pendingDelete).not.toBeNull();

    expect(await tryAssign('dup')).toBe(false);

    expect(await deleteSkill(shared, catalog, 'dup', rows)).toEqual({ status: 204, body: null });
    expect(await catalog.listSkills()).toEqual([]);
    expect(await skillRowPaths()).toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a skill assigned before the delete answers 409 and stays listed with its files', async () => {
    const testContext1 = getFixture();

    const { principal, catalog, tryAssign, shared, rows, skillRowPaths } =
      await testContext1.world();
    await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
    expect(await tryAssign('dup')).toBe(true);

    expect(await deleteSkill(shared, catalog, 'dup', rows)).toMatchObject({
      status: 409,
      body: { error: { code: 'skill_in_use' } },
    });

    const listed = await listSkillsWithIds(shared, catalog, principal, rows);
    expect((listed.body as { skills: { name: string }[] }).skills.map((s) => s.name)).toEqual([
      'dup',
    ]);
    expect(await skillRowPaths()).toContain('.skills/dup/scripts/run.sh');
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a delete refused as in use leaves an existing mark as it is', async () => {
    const testContext2 = getFixture();

    const { principal, catalog, assign, shared, storage, rows } = await testContext2.world();
    const flaky: SkillRowsAccess = {
      ...rows,
      storage: { ...storage, remove: () => Promise.reject(new Error('blip')) },
    };
    await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
    await expect(deleteSkill(shared, catalog, 'dup', flaky)).rejects.toThrow('blip');
    const marked = (await catalog.listSkills())[0]?.pendingDelete;
    expect(marked).not.toBeNull();
    await assign('dup');

    expect(await deleteSkill(shared, catalog, 'dup', rows)).toMatchObject({ status: 409 });

    expect((await catalog.listSkills())[0]?.pendingDelete).toEqual(marked);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a legacy delete marker beside a skill that is in use is not backfilled and hides nothing', async () => {
    const testContext3 = getFixture();

    const { principal, catalog, assign, shared, rows, putLegacy } = await testContext3.world();
    await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
    await assign('dup');
    await putLegacy(skillDeleteMarkerKey('dup'), {
      ownerPrincipalId: principal.ownerPrincipalId,
      revisions: [],
    });

    expect(await pendingSkillDelete(shared, catalog, 'dup')).toBeNull();
    const listed = await listSkillsWithIds(shared, catalog, principal, rows);

    expect((listed.body as { skills: { name: string }[] }).skills.map((s) => s.name)).toEqual([
      'dup',
    ]);
    expect((await catalog.listSkills())[0]?.pendingDelete).toBeNull();
  });
}
