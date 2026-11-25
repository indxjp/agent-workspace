/**
 * The verification workspace fill (`verification.ts`) over the memory templates world: every
 * template the deployment holds is copied into an ordinary workspace as a visitor's copy is, a
 * second fill adds nothing, and a demo workspace, a template or an unknown workspace is never filled.
 */
import crypto from 'node:crypto';

import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';
import { canonicalCall } from '@indx-workspace/contracts/agents';
import { DEMO_RECORD_SAMPLES } from '@indx-workspace/contracts/demo-operator';
import { describe, expect, it, vi } from 'vitest';

import { createDemoApprovedWrites } from '../records/approved-writes';
import { readRecordsServerState } from './records-server';
import { converse, resultOf, toolCall } from './stand-in.test-support';

import type { DemoTemplatesWorld, TemplateSpec } from './templates.contract';
import { createMemoryTemplatesWorld } from './templates.world.test-support';
import { DEMO_RUNTIME_PROFILE_NAME } from './template-copy';
import { CHANGED, FIRST, refreshSeed } from './templates.contract-refresh';
import { createDemoVerification } from './verification';

const NOW = new Date('2026-11-16T09:00:00.000Z');
const LIMITS = { maxTurns: 6, maxBudgetUsd: 0.25 };

const spec = (name: string): TemplateSpec => ({
  agent: { name, instructions: 'Use the sample data.', maxTurns: 12, maxBudgetUsd: 0.6 },
  files: [{ path: `${name}/notes.txt`, text: 'sample' }],
  assign: [{ path: name, access: 'read' }],
  connectors: [{ kind: 'declared', name: `${name}-system`, reads: [], writes: ['send'] }],
});

/** The verification marks, as `workspaces.demo_verification_at` keeps them: the first one stays. */
function verificationMarks() {
  const marked = new Map<string, Date>();
  return {
    marked,
    markVerificationWorkspace: (workspaceId: string, now: Date) => {
      if (!marked.has(workspaceId)) marked.set(workspaceId, now);
      return Promise.resolve();
    },
  };
}

/** A world with two templates, and the fill over it in the order the operations report them. */
async function worldWithTemplates(
  specs: readonly TemplateSpec[] = [spec('quotation'), spec('writer')],
): Promise<{
  readonly world: DemoTemplatesWorld;
  readonly entries: readonly DemoEntrySlug[];
  readonly verification: ReturnType<typeof createDemoVerification>;
  readonly marks: ReturnType<typeof verificationMarks>;
}> {
  const world = createMemoryTemplatesWorld();
  const entries = [world.entry('quotation'), world.entry('wiki')].slice(0, specs.length);
  for (const [index, entry] of entries.entries()) {
    await world.seedTemplate(entry, specs[index] ?? spec('quotation'));
  }
  const marks = verificationMarks();
  const verification = createDemoVerification({
    templates: world.templates,
    templateEntries: async () =>
      (await world.operations.report()).templates
        .filter((template) => template.agent !== null)
        .map((template) => template.entry),
    directory: world.directory,
    limits: LIMITS,
    markVerificationWorkspace: marks.markVerificationWorkspace,
  });
  return { world, entries, verification, marks };
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
    const { world, verification, marks } = await worldWithTemplates();
    const guest = await world.newGuest();
    expect(await verification.fill({ workspaceId: guest.workspaceId, now: NOW })).toEqual({
      kind: 'workspace-refused',
    });
    expect(await world.agents(guest.workspaceId)).toEqual([]);
    expect(marks.marked.size).toBe(0);
  });

  it('marks the workspace it fills, once: a second fill keeps the first mark (ADR-0169 D3)', async () => {
    const { world, verification, marks } = await worldWithTemplates();
    const owner = await world.newWorkspace();
    await verification.fill({ workspaceId: owner.workspaceId, now: NOW });
    await verification.fill({
      workspaceId: owner.workspaceId,
      now: new Date('2026-11-17T09:00:00Z'),
    });
    expect([...marks.marked]).toEqual([[owner.workspaceId, NOW]]);
  });

  it('refills a changed entry after a deploy re-seeded its template, and keeps the first mark (#2407)', async () => {
    const world = createMemoryTemplatesWorld();
    const entry = world.entry('refill');
    await world.operations.seed({ entry, seed: refreshSeed(FIRST), now: NOW });
    const marks = verificationMarks();
    const verification = createDemoVerification({
      templates: world.templates,
      templateEntries: () => Promise.resolve([entry]),
      directory: world.directory,
      limits: LIMITS,
      markVerificationWorkspace: marks.markVerificationWorkspace,
    });
    const owner = await world.newWorkspace();
    await verification.fill({ workspaceId: owner.workspaceId, now: NOW });
    const [before] = await world.agents(owner.workspaceId);

    await world.operations.seed({ entry, seed: refreshSeed(CHANGED), now: NOW });
    const later = new Date('2026-11-18T09:00:00Z');
    expect(await verification.fill({ workspaceId: owner.workspaceId, now: later })).toEqual({
      kind: 'filled',
      entries: [entry],
    });
    const [agent, ...others] = await world.agents(owner.workspaceId);
    expect(others).toEqual([]);
    expect(agent).toMatchObject({ id: before?.id, instructions: CHANGED.instructions });
    expect(agent?.policy?.limits).toEqual(LIMITS);
    expect(await world.fileText(owner.workspaceId, 'samples/faq.md')).toBe(
      CHANGED.files['samples/faq.md'],
    );
    expect([...marks.marked]).toEqual([[owner.workspaceId, NOW]]);
  });

  it('keeps an approved write in the verification workspace, and reads nothing of an ordinary one', async () => {
    const { world, verification, marks } = await worldWithTemplates([
      {
        ...spec('scheduling'),
        connectors: [
          {
            kind: 'declared',
            name: 'calendar',
            reads: ['event_list'],
            writes: ['event_create'],
            recorded: [{ write: 'event_create', kind: 'calendar', read: 'event_list' }],
          },
        ],
      },
    ]);
    const filled = await world.newWorkspace();
    const ordinary = await world.newWorkspace();
    await verification.fill({ workspaceId: filled.workspaceId, now: NOW });
    const forWorkspace = vi.spyOn(world.connectorStores, 'forWorkspace');
    const keeper = createDemoApprovedWrites({
      connectors: world.connectorStores,
      keepsDemoWrites: (workspaceId) => Promise.resolve(marks.marked.has(workspaceId)),
    });
    const event = DEMO_RECORD_SAMPLES.calendar.ja;
    const call = { canonicalCall: canonicalCall('mcp__calendar__event_create', event) };

    await keeper.keep({ workspaceId: ordinary.workspaceId, calls: [call] });
    expect(forWorkspace).not.toHaveBeenCalled();

    await keeper.keep({ workspaceId: filled.workspaceId, calls: [call] });
    const [calendar] = await world.connectors(filled.workspaceId);
    if (calendar === undefined || !('transport' in calendar)) throw new Error('no stand-in');
    const written = readRecordsServerState(calendar)?.written ?? [];
    expect(written.map((kept) => [kept.write, kept.outcome.recorded])).toEqual([
      ['event_create', true],
    ]);
    const [read] = await converse({ args: calendar.args ?? [] }, [toolCall(1, 'event_list')]);
    const records = (resultOf(read)['structuredContent'] as { records: { title: string }[] })
      .records;
    expect(records.map((record) => record.title)).toEqual([event.title]);
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
      markVerificationWorkspace: () => Promise.resolve(),
    });
    const owner = await world.newWorkspace();
    expect(await verification.fill({ workspaceId: owner.workspaceId, now: NOW })).toEqual({
      kind: 'filled',
      entries: [],
    });
    expect(await world.agents(owner.workspaceId)).toEqual([]);
  });
});
