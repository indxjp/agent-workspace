import { expect, it } from 'vitest';
import {
  skillCheckViolation,
  skillInput,
  type SkillWrite,
} from './resource-catalogs.contract-skill-catalog-fixtures.js';

import type { SkillCatalogConformanceFixture } from './resource-catalogs.contract-fixture.js';
export function registerSkillRowsTests(
  makeFixture: () => Promise<SkillCatalogConformanceFixture>,
): void {
  // @story US-STO-08
  it('[US-STO-08][contract][sdk] listSkills returns put skills ordered by name', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await expect(a.listSkills()).resolves.toEqual([]);
    const zeta = await a.putSkill(skillInput('zeta', ownerA));
    const alpha = await a.putSkill(skillInput('alpha', ownerA));
    await expect(a.listSkills()).resolves.toEqual([alpha, zeta]);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] listSkills orders names by code point, a hyphen before a digit or letter', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    for (const name of ['ab', 'a-c', 'a0']) await a.putSkill(skillInput(name, ownerA));
    const names = (await a.listSkills()).map((skill) => skill.name);
    expect(names).toEqual(['a-c', 'a0', 'ab']);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] putSkill and createSkill refuse a bad name or a blank SKILL.md', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const writes = [
      (input: SkillWrite) => a.putSkill(input),
      (input: SkillWrite) => a.createSkill(input),
    ];
    for (const write of writes) {
      await expect(write(skillInput('Not_A_Name', ownerA))).rejects.toMatchObject(
        skillCheckViolation('skills_name_shape'),
      );
      await expect(write({ ...skillInput('blank', ownerA), skillMd: '   ' })).rejects.toMatchObject(
        skillCheckViolation('skills_skill_md_not_blank'),
      );
    }
    await expect(a.listSkills()).resolves.toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] getSkill reads one skill by name, in its workspace only', async () => {
    const { catalog, ownerA } = await makeFixture();
    const alpha = await catalog('a').putSkill(skillInput('alpha', ownerA));
    await expect(catalog('a').getSkill('alpha')).resolves.toEqual(alpha);
    await expect(catalog('a').getSkill('zeta')).resolves.toBeNull();
    await expect(catalog('b').getSkill('alpha')).resolves.toBeNull();
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] putSkill upserts by name and never transfers id or owner', async () => {
    const { catalog, ownerA, ownerB } = await makeFixture();
    const a = catalog('a');
    const first = await a.putSkill(skillInput('reviewer', ownerA));
    const second = await a.putSkill({
      ...skillInput('reviewer', ownerB),
      skillMd: '# changed',
      enabled: false,
    });
    expect(second).toEqual({ ...first, skillMd: '# changed', enabled: false });
    await expect(a.listSkills()).resolves.toEqual([second]);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] createSkill inserts once; a second create of the name returns null and changes nothing', async () => {
    const { catalog, ownerA, ownerB } = await makeFixture();
    const a = catalog('a');
    const created = await a.createSkill(skillInput('reviewer', ownerA));
    expect(created).toMatchObject({
      name: 'reviewer',
      skillMd: '# reviewer',
      ownerPrincipalId: ownerA,
    });

    await expect(
      a.createSkill({ ...skillInput('reviewer', ownerB), skillMd: '# other', enabled: false }),
    ).resolves.toBeNull();
    await expect(a.listSkills()).resolves.toEqual([created]);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] putSkill over a created skill keeps its id and owner', async () => {
    const { catalog, ownerA, ownerB } = await makeFixture();
    const a = catalog('a');
    const created = await a.createSkill(skillInput('reviewer', ownerA));
    const updated = await a.putSkill({ ...skillInput('reviewer', ownerB), skillMd: '# changed' });
    expect(updated).toEqual({ ...created, skillMd: '# changed' });
  });

  it('putSkill over a skill with no creator keeps createdBy null', async () => {
    const { catalog, ownerA, actorA } = await makeFixture();
    const a = catalog('a');
    await a.putSkill(skillInput('reviewer', ownerA));
    const again = await a.putSkill({ ...skillInput('reviewer', ownerA), createdBy: actorA });
    expect(again.createdBy).toBeNull();
  });
}
