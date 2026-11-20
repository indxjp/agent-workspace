/** Connectors: stand-ins for tools that send or write, and the rules pointed at them. */
import { DEMO_SEND_RESULT } from '@indx-workspace/contracts/demo';
import { expect, it } from 'vitest';

import { SPEC, copy, type MakeDemoTemplatesWorld } from './templates.contract-world';

export function describeCopiedConnectors(make: MakeDemoTemplatesWorld): void {
  it('replaces a tool that could send or write with a stand-in under the same name', async () => {
    const world = await make();
    const entry = world.entry('fakes');
    await world.seedTemplate(entry, {
      ...SPEC,
      connectors: [
        { kind: 'mcp', name: 'mailer' },
        { kind: 'openapi-write', name: 'tracker' },
      ],
    });
    const guest = await world.newGuest();
    await copy(world, entry, guest);
    const copied = await world.connectors(guest.workspaceId);
    expect(copied.map((connector) => connector.name).sort()).toEqual(['mailer', 'tracker']);
    for (const connector of copied) {
      // A stand-in is a local process: no address, no secret, no connector row of the template.
      expect(connector).toMatchObject({
        transport: 'stdio',
        command: 'node',
        url: null,
        authType: 'none',
        hasCredential: false,
      });
      expect(connector.kind).toBeUndefined();
      expect((connector as { args: readonly string[] }).args.join(' ')).toContain(
        DEMO_SEND_RESULT.en,
      );
    }
    const tracker = copied.find((connector) => connector.name === 'tracker');
    // The openapi tool's write operation is the stand-in's tool; its read is not carried.
    expect((tracker as { args: readonly string[] }).args.slice(2)).toEqual(['createPet']);
    const agent = (await world.agents(guest.workspaceId))[0];
    const assigned = await world.assignments(guest.workspaceId, agent?.id ?? '');
    expect([...(assigned?.connectorIds ?? [])].sort()).toEqual(copied.map((c) => c.id).sort());
  });

  it("points the template's tool rules at the stand-in, so its approval and deny rules still apply", async () => {
    const world = await make();
    const entry = world.entry('rules');
    await world.seedTemplate(entry, {
      ...SPEC,
      connectors: [{ kind: 'mcp', name: 'mailer' }],
      rules: { autoApprove: ['mcp__mailer__draft'], deny: ['mcp__mailer__delete_all'] },
    });
    const guest = await world.newGuest();
    await copy(world, entry, guest);
    const standIn = (await world.connectors(guest.workspaceId)).find((c) => c.name === 'mailer');
    if (standIn === undefined || standIn.transport !== 'stdio') throw new Error('no stand-in');
    // The stand-in offers the tools the rules name, so they match a tool that exists.
    expect([...(standIn.args ?? []).slice(2)].sort()).toEqual(['delete_all', 'draft']);
    const policy = (await world.agents(guest.workspaceId))[0]?.policy;
    if (policy === undefined || policy === null || !('tools' in policy)) {
      throw new Error('the copy has no tool policy');
    }
    expect(policy.tools.autoApprove).toContain(`mcp__connector-${standIn.id}__draft`);
    expect(policy.tools.deny).toContain(`mcp__connector-${standIn.id}__delete_all`);
    // Every rule on a connector names one of this visitor's own connectors.
    const ownIds = new Set((await world.connectors(guest.workspaceId)).map((c) => c.id));
    for (const rule of [...policy.tools.autoApprove, ...policy.tools.deny]) {
      const id = /^mcp__connector-(.+?)__/u.exec(rule)?.[1];
      if (id !== undefined) expect(ownIds.has(id)).toBe(true);
    }
  });

  it("leaves out a connector that only reads, and carries none of the template's connectors", async () => {
    const world = await make();
    const entry = world.entry('readers');
    await world.seedTemplate(entry, {
      ...SPEC,
      connectors: [
        { kind: 'openapi-read', name: 'catalogue' },
        { kind: 'postgres', name: 'warehouse' },
      ],
    });
    const guest = await world.newGuest();
    await copy(world, entry, guest);
    expect(await world.connectors(guest.workspaceId)).toEqual([]);
    const agent = (await world.agents(guest.workspaceId))[0];
    expect((await world.assignments(guest.workspaceId, agent?.id ?? ''))?.connectorIds).toEqual([]);
  });
}
