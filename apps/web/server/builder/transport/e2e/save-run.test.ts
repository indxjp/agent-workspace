/**
 * [US-BLD-03][api][run] / [US-BLD-05][api] What an approved Builder save leaves behind: `local` moves
 * and `production` does not, the version says `builder`, one audit row names the person, a retry or a
 * race changes nothing it should not, and a trial costs at most the trial budget (issue #1847 slice 4).
 */
import { randomUUID } from 'node:crypto';

import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { draftBody } from '../../adapters/checker/checker.contract';
import { InMemoryRunStore } from '../../../runs/memory-store';
import { callContextOf } from '../../testing/context';
import {
  gatedInputs,
  WORKSPACE,
  builderDoor,
  scriptedModel,
  toolUse,
  type Door,
  type GatedTool,
} from './harness';

const PERSON = callContextOf(WORKSPACE, 'builder', 'principal-builder', 'user-builder');
const NEW_AGENT = { body: draftBody('Refund desk', ['crm']) };

afterEach(() => {
  vi.unstubAllEnvs();
});

const freshDoor = () =>
  builderDoor({
    runStore: new InMemoryRunStore(),
    scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
  });

/** A run the person approved `tool(input)` for: it pauses, the person approves, the continuation runs. */
async function approvedFor(
  door: Door,
  tool: Parameters<typeof toolUse>[0],
  input: Record<string, unknown>,
) {
  const script = { turns: [{ toolUses: [toolUse(tool, input)] }, { text: 'Done.' }] };
  const model = await scriptedModel(`builder-save-${randomUUID()}`, script);
  const paused = await door.start({ role: 'builder' }, model);
  await door.runScripted(paused.token, model, { gated: true });
  const decided = await door.decide(paused.runId, 'approve');
  return door.start({ role: 'builder' }, model, decided.runId);
}

/** Approves `input` for a new run, then sends that `draft_save` to the door. */
async function approvedSave(door: Door, input: Record<string, unknown>, callId = 'save-1') {
  const run = await approvedFor(door, 'draft_save', input);
  return { run, answer: await door.call(run.token, 'draft_save', input, {}, callId) };
}

/** The versions and the `[environment, number]` pointers of an agent, as the version list shows them. */
async function listing(door: Door, agentId: unknown) {
  const store = await door.versions.forWorkspace(WORKSPACE);
  const listed = await store?.list(String(agentId));
  if (listed === null || listed === undefined) throw new Error('the agent has no version list');
  const pointers = listed.pointers.map((pointer) => [pointer.environment, pointer.number]);
  return { versions: listed.versions, pointers };
}

const edit = (agentId: string, baseVersion: number, summary: string) => ({
  agentId,
  baseVersion,
  body: draftBody(`Refund desk ${summary}`, ['crm']),
  summary,
});

async function savedAgent(door: Door) {
  const base = await door.ports.store.save(PERSON, {
    body: draftBody('Order desk', ['crm']),
  });
  if (!base.ok) throw new Error('the fixture agent was not saved');
  return base;
}

describe('[US-BLD-03][api][run] an approved draft_save', () => {
  it('[US-BLD-03][api][run] moves local to the new version, leaves production alone and says it came from the builder', async () => {
    const door = freshDoor();
    const base = await savedAgent(door);
    const [first] = (await listing(door, base.agentId)).versions;
    door.versions.point({
      workspaceId: WORKSPACE,
      agentId: base.agentId,
      environment: 'production',
      versionId: first?.id ?? '',
      number: base.version,
      updatedAt: new Date(),
    });
    const next = edit(base.agentId, base.version, 'from the Builder');

    const { answer } = await approvedSave(door, next);

    expect(answer.result).toMatchObject({ ok: true, version: 2, pointer: 'local' });
    const { versions, pointers } = await listing(door, base.agentId);
    expect(versions.map((version) => [version.number, version.via])).toEqual([
      [1, 'builder'],
      [2, 'builder'],
    ]);
    expect(pointers).toEqual(
      expect.arrayContaining([
        ['production', 1],
        ['local', 2],
      ]),
    );
    expect(pointers).toHaveLength(2);
  });

  it('writes one agent-created audit row naming the person and the Builder run', async () => {
    const door = freshDoor();

    const { run, answer } = await approvedSave(door, NEW_AGENT);

    const created = door.auditEvents.filter((event) => event.action === 'agent-created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      actorPrincipalId: 'principal-builder',
      actorUserId: 'user-builder',
      subjectId: answer.result['agentId'],
      subjectLabel: 'Refund desk',
    });
    expect(created[0]?.details).toEqual({
      agentId: answer.result['agentId'],
      version: 1,
      via: 'builder',
      builderRunId: run.runId,
    });
  });

  it('the same callId twice gives one version, one audit row and the same result', async () => {
    const door = freshDoor();
    const run = await approvedFor(door, 'draft_save', NEW_AGENT);

    const first = await door.call(run.token, 'draft_save', NEW_AGENT, {}, 'save-1');
    const again = await door.call(run.token, 'draft_save', NEW_AGENT, {}, 'save-1');

    expect(again.result).toEqual(first.result);
    expect(door.versions.versionCount()).toBe(1);
    expect(door.auditEvents.filter((event) => event.action === 'agent-created')).toHaveLength(1);
  });

  it('refuses the second of two saves from the same base with pointer_moved, before writing a version', async () => {
    const door = freshDoor();
    const base = await savedAgent(door);
    const [a, b] = [edit(base.agentId, 1, 'first'), edit(base.agentId, 1, 'second')];

    const { answer: winner } = await approvedSave(door, a, 'save-a');
    const { answer: loser } = await approvedSave(door, b, 'save-b');

    expect(winner.result).toMatchObject({ ok: true, version: 2 });
    expect(loser.result).toMatchObject({ ok: false, code: 'pointer_moved' });
    const { versions, pointers } = await listing(door, base.agentId);
    expect(versions.map((version) => version.number)).toEqual([1, 2]);
    expect(pointers).toEqual([['local', 2]]);
  });

  it('a save that loses the compare-and-set leaves its version unpointed, never live', async () => {
    const door = freshDoor();
    const base = await savedAgent(door);

    const first = await door.ports.store.save(PERSON, edit(base.agentId, 1, 'first'));
    const second = await door.ports.store.save(PERSON, edit(base.agentId, 1, 'second'));

    expect(first).toMatchObject({ ok: true, version: 2 });
    expect(second).toEqual({ ok: false, code: 'pointer_moved', current: 2 });
    const { versions, pointers } = await listing(door, base.agentId);
    expect(versions.map((version) => version.number)).toEqual([1, 2, 3]);
    expect(pointers).toEqual([['local', 2]]);
  });
});

describe('[US-BLD-04][api][run] approval is per call', () => {
  it('trial_run is refused without an approval and starts no run', async () => {
    const door = freshDoor();
    const saved = await savedAgent(door);
    const model = await scriptedModel(`builder-none-${randomUUID()}`, { turns: [{ text: 'Hi.' }] });
    const run = await door.start({ role: 'builder' }, model);

    const answer = await door.call(run.token, 'trial_run', gatedInputs(saved).trial_run, {}, 't-1');

    expect(answer.result).toMatchObject({ ok: false, code: 'approval_required' });
    expect(door.launched).toEqual([]);
  });

  it.each(['draft_save', 'trial_run', 'evals_run'] as const satisfies readonly GatedTool[])(
    'one approval allows one %s: the same arguments under a new callId need a new approval',
    async (tool) => {
      const door = freshDoor();
      const input = gatedInputs(await savedAgent(door))[tool];
      const run = await approvedFor(door, tool, input);

      const first = await door.call(run.token, tool, input, {}, 'call-1');
      const second = await door.call(run.token, tool, input, {}, 'call-2');

      expect(first.result).toMatchObject({ ok: true });
      expect(second.result).toMatchObject({ ok: false, code: 'approval_required' });
    },
  );
});
