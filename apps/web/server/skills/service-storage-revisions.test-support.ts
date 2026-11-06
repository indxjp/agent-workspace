import { expect, it } from 'vitest';
import { importSkillWithId, patchSkillWithId, publishSkillRevisionWithId } from './service';
import { b64, importBody, runSh, skillMd } from './service-storage-fixture.test-support';
import { walkFiles } from './tree';

import type { RowsWorldFactory } from './service-storage-fixture.test-support';
export function registerRevisionRowsTests(rowsWorld: RowsWorldFactory): void {
  // @story US-STO-08
  it('[US-STO-08][api][sdk] a published revision is frozen as rows', async () => {
    const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld();
    const imported = await importSkillWithId(shared, catalogs[0], principal, importBody('A'), rows);
    expect(imported.status).toBe(201);
    const publish = (who: string) =>
      publishSkillRevisionWithId(
        shared,
        catalogs[0],
        principal,
        'dup',
        { files: importBody(who).files },
        rows,
      );

    expect((await publish('A')).status).toBe(201);
    const first = await rowTexts('.skills/dup@1');
    expect(first).toEqual({
      '.skills/dup@1/SKILL.md': skillMd('A'),
      '.skills/dup@1/scripts/run.sh': runSh('A'),
    });
    await patchSkillWithId(
      shared,
      catalogs[0],
      principal,
      'dup',
      { files: [{ path: 'SKILL.md', contentBase64: b64(skillMd('P')) }] },
      rows,
    );
    expect((await publish('C')).status).toBe(201);

    expect(await rowTexts('.skills/dup@1')).toEqual(first);
    expect(await rowTexts('.skills/dup@2')).toEqual({
      '.skills/dup@2/SKILL.md': skillMd('C'),
      '.skills/dup@2/scripts/run.sh': runSh('C'),
    });
    expect(await walkFiles(shared, 'skills')).toEqual([]);
    expect(await walkFiles(shared, 'skill-revisions')).toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a publish clears the leftover rows of a crashed publish', async () => {
    const { principal, catalogs, shared, rows, rowTexts, saveRow } = await rowsWorld();
    const imported = await importSkillWithId(shared, catalogs[0], principal, importBody('A'), rows);
    expect(imported.status).toBe(201);
    await saveRow('.skills/dup@1/stale.md', 'stale');

    const published = await publishSkillRevisionWithId(
      shared,
      catalogs[0],
      principal,
      'dup',
      { files: importBody('B').files },
      rows,
    );

    expect(published.status).toBe(201);
    expect(Object.keys(await rowTexts('.skills/dup@1')).sort()).toEqual([
      '.skills/dup@1/SKILL.md',
      '.skills/dup@1/scripts/run.sh',
    ]);
  });
}
