import { expect, it } from 'vitest';
import { importSkillWithId, patchSkillWithId } from './service';
import { b64, importBody, runSh, skillMd } from './service-storage-fixture.test-support';
import { walkFiles } from './tree';

import type { RowsWorldFactory } from './service-storage-fixture.test-support';
export function registerStorageWritesTests(rowsWorld: RowsWorldFactory): void {
  // @story US-STO-08
  it('[US-STO-08][api][cli] aw skills push', async () => {
    const { principal, catalogs, shared, objects, rows, rowTexts } = await rowsWorld();
    const imported = await importSkillWithId(shared, catalogs[0], principal, importBody('A'), rows);
    expect(imported.status).toBe(201);

    // The second push of `uploadSkill`: the new files, and the paths the new directory dropped.
    const pushed = await patchSkillWithId(
      shared,
      catalogs[0],
      principal,
      'dup',
      {
        files: [
          { path: 'SKILL.md', contentBase64: b64(skillMd('B')) },
          { path: 'references/new.md', contentBase64: b64('new') },
        ],
        removeFiles: ['scripts/run.sh'],
      },
      rows,
    );

    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(await rowTexts('.skills/dup')).toEqual({
      '.skills/dup/SKILL.md': skillMd('B'),
      '.skills/dup/references/new.md': 'new',
    });
    expect((await objects.listPage('', { recursive: true })).entries).toHaveLength(2);
    expect(await walkFiles(shared, 'skills')).toEqual([]);
    expect((await catalogs[0].listSkills()).map((row) => row.skillMd)).toEqual([skillMd('B')]);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a failing save leaves the previous version readable', async () => {
    let failFrom = Number.POSITIVE_INFINITY;
    let writes = 0;
    const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld((objects) => ({
      ...objects,
      write: (name, body, options) => {
        writes += 1;
        return writes >= failFrom
          ? Promise.reject(new Error('disk blip'))
          : objects.write(name, body, options);
      },
    }));
    const imported = await importSkillWithId(shared, catalogs[0], principal, importBody('A'), rows);
    expect(imported.status).toBe(201);
    const before = await rowTexts('.skills/dup');

    failFrom = writes + 2;
    await expect(
      patchSkillWithId(
        shared,
        catalogs[0],
        principal,
        'dup',
        {
          files: [
            { path: 'SKILL.md', contentBase64: b64(skillMd('B')) },
            { path: 'references/a.md', contentBase64: b64('a') },
            { path: 'references/b.md', contentBase64: b64('b') },
          ],
          removeFiles: ['scripts/run.sh'],
        },
        rows,
      ),
    ).rejects.toThrow();

    const after = await rowTexts('.skills/dup');
    expect(after['.skills/dup/scripts/run.sh']).toBe(before['.skills/dup/scripts/run.sh']);
    expect(after['.skills/dup/SKILL.md']).toBeDefined();
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a failed import removes its rows and releases the name', async () => {
    let fail = true;
    let writes = 0;
    const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld((objects) => ({
      ...objects,
      write: (name, body, options) => {
        writes += 1;
        return fail && writes === 2
          ? Promise.reject(new Error('disk blip'))
          : objects.write(name, body, options);
      },
    }));

    await expect(
      importSkillWithId(shared, catalogs[0], principal, importBody('A'), rows),
    ).rejects.toThrow();
    expect(await rowTexts('.skills/dup')).toEqual({});
    expect(await catalogs[0].listSkills()).toEqual([]);

    fail = false;
    const retried = await importSkillWithId(shared, catalogs[0], principal, importBody('B'), rows);
    expect(retried.status).toBe(201);
    expect(await rowTexts('.skills/dup')).toEqual({
      '.skills/dup/SKILL.md': skillMd('B'),
      '.skills/dup/scripts/run.sh': runSh('B'),
    });
  });
}
