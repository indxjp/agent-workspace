/** Copying more than once, into several workspaces, and for entries that have no template. */
import { expect, it } from 'vitest';

import { SPEC, copy, type MakeDemoTemplatesWorld } from './templates.contract-world';

export function describeCopyBehaviour(make: MakeDemoTemplatesWorld): void {
  it('copies once: a second copy of the entry changes nothing', async () => {
    const world = await make();
    const entry = world.entry('twice');
    await world.seedTemplate(entry, { ...SPEC, connectors: [{ kind: 'mcp', name: 'mailer' }] });
    const guest = await world.newGuest();
    await copy(world, entry, guest);
    const before = await world.agents(guest.workspaceId);
    const pathsBefore = await world.paths(guest.workspaceId);
    const connectorsBefore = await world.connectors(guest.workspaceId);
    await copy(world, entry, guest);
    expect((await world.agents(guest.workspaceId)).map((a) => a.id)).toEqual(
      before.map((a) => a.id),
    );
    expect(await world.paths(guest.workspaceId)).toEqual(pathsBefore);
    expect((await world.connectors(guest.workspaceId)).map((c) => c.id)).toEqual(
      connectorsBefore.map((c) => c.id),
    );
  });

  it('adds a second entry to the same workspace and keeps the first', async () => {
    const world = await make();
    const first = world.entry('first');
    const second = world.entry('second');
    await world.seedTemplate(first, SPEC);
    await world.seedTemplate(second, {
      ...SPEC,
      agent: { ...SPEC.agent, name: 'ops-helper' },
      files: [{ path: 'tickets/t1.txt', text: 'sample ticket' }],
      assign: [{ path: 'tickets', access: 'read' }],
    });
    const guest = await world.newGuest();
    await copy(world, first, guest);
    await copy(world, second, guest);
    const names = (await world.agents(guest.workspaceId)).map((agent) => agent.name).sort();
    expect(names).toEqual(['ops-helper', 'sales-helper']);
    expect(await world.fileText(guest.workspaceId, 'deals/q1.csv')).not.toBeNull();
    expect(await world.fileText(guest.workspaceId, 'tickets/t1.txt')).toBe('sample ticket');
    for (const agent of await world.agents(guest.workspaceId)) {
      expect(await world.granted(guest.workspaceId, agent.id)).toEqual([guest.principalId]);
    }
  });

  it('adds the files of a second entry that shares a folder beside the first, keeping the first on a clash', async () => {
    const world = await make();
    const first = world.entry('shared-one');
    const second = world.entry('shared-two');
    const folder = { path: 'manuals', access: 'read' } as const;
    await world.seedTemplate(first, {
      ...SPEC,
      files: [
        { path: 'manuals/a.md', text: 'first a' },
        { path: 'manuals/same.md', text: 'first same' },
      ],
      assign: [folder],
    });
    await world.seedTemplate(second, {
      ...SPEC,
      agent: { ...SPEC.agent, name: 'ops-helper' },
      files: [
        { path: 'manuals/b.md', text: 'second b' },
        { path: 'manuals/same.md', text: 'second same' },
      ],
      assign: [folder],
    });
    const guest = await world.newGuest();
    await copy(world, first, guest);
    await copy(world, second, guest);
    expect(await world.fileText(guest.workspaceId, 'manuals/a.md')).toBe('first a');
    expect(await world.fileText(guest.workspaceId, 'manuals/b.md')).toBe('second b');
    expect(await world.fileText(guest.workspaceId, 'manuals/same.md')).toBe('first same');
  });

  it("keeps one visitor's copy apart from another's and from the template", async () => {
    const world = await make();
    const entry = world.entry('apart');
    await world.seedTemplate(entry, SPEC);
    const one = await world.newGuest();
    const other = await world.newGuest();
    await copy(world, entry, one);
    expect(await world.agents(other.workspaceId)).toEqual([]);
    expect(await world.paths(other.workspaceId)).toEqual([]);
  });

  it("serves no template a person created: a workspace with the slug is not the deployment's", async () => {
    const world = await make();
    const entry = world.entry('squat');
    await world.seedTemplate(entry, SPEC, 'person');
    expect(await world.templates.exists(entry)).toBe(false);
    const guest = await world.newGuest();
    await expect(copy(world, entry, guest)).rejects.toThrow(/no demo template/u);
    expect(await world.agents(guest.workspaceId)).toEqual([]);
    expect(await world.paths(guest.workspaceId)).toEqual([]);
  });

  it('caps an agent an earlier copy left uncapped, and changes nothing else', async () => {
    const world = await make();
    const entry = world.entry('recap');
    await world.seedTemplate(entry, SPEC);
    const guest = await world.newGuest();
    await copy(world, entry, guest, { maxTurns: 5, maxBudgetUsd: 0.2 });
    const [agent] = await world.agents(guest.workspaceId);
    await world.uncap(guest.workspaceId, agent?.id ?? '');
    expect((await world.agents(guest.workspaceId))[0]?.policy?.limits).toEqual({
      maxTurns: null,
      maxBudgetUsd: null,
    });
    await copy(world, entry, guest, { maxTurns: 5, maxBudgetUsd: 0.2 });
    const agents = await world.agents(guest.workspaceId);
    expect(agents.map((a) => a.id)).toEqual([agent?.id]);
    expect(agents[0]?.policy?.limits).toEqual({ maxTurns: 5, maxBudgetUsd: 0.2 });
  });

  it('fails, and copies nothing, for an entry with no template', async () => {
    const world = await make();
    const guest = await world.newGuest();
    await expect(copy(world, world.entry('missing'), guest)).rejects.toThrow(/no demo template/u);
    expect(await world.agents(guest.workspaceId)).toEqual([]);
  });
}
