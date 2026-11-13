import { expect, it } from 'vitest';
import { seedBareSkill } from './rows-fixture';
import { importSkillWithId, publishSkillRevisionWithId } from './service';
import {
  gatedFirstWrite,
  importBody,
  runSh,
  skillMd,
} from './service-storage-fixture.test-support';

import type { RowsWorldFactory } from './service-storage-fixture.test-support';
export function registerPublishingTests(rowsWorld: RowsWorldFactory): void {
  // @story US-STO-08
  it('[US-STO-08][api][sdk] two concurrent publishes of one skill get numbers 1 and 2 and each revision holds exactly its own files', async () => {
    const { principal, catalogs, shared, objects, rows, rowTexts, onServer } = await rowsWorld();
    expect(
      (await importSkillWithId(shared, catalogs[0], principal, importBody('v0'), rows)).status,
    ).toBe(201);
    const gate = gatedFirstWrite();

    const first = publishSkillRevisionWithId(
      shared,
      catalogs[0],
      principal,
      'dup',
      { files: importBody('A').files },
      onServer(0, gate.wrap(objects)),
    );
    await gate.entered;
    const second = publishSkillRevisionWithId(
      shared,
      catalogs[1],
      principal,
      'dup',
      { files: importBody('B').files },
      onServer(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    gate.release();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status)).toEqual([201, 201]);
    expect(
      results.map((result) => (result.body as { revision: { number: number } }).revision.number),
    ).toEqual([1, 2]);
    for (const [number, who] of [
      [1, 'A'],
      [2, 'B'],
    ] as const) {
      const folder = `.skills/dup@${String(number)}`;
      expect(await rowTexts(folder)).toEqual({
        [`${folder}/SKILL.md`]: skillMd(who),
        [`${folder}/scripts/run.sh`]: runSh(who),
      });
    }
    expect((await rowTexts('.skills/dup'))['.skills/dup/SKILL.md']).toBe(skillMd('B'));
    expect((await catalogs[0].listSkills()).map((row) => row.skillMd)).toEqual([skillMd('B')]);
  }, 30_000);

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a publish the files refuse records no revision', async () => {
    const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld();
    await catalogs[0].createSkill({
      name: 'dup',
      skillMd: skillMd('reserved'),
      enabled: true,
      ownerPrincipalId: principal.ownerPrincipalId,
      createdBy: principal.userId,
    });

    const result = await publishSkillRevisionWithId(
      shared,
      catalogs[1],
      principal,
      'dup',
      { files: importBody('A').files },
      rows,
    );

    expect(result).toMatchObject({ status: 404, body: { error: { code: 'skill_not_found' } } });
    await expect(catalogs[0].listSkillRevisions('dup')).resolves.toEqual([]);
    expect(await rowTexts('.skills/dup@1')).toEqual({});
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] publishing a skill with no catalog row still works', async () => {
    const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld();
    await seedBareSkill(shared, importBody('old'));

    const result = await publishSkillRevisionWithId(
      shared,
      catalogs[0],
      principal,
      'dup',
      { files: importBody('A').files },
      rows,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect((await catalogs[1].listSkills()).map((row) => row.skillMd)).toEqual([skillMd('A')]);
    expect((await rowTexts('.skills/dup@1'))['.skills/dup@1/SKILL.md']).toBe(skillMd('A'));
  });
}
