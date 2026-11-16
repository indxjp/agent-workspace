import { expect, it } from 'vitest';
import { seedBareSkill } from './rows-fixture';
import { getSkillWithId, patchSkillWithId, publishSkillRevisionWithId } from './service';
import {
  addFile,
  b64,
  importBody,
  legacyBody,
  runSh,
  skillMd,
} from './service-storage-fixture.test-support';
import { walkFiles } from './tree';

import type { RowsWorldFactory } from './service-storage-fixture.test-support';
export function registerLegacyMovesTests(rowsWorld: RowsWorldFactory): void {
  // @story US-STO-08
  it('[US-STO-08][api][sdk] patching or publishing a legacy skill moves it into rows', async () => {
    const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld();
    await seedBareSkill(shared, importBody('old'));
    await getSkillWithId(shared, catalogs[0], principal, 'dup');

    const patched = await patchSkillWithId(
      shared,
      catalogs[0],
      principal,
      'dup',
      { files: [{ path: 'references/more.md', contentBase64: b64('more') }] },
      rows,
    );

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(await rowTexts('.skills/dup')).toEqual({
      '.skills/dup/SKILL.md': skillMd('old'),
      '.skills/dup/references/more.md': 'more',
      '.skills/dup/scripts/run.sh': runSh('old'),
    });
    expect(await getSkillWithId(shared, catalogs[0], principal, 'dup', rows)).toMatchObject({
      body: { skill: { fileCount: 3 } },
    });

    await seedBareSkill(shared, { ...importBody('x'), name: 'other' });
    await getSkillWithId(shared, catalogs[0], principal, 'other');
    const published = await publishSkillRevisionWithId(
      shared,
      catalogs[0],
      principal,
      'other',
      { files: [{ path: 'SKILL.md', contentBase64: b64(skillMd('pub')) }] },
      rows,
    );
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(Object.keys(await rowTexts('.skills/other'))).toEqual(['.skills/other/SKILL.md']);
    expect(Object.keys(await rowTexts('.skills/other@1'))).toEqual(['.skills/other@1/SKILL.md']);
    expect(await walkFiles(shared, 'skills')).toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a legacy move that fails part-way is resumed by the next patch', async () => {
    let failAt = Number.POSITIVE_INFINITY;
    let writes = 0;
    const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld((objects) => ({
      ...objects,
      write: (name, body, options) => {
        writes += 1;
        return writes === failAt
          ? Promise.reject(new Error('disk blip'))
          : objects.write(name, body, options);
      },
    }));
    await seedBareSkill(shared, legacyBody);
    await getSkillWithId(shared, catalogs[0], principal, 'dup');
    const patch = (body: unknown) =>
      patchSkillWithId(shared, catalogs[0], principal, 'dup', body, rows);

    failAt = 2;
    await expect(patch(addFile('references/new.md', 'new'))).rejects.toThrow('disk blip');
    expect(Object.keys(await rowTexts('.skills/dup'))).toEqual(['.skills/dup/SKILL.md']);

    const retried = await patch(addFile('references/new.md', 'new'));
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(await rowTexts('.skills/dup')).toEqual({
      '.skills/dup/SKILL.md': skillMd('old'),
      '.skills/dup/references/new.md': 'new',
      '.skills/dup/references/notes.md': 'notes',
      '.skills/dup/scripts/run.sh': runSh('old'),
    });
    expect(await walkFiles(shared, 'skills')).toEqual([]);

    // A file a patch removed after the move is never brought back.
    expect((await patch({ removeFiles: ['references/notes.md'] })).status).toBe(200);
    expect((await patch(addFile('references/later.md', 'later'))).status).toBe(200);
    expect(Object.keys(await rowTexts('.skills/dup')).sort()).toEqual([
      '.skills/dup/SKILL.md',
      '.skills/dup/references/later.md',
      '.skills/dup/references/new.md',
      '.skills/dup/scripts/run.sh',
    ]);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] two concurrent first patches of one legacy skill both land', async () => {
    const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld();
    await seedBareSkill(shared, legacyBody);
    await getSkillWithId(shared, catalogs[0], principal, 'dup');

    const patched = await Promise.all([
      patchSkillWithId(shared, catalogs[0], principal, 'dup', addFile('a.md', 'a'), rows),
      patchSkillWithId(shared, catalogs[1], principal, 'dup', addFile('b.md', 'b'), rows),
    ]);

    expect(patched.map((result) => result.status)).toEqual([200, 200]);
    expect(await rowTexts('.skills/dup')).toEqual({
      '.skills/dup/SKILL.md': skillMd('old'),
      '.skills/dup/a.md': 'a',
      '.skills/dup/b.md': 'b',
      '.skills/dup/references/notes.md': 'notes',
      '.skills/dup/scripts/run.sh': runSh('old'),
    });
  });
}
