import { expect, it } from 'vitest';
import { skillInput } from './resource-catalogs.contract-skill-catalog-fixtures.js';

import type { SkillCatalogConformanceFixture } from './resource-catalogs.contract-fixture.js';
export function registerSkillRemovalTests(
  makeFixture: () => Promise<SkillCatalogConformanceFixture>,
): void {
  // @story US-STO-08
  it('[US-STO-08][contract][sdk] deleteSkill of an unknown name is not-found', async () => {
    const { catalog } = await makeFixture();
    await expect(catalog('a').deleteSkill('missing')).resolves.toEqual({ kind: 'not-found' });
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] deleteSkill refuses an assigned skill naming its agents, then deletes', async () => {
    const { catalog, ownerA, assign, unassign } = await makeFixture();
    const a = catalog('a');
    const assigned = await a.putSkill(skillInput('assigned', ownerA));
    const free = await a.putSkill(skillInput('free', ownerA));
    const agentId = await assign('a', assigned);

    await expect(a.deleteSkill('assigned')).resolves.toEqual({
      kind: 'in-use',
      agentIds: [agentId],
    });
    await expect(a.listSkills()).resolves.toEqual([assigned, free]);

    // Another workspace naming the same skill finds nothing and deletes nothing.
    await expect(catalog('b').deleteSkill('assigned')).resolves.toEqual({ kind: 'not-found' });

    await expect(a.deleteSkill('free')).resolves.toEqual({ kind: 'deleted', skill: free });
    await expect(a.deleteSkill('free')).resolves.toEqual({ kind: 'not-found' });
    await expect(a.listSkills()).resolves.toEqual([assigned]);

    // Once no agent uses it, the refused delete succeeds.
    await unassign('a', assigned, agentId);
    await expect(a.deleteSkill('assigned')).resolves.toEqual({
      kind: 'deleted',
      skill: assigned,
    });
    await expect(a.listSkills()).resolves.toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] deleteSkill with an id leaves a later row of the name alone', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    const first = await a.putSkill(skillInput('reused', ownerA));
    await a.deleteSkill('reused');
    const second = await a.putSkill(skillInput('reused', ownerA));

    await expect(a.deleteSkill('reused', first.id)).resolves.toEqual({ kind: 'not-found' });
    await expect(a.listSkills()).resolves.toEqual([second]);
    await expect(a.deleteSkill('reused', second.id)).resolves.toEqual({
      kind: 'deleted',
      skill: second,
    });
  });
}
