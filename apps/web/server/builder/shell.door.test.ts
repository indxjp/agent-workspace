import crypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { MemoryApproval } from './adapters/approval/memory';
import { MemoryAuthorization } from './adapters/authorization/memory';
import { draftBody } from './adapters/checker/checker.contract';
import { MemoryAgentStore } from './adapters/store/memory';
import type { CallContext } from './ports';
import { handleToolCall } from './shell';
import { callContextOf } from './testing/context';
import { makeMemoryPorts } from './testing/ports';

const WORKSPACE = crypto.randomUUID();
const PERSON = crypto.randomUUID();
const CEILING = { builder: { allow: ['planner'] } };

/** A run of `agentId` at version 1, by a Builder-role person. */
function runOf(agentId: string): CallContext {
  return callContextOf(WORKSPACE, 'builder', PERSON, null, 'run-1', {
    kind: 'run',
    agentId,
    agentVersion: 1,
  });
}

/** The save tool call for a new agent, already approved by the person. */
async function saveNewAgent(ctx: CallContext, authorization: MemoryAuthorization) {
  const approval = new MemoryApproval();
  const store = new MemoryAgentStore();
  const save = vi.spyOn(store, 'save');
  const ports = makeMemoryPorts({ approval, store, authorization });
  const args = { body: draftBody('Child') };
  approval.approve(ctx, { tool: 'draft_save', arguments: args });
  const result = await handleToolCall(
    { name: 'draft_save', arguments: args, callId: 'c-1' },
    ctx,
    ports,
  );
  return { result, save, ports };
}

describe("the door names an agent's run's caller (#1851)", () => {
  it('gets the agent creator, not the Builder: an agent the ceiling does not name is refused', async () => {
    const authorization = new MemoryAuthorization(CEILING);
    const agentId = authorization.addAgent(WORKSPACE, PERSON, {
      name: 'other',
      versions: { 1: draftBody('Other') },
    });

    const { result, save } = await saveNewAgent(runOf(agentId), authorization);

    expect(result).toMatchObject({ ok: false, code: 'not_allowed_to_build' });
    expect(save).not.toHaveBeenCalled();
  });

  it('saves for an agent the ceiling names and records which agent, version and run made it', async () => {
    const authorization = new MemoryAuthorization(CEILING);
    const agentId = authorization.addAgent(WORKSPACE, PERSON, {
      name: 'planner',
      versions: { 1: draftBody('Planner') },
    });

    const { result, save } = await saveNewAgent(runOf(agentId), authorization);

    expect(result).toMatchObject({ ok: true, version: 1 });
    expect(save.mock.calls[0]?.[1]).toMatchObject({ createdByAgent: { agentId, version: 1 } });
  });

  it('refuses an agent that was itself made by an agent, even if the ceiling names it', async () => {
    const authorization = new MemoryAuthorization(CEILING);
    const agentId = authorization.addAgent(WORKSPACE, PERSON, {
      name: 'planner',
      versions: { 1: draftBody('Planner') },
      createdByAgent: { agentId: crypto.randomUUID(), version: 1, runId: 'run-0' },
    });

    const { result } = await saveNewAgent(runOf(agentId), authorization);

    expect(result).toMatchObject({ ok: false, code: 'not_allowed_to_build' });
  });

  it('keeps the Builder agent a Builder: no lineage is recorded', async () => {
    const authorization = new MemoryAuthorization(CEILING);
    const builderId = authorization.addAgent(WORKSPACE, PERSON, {
      name: 'builder',
      builtin: 'builder',
    });

    const { result, save } = await saveNewAgent(runOf(builderId), authorization);

    expect(result).toMatchObject({ ok: true, version: 1 });
    expect(save.mock.calls[0]?.[1]).not.toHaveProperty('createdByAgent');
  });

  it('refuses a run whose agent cannot be resolved, never falling back to the Builder', async () => {
    const authorization = new MemoryAuthorization(CEILING);

    const { result, save } = await saveNewAgent(runOf(crypto.randomUUID()), authorization);

    expect(result).toMatchObject({ ok: false, code: 'not_permitted' });
    expect(save).not.toHaveBeenCalled();
  });

  it('answers a switched-off feature before an unresolved caller', async () => {
    const authorization = new MemoryAuthorization(CEILING);
    const ports = makeMemoryPorts({
      authorization,
      feature: { enabled: () => Promise.resolve(false) },
    });

    const result = await handleToolCall(
      { name: 'catalog_list', arguments: {}, callId: 'c-1' },
      runOf(crypto.randomUUID()),
      ports,
    );

    expect(result).toMatchObject({ ok: false, code: 'builder_disabled' });
  });
});

describe('an agent creator runs only what is no wider than itself (#1851)', () => {
  const wide = draftBody('Wide', ['erp']);
  const withTarget =
    (authorization: MemoryAuthorization) =>
    (options: Parameters<MemoryAuthorization['addAgent']>[2]) =>
      authorization.addAgent(WORKSPACE, PERSON, options);

  it.each(['trial_run', 'evals_run'] as const)(
    'refuses %s on an agent wider than the creator',
    async (tool) => {
      const authorization = new MemoryAuthorization(CEILING);
      const add = withTarget(authorization);
      const creatorId = add({ name: 'planner', versions: { 1: draftBody('Planner') } });
      const targetId = add({ name: 'wide', versions: { 1: wide } });
      const args =
        tool === 'trial_run'
          ? { agentId: targetId, version: 1, input: 'hello' }
          : {
              agentId: targetId,
              version: 1,
              cases: [{ name: 'a', input: 'hi', expect: { contains: ['ok'] } }],
            };
      const ctx = runOf(creatorId);
      const approval = new MemoryApproval();
      approval.approve(ctx, { tool, arguments: args });

      const result = await handleToolCall(
        { name: tool, arguments: args, callId: 'c-1' },
        ctx,
        makeMemoryPorts({ approval, authorization }),
      );

      expect(result).toMatchObject({ ok: false, code: 'creator_cannot_widen' });
    },
  );

  it('refuses a trial of an agent the creator made once a person widened it', async () => {
    const authorization = new MemoryAuthorization(CEILING);
    const add = withTarget(authorization);
    const creatorId = add({ name: 'planner', versions: { 1: draftBody('Planner') } });
    const childId = add({
      name: 'child',
      versions: { 1: wide },
      createdByAgent: { agentId: creatorId, version: 1, runId: 'run-0' },
    });
    const args = { agentId: childId, version: 1, input: 'hello' };
    const ctx = runOf(creatorId);
    const approval = new MemoryApproval();
    approval.approve(ctx, { tool: 'trial_run', arguments: args });

    const result = await handleToolCall(
      { name: 'trial_run', arguments: args, callId: 'c-1' },
      ctx,
      makeMemoryPorts({ approval, authorization }),
    );

    expect(result).toMatchObject({ ok: false, code: 'creator_cannot_widen' });
  });

  it('refuses a version the creator cannot read, so a missing answer never skips the rule', async () => {
    const authorization = new MemoryAuthorization(CEILING);
    const add = withTarget(authorization);
    const creatorId = add({ name: 'planner', versions: { 1: draftBody('Planner') } });
    const targetId = add({ name: 'no-versions' });
    const args = { agentId: targetId, version: 1, input: 'hello' };
    const ctx = runOf(creatorId);
    const approval = new MemoryApproval();
    approval.approve(ctx, { tool: 'trial_run', arguments: args });

    const result = await handleToolCall(
      { name: 'trial_run', arguments: args, callId: 'c-1' },
      ctx,
      makeMemoryPorts({ approval, authorization }),
    );

    expect(result).toMatchObject({ ok: false, code: 'creator_cannot_widen' });
  });
});

describe('the external door (#1851)', () => {
  const external: CallContext = {
    ...callContextOf(WORKSPACE, 'builder', PERSON),
    door: { kind: 'external' },
  };

  it('refuses a write and runs the save for nobody', async () => {
    const { result, save } = await saveNewAgent(external, new MemoryAuthorization(CEILING));

    expect(result).toMatchObject({ ok: false, code: 'read_only_client' });
    expect(save).not.toHaveBeenCalled();
  });
});
