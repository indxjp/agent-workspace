/**
 * The verification workspace fill (`verification.ts`) over the memory templates world: every
 * template the deployment holds is copied into an ordinary workspace as a visitor's copy is, a
 * second fill adds nothing, and a demo workspace, a template or an unknown workspace is never filled.
 */
import crypto from 'node:crypto';

import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';
import { describe, expect, it } from 'vitest';

import type { DemoTemplatesWorld, TemplateSpec } from './templates.contract';
import { createMemoryTemplatesWorld } from './templates.world.test-support';
import { DEMO_RUNTIME_PROFILE_NAME } from './template-copy';
import { createDemoVerification } from './verification';

const NOW = new Date('2026-11-16T09:00:00.000Z');
const LIMITS = { maxTurns: 6, maxBudgetUsd: 0.25 };

const spec = (name: string): TemplateSpec => ({
  agent: { name, instructions: 'Use the sample data.', maxTurns: 12, maxBudgetUsd: 0.6 },
  files: [{ path: `${name}/notes.txt`, text: 'sample' }],
  assign: [{ path: name, access: 'read' }],
  connectors: [{ kind: 'declared', name: `${name}-system`, reads: [], writes: ['send'] }],
});

/** A world with two templates, and the fill over it in the order the operations report them. */
async function worldWithTemplates(): Promise<{
  readonly world: DemoTemplatesWorld;
  readonly entries: readonly DemoEntrySlug[];
  readonly verification: ReturnType<typeof createDemoVerification>;
}> {
  const world = createMemoryTemplatesWorld();
  const entries = [world.entry('quotation'), world.entry('wiki')];
  await world.seedTemplate(entries[0] ?? '', spec('quotation'));
  await world.seedTemplate(entries[1] ?? '', spec('writer'));
  const verification = createDemoVerification({
    templates: world.templates,
    templateEntries: async () =>
      (await world.operations.report()).templates
        .filter((template) => template.agent !== null)
        .map((template) => template.entry),
    directory: world.directory,
    limits: LIMITS,
  });
  return { world, entries, verification };
}

describe('filling the verification workspace', () => {
  it('copies every template into the workspace, for its Owner, as a visitor gets it', async () => {
    const { world, entries, verification } = await worldWithTemplates();
    const owner = await world.newWorkspace();
    const outcome = await verification.fill({ workspaceId: owner.workspaceId, now: NOW });
    expect(outcome).toEqual({ kind: 'filled', entries: [...entries].sort() });
    const agents = await world.agents(owner.workspaceId);
    expect(agents.map((agent) => agent.name).sort()).toEqual(['quotation', 'writer']);
    const [profile, ...others] = await world.profiles(owner.workspaceId);
    expect(others).toEqual([]);
    expect(profile).toMatchObject({ name: DEMO_RUNTIME_PROFILE_NAME, networkPolicy: 'none' });
    for (const agent of agents) {
      expect(agent.runtimeProfileId).toBe(profile?.id);
      expect(agent.policy?.limits).toEqual(LIMITS);
      expect(await world.granted(owner.workspaceId, agent.id)).toEqual([owner.principalId]);
    }
    // Each outside system is a stand-in with no address: never the template's connector.
    const connectors = await world.connectors(owner.workspaceId);
    expect(connectors.map((c) => c.name).sort()).toEqual(['quotation-system', 'writer-system']);
    for (const connector of connectors) expect(connector).toMatchObject({ url: null });
  });

  it('adds nothing the second time', async () => {
    const { world, verification } = await worldWithTemplates();
    const owner = await world.newWorkspace();
    await verification.fill({ workspaceId: owner.workspaceId, now: NOW });
    const agents = (await world.agents(owner.workspaceId)).map((agent) => agent.id);
    const connectors = (await world.connectors(owner.workspaceId)).map((c) => c.id);
    const paths = await world.paths(owner.workspaceId);
    await verification.fill({ workspaceId: owner.workspaceId, now: NOW });
    expect((await world.agents(owner.workspaceId)).map((agent) => agent.id)).toEqual(agents);
    expect((await world.connectors(owner.workspaceId)).map((c) => c.id)).toEqual(connectors);
    expect(await world.paths(owner.workspaceId)).toEqual(paths);
  });

  it("refuses a visitor's demo workspace and copies nothing into it", async () => {
    const { world, verification } = await worldWithTemplates();
    const guest = await world.newGuest();
    expect(await verification.fill({ workspaceId: guest.workspaceId, now: NOW })).toEqual({
      kind: 'workspace-refused',
    });
    expect(await world.agents(guest.workspaceId)).toEqual([]);
  });

  it('refuses a template workspace and leaves it as it was', async () => {
    const { world, entries, verification } = await worldWithTemplates();
    const templateId = (await world.templateId(entries[0] ?? '')) ?? '';
    const before = await world.agents(templateId);
    expect(await verification.fill({ workspaceId: templateId, now: NOW })).toEqual({
      kind: 'workspace-refused',
    });
    expect(await world.agents(templateId)).toEqual(before);
  });

  it('answers not found for a workspace that does not exist', async () => {
    const { verification } = await worldWithTemplates();
    expect(await verification.fill({ workspaceId: crypto.randomUUID(), now: NOW })).toEqual({
      kind: 'workspace-not-found',
    });
  });

  it('skips an entry the operations name that has no template to copy', async () => {
    const { world } = await worldWithTemplates();
    const verification = createDemoVerification({
      templates: world.templates,
      templateEntries: () => Promise.resolve([world.entry('gone')]),
      directory: world.directory,
      limits: LIMITS,
    });
    const owner = await world.newWorkspace();
    expect(await verification.fill({ workspaceId: owner.workspaceId, now: NOW })).toEqual({
      kind: 'filled',
      entries: [],
    });
    expect(await world.agents(owner.workspaceId)).toEqual([]);
  });
});
