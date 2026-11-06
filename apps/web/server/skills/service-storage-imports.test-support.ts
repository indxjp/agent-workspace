import { builtinSkillFiles } from '@agent-workspace/skills-office';
import { expect, it } from 'vitest';
import { ensureBuiltinSkills } from './builtin';
import { skillFileKey, skillFilesPrefix, skillRowFolder } from './keys';
import { seedBareSkill } from './rows-fixture';
import { importSkillWithId } from './service';
import {
  b64,
  gatedFirstWrite,
  importBody,
  runSh,
  skillMd,
  textAt,
} from './service-storage-fixture.test-support';
import { skillFiles } from './tree';

import type { RowsWorldFactory } from './service-storage-fixture.test-support';
export function registerImportsTests(rowsWorld: RowsWorldFactory): void {
  // @story US-STO-08
  it('[US-STO-08][api][sdk] two concurrent imports of one skill name: one 201, one 409, the winner files intact', async () => {
    const { principal, catalogs, shared, objects, rowTexts, onServer } = await rowsWorld();
    const gate = gatedFirstWrite();

    const first = importSkillWithId(
      shared,
      catalogs[0],
      principal,
      importBody('A'),
      onServer(0, gate.wrap(objects)),
    );
    try {
      await gate.entered;
      const second = await Promise.race([
        importSkillWithId(shared, catalogs[1], principal, importBody('B'), onServer(1)),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 2000)),
      ]);
      expect(second).toMatchObject({
        status: 409,
        body: { error: { code: 'skill_already_exists' } },
      });
      expect(await rowTexts('.skills/dup')).toEqual({});
    } finally {
      gate.release();
    }

    expect((await first).status).toBe(201);
    expect(await rowTexts('.skills/dup')).toEqual({
      '.skills/dup/SKILL.md': skillMd('A'),
      '.skills/dup/scripts/run.sh': runSh('A'),
    });
    for (const catalog of catalogs) {
      const listed = await catalog.listSkills();
      expect(listed.map((row) => [row.name, row.skillMd])).toEqual([['dup', skillMd('A')]]);
    }
  }, 30_000);

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a failed import releases the name; a retry succeeds', async () => {
    const { principal, catalogs, shared, objects, rowTexts, onServer } = await rowsWorld();
    let writes = 0;
    const failing = onServer(0, {
      ...objects,
      write: (name, body, options) => {
        writes += 1;
        return writes === 3
          ? Promise.reject(new Error('disk blip'))
          : objects.write(name, body, options);
      },
    });
    // The failed import writes SKILL.md and a file the retry does not, then fails.
    const first = importBody('A');
    const withStale = {
      ...first,
      files: [
        first.files[0],
        { path: 'scripts/stale.sh', contentBase64: b64('stale\n') },
        first.files[1],
      ],
    };

    await expect(
      importSkillWithId(shared, catalogs[0], principal, withStale, failing),
    ).rejects.toThrow('disk blip');
    await expect(catalogs[1].listSkills()).resolves.toEqual([]);
    expect(await rowTexts('.skills/dup')).toEqual({});

    const retry = await importSkillWithId(
      shared,
      catalogs[1],
      principal,
      importBody('B'),
      onServer(1),
    );
    expect(retry.status).toBe(201);
    expect(await rowTexts('.skills/dup')).toEqual({
      '.skills/dup/SKILL.md': skillMd('B'),
      '.skills/dup/scripts/run.sh': runSh('B'),
    });
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a failed import keeps a row another import reserved under the name since', async () => {
    const { principal, catalogs, shared, objects, onServer } = await rowsWorld();
    const other = {
      name: 'dup',
      skillMd: skillMd('B'),
      enabled: true,
      ownerPrincipalId: principal.ownerPrincipalId,
    };
    let writes = 0;
    // While the import runs, its row is deleted and the name reserved again by another import.
    const failing = onServer(0, {
      ...objects,
      write: async (name, body, options) => {
        writes += 1;
        if (writes < 2) return objects.write(name, body, options);
        await catalogs[1].deleteSkill('dup');
        await catalogs[1].createSkill(other);
        throw new Error('disk blip');
      },
    });

    await expect(
      importSkillWithId(shared, catalogs[0], principal, importBody('A'), failing),
    ).rejects.toThrow('disk blip');

    const rows = await catalogs[1].listSkills();
    expect(rows.map((row) => [row.name, row.skillMd])).toEqual([['dup', skillMd('B')]]);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a built-in install completes into a row a crashed import left with no files', async () => {
    const { principal, catalogs, shared, onServer } = await rowsWorld();
    const name = 'office-reader';
    const rows = onServer(1);
    const orphan = await catalogs[0].createSkill({
      name,
      skillMd: '# crashed',
      enabled: true,
      ownerPrincipalId: principal.ownerPrincipalId,
      createdBy: principal.userId,
    });

    await ensureBuiltinSkills(shared, catalogs[1], principal, [name], rows);

    const files = await skillFiles(shared, rows, skillRowFolder(name), skillFilesPrefix(name));
    for (const file of builtinSkillFiles(name)) {
      const bytes = await files.find((found) => found.relativePath === file.path)?.read();
      expect(
        bytes === undefined || bytes === null ? null : Buffer.from(bytes).toString('base64'),
      ).toBe(file.contentBase64);
    }
    const listed = await catalogs[0].listSkills();
    expect(listed.map((row) => row.id)).toEqual([orphan?.id]);
    expect(listed[0]?.skillMd).not.toBe('# crashed');
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] an import over a skill stored before the catalog had rows answers 409 and keeps its files', async () => {
    const { principal, catalogs, shared, rows } = await rowsWorld();
    await seedBareSkill(shared, importBody('old'));

    const result = await importSkillWithId(shared, catalogs[0], principal, importBody('new'), rows);

    expect(result).toMatchObject({
      status: 409,
      body: { error: { code: 'skill_already_exists' } },
    });
    await expect(catalogs[0].listSkills()).resolves.toEqual([]);
    expect(await textAt(shared, skillFileKey('dup', 'SKILL.md'))).toBe(skillMd('old'));
    expect(await textAt(shared, skillFileKey('dup', 'scripts/run.sh'))).toBe(runSh('old'));
  });
}
