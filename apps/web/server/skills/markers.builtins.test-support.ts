import { expect, it } from 'vitest';
import { readWhole } from '@agent-workspace/core/storage/streams';
import { builtinSkillFiles } from '@agent-workspace/skills-office';
import { digestOf, ensureBuiltinSkills } from './builtin';
import { skillBuiltinMarkerKey } from './keys';
import { importSkillWithId } from './service';
import type { SkillMarkerFixture } from './markers.harness.test-support';
import { BUILTIN } from './markers.fixture.test-support';
export function registerSkillMarkerBuiltinsTests(
  getFixture: () => Pick<SkillMarkerFixture, 'world'>,
) {
  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a built-in installed before the column existed is read from its marker and the column backfilled', async () => {
    const testContext = getFixture();

    const { principal, catalog, shared, puts, rows, putLegacy } = await testContext.world();
    const shipped = builtinSkillFiles(BUILTIN).map((file) => ({
      path: file.path,
      contentBase64: file.contentBase64,
    }));
    const imported = await importSkillWithId(
      shared,
      catalog,
      principal,
      { name: BUILTIN, files: shipped },
      rows,
    );
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    const digest = digestOf(
      shipped.map((file) => ({
        path: file.path,
        bytes: Buffer.from(file.contentBase64, 'base64'),
      })),
    );
    await putLegacy(skillBuiltinMarkerKey(BUILTIN), { digest });
    puts.length = 0;

    await ensureBuiltinSkills(shared, catalog, principal, [BUILTIN], rows);

    expect((await catalog.listSkills())[0]?.builtinDigest).toBe(digest);
    expect(await readWhole(shared, skillBuiltinMarkerKey(BUILTIN))).not.toBeNull();
    expect(puts).toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a built-in install records its digest on the row and writes no marker object', async () => {
    const testContext1 = getFixture();

    const { principal, catalog, shared, puts, rows } = await testContext1.world();

    await ensureBuiltinSkills(shared, catalog, principal, [BUILTIN], rows);

    const [row] = await catalog.listSkills();
    expect(row?.builtinDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.pendingDelete).toBeNull();
    expect(legacyPuts(puts)).toEqual([]);
  });
}

import { legacyPuts } from './markers.fixture.test-support';
