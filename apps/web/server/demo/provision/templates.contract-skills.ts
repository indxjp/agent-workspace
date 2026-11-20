/** A template agent's skills, copied into the visitor workspace. */
import { expect, it } from 'vitest';

import { SPEC, copy, type MakeDemoTemplatesWorld } from './templates.contract-world';

export function describeCopiedSkills(make: MakeDemoTemplatesWorld): void {
  it("copies the template agent's skills into the visitor workspace and assigns them to the copy", async () => {
    const world = await make();
    const entry = world.entry('skills');
    const costModel = {
      'SKILL.md': '---\nname: cost-model\ndescription: Prices a part.\n---\n\nPrice it.\n',
      'scripts/estimate.mjs': 'export const estimate = () => 1;\n',
    };
    await world.seedTemplate(entry, {
      ...SPEC,
      skills: [{ name: 'cost-model', files: costModel }, { name: 'office-reader' }],
    });
    const guest = await world.newGuest();
    await copy(world, entry, guest);
    const visitorSkills = await world.skills(guest.workspaceId);
    expect(visitorSkills.map((skill) => skill.name).sort()).toEqual([
      'cost-model',
      'office-reader',
    ]);
    expect(await world.skillFiles(guest.workspaceId, 'cost-model')).toEqual(costModel);
    // The built-in is the platform's own release, the same files the template holds.
    expect(await world.skillFiles(guest.workspaceId, 'office-reader')).toEqual(
      await world.skillFiles((await world.templateId(entry)) ?? '', 'office-reader'),
    );
    const [agent] = await world.agents(guest.workspaceId);
    const assigned = await world.assignments(guest.workspaceId, agent?.id ?? '');
    const idOf = (name: string) => visitorSkills.find((skill) => skill.name === name)?.id;
    // The definition resolves each skill to the visitor's own row, never the template's.
    expect([...(assigned?.skillIds ?? [])].sort()).toEqual(
      [idOf('cost-model'), idOf('office-reader')].sort(),
    );
    const policy = agent?.policy;
    if (policy === undefined || policy === null) throw new Error('the copy has no policy');
    expect(policy.skills).toEqual({ mode: 'allowlist', names: ['cost-model', 'office-reader'] });
    // A second copy finds the skills and makes none again.
    await copy(world, entry, guest);
    expect(await world.skills(guest.workspaceId)).toEqual(visitorSkills);
  });

  it('allows the skills of a template agent whose policy is compiled, as a run of it would', async () => {
    const world = await make();
    const entry = world.entry('skills-compiled');
    await world.seedTemplate(entry, {
      ...SPEC,
      policy: 'compiled',
      skills: [{ name: 'keigo-reply', files: { 'SKILL.md': '---\nname: keigo-reply\n---\n' } }],
    });
    const guest = await world.newGuest();
    await copy(world, entry, guest);
    const [agent] = await world.agents(guest.workspaceId);
    expect(agent?.policy?.skills).toEqual({ mode: 'allowlist', names: ['keigo-reply'] });
  });

  it('leaves a copy of a template without skills as it was: no skill made, none assigned', async () => {
    const world = await make();
    const entry = world.entry('no-skills');
    await world.seedTemplate(entry, SPEC);
    const guest = await world.newGuest();
    await copy(world, entry, guest);
    expect(await world.skills(guest.workspaceId)).toEqual([]);
    const [agent] = await world.agents(guest.workspaceId);
    expect((await world.assignments(guest.workspaceId, agent?.id ?? ''))?.skillIds).toEqual([]);
    expect(agent?.policy?.skills).toEqual({ mode: 'allowlist', names: [] });
  });
}
