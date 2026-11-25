import { listCatalogFiles } from '@agent-workspace/core/db';
import { listAll } from '@agent-workspace/core/storage/streams';
import { builtinSkillFiles } from '@agent-workspace/skills-office';
import { expect, it } from 'vitest';
import { ensureBuiltinSkills } from './builtin';
import { deleteSkill } from './delete';
import { importSkillWithId, publishSkillRevisionWithId } from './service';
import { importBody } from './service-storage-fixture.test-support';
import type { SkillRowsAccess } from './tree';

import type { RowsWorldFactory } from './service-storage-fixture.test-support';
export function registerDeleteRowsTests(rowsWorld: RowsWorldFactory): void {
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
    expect(await listAll(shared, 'skills')).toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a skill in use keeps its catalog rows', async () => {
    const { principal, catalogs, assign, shared, rows } = await rowsWorld();
    await importSkillWithId(shared, catalogs[0], principal, importBody('old'), rows);
    await assign('dup');

    expect(await deleteSkill(shared, catalogs[0], 'dup', rows)).toMatchObject({
      status: 409,
      body: { error: { code: 'skill_in_use' } },
    });
    expect((await listCatalogFiles(catalogs[0])).map((row) => row.path)).toContain(
      '.skills/dup/SKILL.md',
    );
  });
}
