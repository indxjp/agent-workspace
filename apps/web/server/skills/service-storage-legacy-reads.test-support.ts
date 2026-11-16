import { listCatalogFiles } from '@agent-workspace/core/db';
import { builtinSkillFiles } from '@agent-workspace/skills-office';
import { expect, it } from 'vitest';
import { ensureBuiltinSkills } from './builtin';
import { deleteSkill } from './delete';
import { seedBareSkill } from './rows-fixture';
import { getSkillWithId, importSkillWithId, publishSkillRevisionWithId } from './service';
import { importBody, skillMd } from './service-storage-fixture.test-support';
import { walkFiles, type SkillRowsAccess } from './tree';

import type { RowsWorldFactory } from './service-storage-fixture.test-support';
export function registerLegacyReadsTests(rowsWorld: RowsWorldFactory): void {
  // @story US-STO-08
  it('[US-STO-08][api][sdk] a delete interrupted after the row is marked resumes and removes the revision rows', async () => {
    let failRemove = false;
    const { principal, catalogs, shared, rows, rowTexts, storage } = await rowsWorld();
    const flaky: SkillRowsAccess = {
      ...rows,
      storage: {
        ...storage,
        remove: (ctx, area, path, options) =>
          failRemove ? Promise.reject(new Error('blip')) : storage.remove(ctx, area, path, options),
      },
    };
    const imported = await importSkillWithId(shared, catalogs[0], principal, importBody('A'), rows);
    expect(imported.status).toBe(201);
    const publish = () =>
      publishSkillRevisionWithId(
        shared,
        catalogs[0],
        principal,
        'dup',
        { files: importBody('A').files },
        rows,
      );
    await publish();
    await publish();

    failRemove = true;
    await expect(deleteSkill(shared, catalogs[0], 'dup', flaky)).rejects.toThrow('blip');
    expect(await catalogs[0].listSkills()).toMatchObject([
      { name: 'dup', pendingDelete: { revisions: [1, 2] } },
    ]);
    failRemove = false;
    expect(await deleteSkill(shared, catalogs[0], 'dup', rows)).toMatchObject({ status: 204 });

    expect((await listCatalogFiles(catalogs[0])).filter((row) => row.kind === 'file')).toEqual([]);

    const again = await importSkillWithId(shared, catalogs[0], principal, importBody('N'), rows);
    expect(again.status).toBe(201);
    expect((await publish()).status).toBe(201);
    expect(Object.keys(await rowTexts('.skills/dup@1')).sort()).toEqual([
      '.skills/dup@1/SKILL.md',
      '.skills/dup@1/scripts/run.sh',
    ]);
    expect(await rowTexts('.skills/dup@2')).toEqual({});
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a built-in install saves its files as rows', async () => {
    const { principal, catalogs, shared, rows, storage } = await rowsWorld();
    const name = 'office-reader';

    await ensureBuiltinSkills(shared, catalogs[0], principal, [name], rows);

    const listed = await storage.list(
      { workspaceId: principal.workspaceId },
      'skills',
      `.skills/${name}`,
    );
    expect(listed.rows.map((row) => row.path.slice(`.skills/${name}/`.length)).sort()).toEqual(
      builtinSkillFiles(name)
        .map((file) => file.path)
        .sort(),
    );
    expect(await walkFiles(shared, 'skills')).toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a skill in use keeps its catalog rows', async () => {
    const { principal, catalogs, assign, shared, rows, saveRow } = await rowsWorld();
    await seedBareSkill(shared, importBody('old'));
    await getSkillWithId(shared, catalogs[0], principal, 'dup');
    await saveRow('.skills/dup/SKILL.md', skillMd('rows'));
    await assign('dup');

    expect(await deleteSkill(shared, catalogs[0], 'dup', rows)).toMatchObject({
      status: 409,
      body: { error: { code: 'skill_in_use' } },
    });
    expect((await listCatalogFiles(catalogs[0])).map((row) => row.path)).toContain(
      '.skills/dup/SKILL.md',
    );
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] delete of a legacy skill still removes its prefix', async () => {
    const { principal, catalogs, shared, rows } = await rowsWorld();
    await seedBareSkill(shared, importBody('old'));
    await getSkillWithId(shared, catalogs[0], principal, 'dup');

    expect(await deleteSkill(shared, catalogs[0], 'dup', rows)).toMatchObject({ status: 204 });

    expect(await walkFiles(shared, 'skills')).toEqual([]);
    expect(await deleteSkill(shared, catalogs[0], 'dup', rows)).toMatchObject({ status: 404 });
  });
}
