/** The agent, files and per-run limits a copy carries. */
import { expect, it } from 'vitest';

import { SPEC, copy, type MakeDemoTemplatesWorld } from './templates.contract-world';

export function describeCopiedAgent(make: MakeDemoTemplatesWorld): void {
  it('says an entry has a template only once its workspace holds an agent', async () => {
    const world = await make();
    const entry = world.entry('exists');
    expect(await world.templates.exists(entry)).toBe(false);
    await world.seedTemplate(entry, SPEC);
    expect(await world.templates.exists(entry)).toBe(true);
    expect(await world.templates.exists(world.entry('other'))).toBe(false);
  });

  it('copies the agent into the visitor workspace and grants the guest, and only the guest', async () => {
    const world = await make();
    const entry = world.entry('agent');
    await world.seedTemplate(entry, SPEC);
    const guest = await world.newGuest();
    await copy(world, entry, guest);
    const [agent, ...rest] = await world.agents(guest.workspaceId);
    expect(rest).toEqual([]);
    expect(agent).toMatchObject({
      name: SPEC.agent.name,
      instructions: SPEC.agent.instructions,
      workspaceId: guest.workspaceId,
      modelConnectionId: null,
    });
    expect(await world.granted(guest.workspaceId, agent?.id ?? '')).toEqual([guest.principalId]);
  });

  it('copies the sample files the agent reads, at the same paths, and nothing else', async () => {
    const world = await make();
    const entry = world.entry('files');
    await world.seedTemplate(entry, SPEC);
    const guest = await world.newGuest();
    await copy(world, entry, guest);
    expect(await world.fileText(guest.workspaceId, 'deals/q1.csv')).toBe('id,amount\n1,100\n');
    expect(await world.fileText(guest.workspaceId, 'deals/notes/a.txt')).toBe('sample note');
    expect(await world.fileText(guest.workspaceId, 'private/secrets.txt')).toBeNull();
    const agent = (await world.agents(guest.workspaceId))[0];
    const assigned = await world.assignments(guest.workspaceId, agent?.id ?? '');
    const paths = await Promise.all(
      (assigned?.files ?? []).map((grant) => world.pathOf(guest.workspaceId, grant.fileId)),
    );
    expect(paths).toEqual(['deals']);
    expect(assigned?.files.map((grant) => grant.access)).toEqual(['read']);
  });

  it('never gives the copy internet: unrestrictedNetwork is off whatever the template had', async () => {
    const world = await make();
    const entry = world.entry('net');
    await world.seedTemplate(entry, {
      ...SPEC,
      agent: { ...SPEC.agent, unrestrictedNetwork: true },
    });
    const guest = await world.newGuest();
    await copy(world, entry, guest);
    const agent = (await world.agents(guest.workspaceId))[0];
    expect(agent?.permissions.unrestrictedNetwork).toBe(false);
  });

  it.each([
    { template: [12, 0.6], limit: [5, 0.2], copied: [5, 0.2] },
    { template: [12, 0.6], limit: [30, 3], copied: [12, 0.6] },
    { template: [12, 0.6], limit: [null, null], copied: [12, 0.6] },
    { template: [null, null], limit: [8, 0.5], copied: [8, 0.5] },
    { template: [null, null], limit: [null, null], copied: [null, null] },
  ] as const)(
    "clamps the copy's per-run limits $template by $limit to $copied",
    async ({ template, limit, copied }) => {
      const world = await make();
      const entry = world.entry('limits');
      await world.seedTemplate(entry, {
        ...SPEC,
        agent: { ...SPEC.agent, maxTurns: template[0], maxBudgetUsd: template[1] },
      });
      const guest = await world.newGuest();
      await copy(world, entry, guest, { maxTurns: limit[0], maxBudgetUsd: limit[1] });
      const agent = (await world.agents(guest.workspaceId))[0];
      expect(agent?.policy?.limits).toEqual({ maxTurns: copied[0], maxBudgetUsd: copied[1] });
    },
  );
}
