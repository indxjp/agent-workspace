import { listCatalogFiles } from '@agent-workspace/core/db';
import { expect, it } from 'vitest';
import { deleteSkill } from './delete';
import { exportSkill, getSkill } from './handlers';
import { seedBareSkill } from './rows-fixture';
import { getSkillWithId, importSkillWithId, publishSkillRevisionWithId } from './service';
import { importBody, runSh, skillMd } from './service-storage-fixture.test-support';
import { walkFiles } from './tree';

import type { RowsWorldFactory } from './service-storage-fixture.test-support';
export function registerStorageReadsTests(rowsWorld: RowsWorldFactory): void {
  // @story US-STO-08
  it('[US-STO-08][api][sdk] skill import saves through the service', async () => {
    const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld();

    const imported = await importSkillWithId(shared, catalogs[0], principal, importBody('A'), rows);

    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    expect(await rowTexts('.skills/dup')).toEqual({
      '.skills/dup/SKILL.md': skillMd('A'),
      '.skills/dup/scripts/run.sh': runSh('A'),
    });
    expect(await walkFiles(shared, 'skills')).toEqual([]);
    const got = await getSkillWithId(shared, catalogs[0], principal, 'dup', rows);
    expect(got).toMatchObject({
      status: 200,
      body: { skill: { source: skillMd('A'), fileCount: 2 } },
    });
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] GET /api/skills/:name reads a skill stored as rows (sizes, source, export)', async () => {
    const { principal, catalogs, shared, rows, saveRow } = await rowsWorld();
    await seedBareSkill(shared, importBody('old'));
    await saveRow('.skills/dup/SKILL.md', skillMd('rows'));
    await saveRow('.skills/dup/scripts/run.sh', runSh('rows'));
    await saveRow('.skills/dup/references/more.md', 'more');

    const got = await getSkillWithId(shared, catalogs[0], principal, 'dup', rows);
    expect(got).toMatchObject({
      status: 200,
      body: {
        skill: {
          source: skillMd('rows'),
          fileCount: 3,
          files: [
            { path: 'SKILL.md', sizeBytes: skillMd('rows').length },
            { path: 'references/more.md', sizeBytes: 4 },
            { path: 'scripts/run.sh', sizeBytes: runSh('rows').length },
          ],
        },
      },
    });
    const exported = await exportSkill(shared, 'dup', rows);
    expect(exported).toMatchObject({ status: 200 });
    const paths = (exported.body as { skill: { files: { path: string }[] } }).skill.files.map(
      (f) => f.path,
    );
    expect(paths).toEqual(['SKILL.md', 'references/more.md', 'scripts/run.sh']);
    // Without the service the same skill still reads from its prefix.
    expect(await getSkill(shared, 'dup')).toMatchObject({
      body: { skill: { source: skillMd('old'), fileCount: 2 } },
    });
  });

  // @story US-STO-08
  it("[US-STO-08][api][sdk] delete removes a skill's rows, its revision rows and their objects", async () => {
    const { principal, catalogs, shared, objects, rows, saveRow } = await rowsWorld();
    await seedBareSkill(shared, importBody('old'));
    await getSkillWithId(shared, catalogs[0], principal, 'dup');
    expect(
      (
        await publishSkillRevisionWithId(
          shared,
          catalogs[0],
          principal,
          'dup',
          {
            files: importBody('old').files,
          },
          rows,
        )
      ).status,
    ).toBe(201);
    await saveRow('.skills/dup/SKILL.md', skillMd('rows'));
    await saveRow('.skills/dup@1/SKILL.md', skillMd('rev'));
    await saveRow('.skills/dup-two/SKILL.md', skillMd('other'));

    expect(await deleteSkill(shared, catalogs[0], 'dup', rows)).toEqual({
      status: 204,
      body: null,
    });

    const left = (await listCatalogFiles(catalogs[0])).filter((row) => row.kind === 'file');
    expect(left.map((row) => row.path)).toEqual(['.skills/dup-two/SKILL.md']);
    expect(await walkFiles(shared, 'skills')).toEqual([]);
    expect((await objects.listPage('', { recursive: true })).entries).toHaveLength(1);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] delete removes the rows of a pending revision too', async () => {
    const { principal, catalogs, shared, rows, saveRow } = await rowsWorld();
    await seedBareSkill(shared, importBody('old'));
    await getSkillWithId(shared, catalogs[0], principal, 'dup');
    let started!: () => void;
    const writing = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    // A publish that has written its rows but not completed, as a crashed one leaves them.
    const stuck = catalogs[0].publishSkillRevision('dup', {
      fileCount: 1,
      write: async (number) => {
        await saveRow(`.skills/dup@${String(number)}/SKILL.md`, skillMd('pending'));
        started();
        await released;
        return undefined;
      },
    });
    await writing;

    expect(await deleteSkill(shared, catalogs[0], 'dup', rows)).toEqual({
      status: 204,
      body: null,
    });
    release();
    await expect(stuck).resolves.toBeNull();

    const left = (await listCatalogFiles(catalogs[0])).filter((row) => row.kind === 'file');
    expect(left).toEqual([]);
  });
}
