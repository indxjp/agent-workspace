import { expect, it } from 'vitest';
import { importSkillWithId, patchSkillWithId, publishSkillRevisionWithId } from './service';
import { SECOND_POOL_SIZE, addFile, importBody } from './service-storage-fixture.test-support';
import { type SkillRowsAccess } from './tree';

import type { RowsWorldFactory } from './service-storage-fixture.test-support';
export function registerConcurrentRevisionsTests(rowsWorld: RowsWorldFactory): void {
  // @story US-STO-08
  it('[US-STO-08][api][sdk] more concurrent publishes than the pool has connections all finish', async () => {
    const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld(undefined, 1);
    const imported = await importSkillWithId(shared, catalogs[1], principal, importBody('A'), rows);
    expect(imported.status).toBe(201);

    const published = await Promise.all(
      Array.from({ length: SECOND_POOL_SIZE + 1 }, (_, index) =>
        publishSkillRevisionWithId(
          shared,
          catalogs[1],
          principal,
          'dup',
          { files: importBody(`P${String(index)}`).files },
          rows,
        ),
      ),
    );

    expect(published.map((result) => result.status)).toEqual(
      Array.from({ length: SECOND_POOL_SIZE + 1 }, () => 201),
    );
    const numbers = published.map(
      (result) => (result.body as { revision: { number: number } }).revision.number,
    );
    const expected = Array.from({ length: SECOND_POOL_SIZE + 1 }, (_, index) => index + 1);
    expect([...numbers].sort((a, b) => a - b)).toEqual(expected);
    for (const number of numbers) {
      expect(Object.keys(await rowTexts(`.skills/dup@${String(number)}`))).toHaveLength(2);
    }
    const listed = await catalogs[1].listSkillRevisions('dup');
    expect(listed.map((revision) => revision.number)).toEqual([...expected].reverse());
  }, 60_000);

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a publish whose revision rows fail is never listed and its rows go', async () => {
    let fail = false;
    let writes = 0;
    const { principal, catalogs, shared, rows, rowTexts } = await rowsWorld((objects) => ({
      ...objects,
      write: (name, body, options) => {
        writes += 1;
        return fail && writes % 2 === 0
          ? Promise.reject(new Error('disk blip'))
          : objects.write(name, body, options);
      },
    }));
    expect(
      (await importSkillWithId(shared, catalogs[0], principal, importBody('A'), rows)).status,
    ).toBe(201);
    const publish = () =>
      publishSkillRevisionWithId(
        shared,
        catalogs[0],
        principal,
        'dup',
        { files: importBody('B').files },
        rows,
      );

    // The current files take writes 1-2 and the revision's first row write 3; write 4 fails.
    fail = true;
    writes = -1;
    await expect(publish()).rejects.toThrow('disk blip');
    expect(await catalogs[0].listSkillRevisions('dup')).toEqual([]);
    expect(await rowTexts('.skills/dup@1')).toEqual({});

    fail = false;
    expect(await publish()).toMatchObject({ status: 201, body: { revision: { number: 1 } } });
  });

  // @story US-STO-08
  it.each([
    ['upload_in_progress', 409],
    ['path_taken', 409],
    ['too_large', 413],
  ] as const)('[US-STO-08][api][sdk] a save refused as %s answers %i', async (code, status) => {
    const { principal, catalogs, shared, rows, storage } = await rowsWorld();
    const refusing: SkillRowsAccess = {
      ...rows,
      storage: { ...storage, save: () => Promise.resolve({ ok: false, code }) },
    };
    expect(
      await importSkillWithId(shared, catalogs[0], principal, importBody('A'), refusing),
    ).toMatchObject({ status, body: { error: { code } } });
    expect(await catalogs[0].listSkills()).toEqual([]);

    expect(
      (await importSkillWithId(shared, catalogs[0], principal, importBody('A'), rows)).status,
    ).toBe(201);
    expect(
      await patchSkillWithId(shared, catalogs[0], principal, 'dup', addFile('a.md', 'a'), refusing),
    ).toMatchObject({ status, body: { error: { code } } });
    expect(
      await publishSkillRevisionWithId(
        shared,
        catalogs[0],
        principal,
        'dup',
        { files: importBody('B').files },
        refusing,
      ),
    ).toMatchObject({ status, body: { error: { code } } });
    expect(await catalogs[0].listSkillRevisions('dup')).toEqual([]);
  });
}
