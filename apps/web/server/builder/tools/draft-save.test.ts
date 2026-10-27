import crypto from 'node:crypto';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import {
  BUILDER_DEFAULT_LIMITS,
  BUILDER_REFUSAL_CODES,
  BuilderToolInputSchemas,
} from '@indx-workspace/contracts/builder';
import { describe, expect, it, vi } from 'vitest';

import { MemoryApproval } from '../adapters/approval/memory';
import { MemoryAudit } from '../adapters/audit/memory';
import { draftBody } from '../adapters/checker/checker.contract';
import { MemoryChecker } from '../adapters/checker/memory';
import { MemoryAgentStore } from '../adapters/store/memory';
import type { AgentStorePort } from '../ports';
import { handleToolCall } from '../shell';
import { callContextOf } from '../testing/context';
import { makeMemoryPorts } from '../testing/ports';
import { log } from '../../telemetry/logger';

const WORKSPACE = crypto.randomUUID();
const PERSON = crypto.randomUUID();

describe('draft_save through the shell', () => {
  it('asks for approval and saves nothing; once approved it saves once on local, via builder, with one agent-created row', async () => {
    const approval = new MemoryApproval();
    const store = new MemoryAgentStore();
    const save = vi.spyOn(store, 'save');
    const ports = makeMemoryPorts({ approval, store });
    const ctx = callContextOf(WORKSPACE, 'builder', PERSON);
    const args = { body: draftBody('Refunds') };

    const asked = await handleToolCall(
      { name: 'draft_save', arguments: args, callId: 'c-1' },
      ctx,
      ports,
    );

    expect(asked).toMatchObject({ ok: false, code: 'approval_required' });
    expect(asked).toMatchObject({ fix: BUILDER_REFUSAL_CODES.approval_required.fix });
    expect(save).not.toHaveBeenCalled();
    expect(store.auditEvents(WORKSPACE)).toEqual([]);

    approval.approve(ctx, { tool: 'draft_save', arguments: args });
    const saved = await handleToolCall(
      { name: 'draft_save', arguments: args, callId: 'c-2' },
      ctx,
      ports,
    );

    expect(saved).toMatchObject({ ok: true, version: 1, pointer: 'local' });
    const agentId = (saved as { agentId: string }).agentId;
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.inspect(WORKSPACE, agentId)).toEqual({
      versions: [{ number: 1, via: 'builder', createdByPrincipalId: PERSON }],
      local: 1,
      production: null,
    });
    expect(store.auditEvents(WORKSPACE)).toMatchObject([
      {
        action: 'agent-created',
        subjectId: agentId,
        actorPrincipalId: PERSON,
        details: { agentId, version: 1, via: 'builder', builderRunId: ctx.runId },
      },
    ]);
  });
});

/** A workspace with one agent the caller owns, at version 1 on `local`, saved the way the store does. */
async function ownedAgent() {
  const approval = new MemoryApproval();
  const store = new MemoryAgentStore();
  const ctx = callContextOf(WORKSPACE, 'builder', PERSON);
  const created = await store.save(ctx, { body: draftBody('Refunds') });
  if (!created.ok) throw new Error('the memory store creates the agent');
  const { agentId } = created;
  const ports = makeMemoryPorts({
    approval,
    store,
    authorization: {
      access: () => Promise.resolve('allowed'),
      creator: () => Promise.resolve({ kind: 'builder' }),
      target: () => Promise.resolve(null),
    },
    checker: new MemoryChecker(
      new Set(),
      new Map([[agentId, { versions: 1, ownerPrincipalId: PERSON }]]),
    ),
  });
  const save = async (callId: string, baseVersion: number, name = 'Refunds') => {
    const args = { agentId, baseVersion, body: draftBody(name) };
    approval.approve(ctx, { tool: 'draft_save', arguments: args });
    return handleToolCall({ name: 'draft_save', arguments: args, callId }, ctx, ports);
  };
  return { approval, store, ctx, ports, agentId, save };
}

describe('draft_save approval', () => {
  it('is bound to the arguments as the model sent them, before the schema fills in defaults', async () => {
    const approval = new MemoryApproval();
    const ports = makeMemoryPorts({ approval });
    const ctx = callContextOf(WORKSPACE, 'builder', PERSON);
    const raw = { body: { definition: draftBody('Refunds').definition } };
    expect(canonicalCall('t', raw)).not.toBe(
      canonicalCall('t', BuilderToolInputSchemas.draft_save.parse(raw)),
    );
    approval.approve(ctx, { tool: 'draft_save', arguments: raw });

    const result = await handleToolCall(
      { name: 'draft_save', arguments: raw, callId: 'c-1' },
      ctx,
      ports,
    );

    expect(result).toMatchObject({ ok: true, version: 1 });
  });
});

describe('draft_save approval is good for one save', () => {
  it('asks again for the same approved arguments under a new call id, and saves nothing', async () => {
    const approval = new MemoryApproval();
    const store = new MemoryAgentStore();
    const save = vi.spyOn(store, 'save');
    const ports = makeMemoryPorts({ approval, store });
    const ctx = callContextOf(WORKSPACE, 'builder', PERSON);
    const args = { body: draftBody('Refunds') };
    approval.approve(ctx, { tool: 'draft_save', arguments: args });

    const first = await handleToolCall(
      { name: 'draft_save', arguments: args, callId: 'c-1' },
      ctx,
      ports,
    );
    const again = await handleToolCall(
      { name: 'draft_save', arguments: args, callId: 'c-2' },
      ctx,
      ports,
    );

    expect(first).toMatchObject({ ok: true, version: 1 });
    expect(again).toMatchObject({
      ok: false,
      code: 'approval_required',
      details: ['approve_save'],
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('a save that throws is journaled as error and spends the approval', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const approval = new MemoryApproval();
    const audit = new MemoryAudit();
    const journaled = vi.spyOn(audit, 'record');
    const store: AgentStorePort = {
      localVersion: () => Promise.resolve(null),
      creationsSince: () => Promise.resolve(0),
      save: () => Promise.reject(new Error('connection reset')),
    };
    const ports = makeMemoryPorts({ approval, store, audit });
    const ctx = callContextOf(WORKSPACE, 'builder', PERSON);
    const args = { body: draftBody('Refunds') };
    approval.approve(ctx, { tool: 'draft_save', arguments: args });
    const call = { name: 'draft_save', arguments: args, callId: 'c-1' };

    const failed = await handleToolCall(call, ctx, ports);
    const retried = await handleToolCall({ ...call, callId: 'c-2' }, ctx, ports);

    expect(failed).toMatchObject({ ok: false, code: 'internal_error' });
    expect(journaled.mock.calls.find(([, entry]) => entry.callId === 'c-1')?.[1].outcome).toBe(
      'error',
    );
    expect(retried).toMatchObject({ ok: false, code: 'approval_required' });
    error.mockRestore();
  });

  it('lets exactly one of two concurrent calls with the same approved arguments save', async () => {
    const approval = new MemoryApproval();
    const store = new MemoryAgentStore();
    const save = vi.spyOn(store, 'save');
    const ports = makeMemoryPorts({ approval, store });
    const ctx = callContextOf(WORKSPACE, 'builder', PERSON);
    const args = { body: draftBody('Refunds') };
    approval.approve(ctx, { tool: 'draft_save', arguments: args });

    const results = await Promise.all(
      ['c-1', 'c-2', 'c-3'].map((callId) =>
        handleToolCall({ name: 'draft_save', arguments: args, callId }, ctx, ports),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: 'approval_required' }),
      expect.objectContaining({ code: 'approval_required' }),
    ]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps an oversize approved save from blocking a different approved draft, and not the same one', async () => {
    const approval = new MemoryApproval();
    const ports = makeMemoryPorts({ approval });
    const ctx = callContextOf(WORKSPACE, 'builder', PERSON);
    const base = draftBody('Big');
    const big = {
      body: {
        ...base,
        definition: {
          ...base.definition,
          agent: {
            ...base.definition.agent,
            instructions: 'x'.repeat(BUILDER_DEFAULT_LIMITS.toolOutputMaxBytes + 1),
          },
        },
      },
    };
    const other = { body: draftBody('Other') };
    for (const args of [big, other]) approval.approve(ctx, { tool: 'draft_save', arguments: args });
    const send = (args: unknown, callId: string) =>
      handleToolCall({ name: 'draft_save', arguments: args, callId }, ctx, ports);

    expect(await send(big, 'c-1')).toMatchObject({ ok: true });
    expect(await send(other, 'c-2')).toMatchObject({ ok: true });
    expect(await send(big, 'c-3')).toMatchObject({ ok: false, code: 'approval_required' });
  });
});

describe('draft_save on an existing agent', () => {
  it('saves the next version on local, never touches production, and leaves the audit to the pointer move: no second agent-created row', async () => {
    const { store, agentId, save } = await ownedAgent();
    store.seedProduction(WORKSPACE, agentId, 1);

    expect(await save('c-1', 1, 'Refunds v2')).toMatchObject({ ok: true, agentId, version: 2 });

    expect(store.inspect(WORKSPACE, agentId)).toMatchObject({ local: 2, production: 1 });
    expect(store.auditEvents(WORKSPACE)).toHaveLength(1);
  });

  it('refuses pointer_moved before saving when local is no longer at baseVersion', async () => {
    const { store, agentId, save } = await ownedAgent();
    await save('c-1', 1, 'Refunds v2');
    const save2 = vi.spyOn(store, 'save');

    const result = await save('c-2', 1, 'Refunds v3');

    expect(result).toMatchObject({ ok: false, code: 'pointer_moved', details: ['current:2'] });
    expect(save2).not.toHaveBeenCalled();
    expect(store.inspect(WORKSPACE, agentId).versions).toHaveLength(2);
  });

  it('maps a pointer that moves during the save to pointer_moved, leaving the new version unpointed', async () => {
    const { store, agentId, save } = await ownedAgent();
    await save('c-1', 1, 'Refunds v2');
    vi.spyOn(store, 'localVersion').mockResolvedValueOnce(1);

    const result = await save('c-2', 1, 'Refunds v3');

    expect(result).toMatchObject({
      ok: false,
      code: 'pointer_moved',
      details: ['current:2'],
      fix: BUILDER_REFUSAL_CODES.pointer_moved.fix,
    });
    const state = store.inspect(WORKSPACE, agentId);
    expect(state.versions).toHaveLength(3);
    expect(state.local).toBe(2);
  });

  it('refuses a built-in agent with builtin_agent_read_only and writes no version', async () => {
    const { store, agentId, save } = await ownedAgent();
    store.markBuiltin(WORKSPACE, agentId);

    expect(await save('c-1', 1)).toMatchObject({ ok: false, code: 'builtin_agent_read_only' });

    expect(store.inspect(WORKSPACE, agentId).versions).toHaveLength(1);
  });
});

describe('draft_save replay and answered ids', () => {
  it('answers the same call id twice with one version, one audit row and equal results', async () => {
    const approval = new MemoryApproval();
    const store = new MemoryAgentStore();
    const audit = new MemoryAudit();
    const save = vi.spyOn(store, 'save');
    const ports = makeMemoryPorts({ approval, store, audit });
    const ctx = callContextOf(WORKSPACE, 'builder', PERSON);
    const args = { body: draftBody('Refunds') };
    approval.approve(ctx, { tool: 'draft_save', arguments: args });
    const call = { name: 'draft_save', arguments: args, callId: 'c-1' };

    const first = await handleToolCall(call, ctx, ports);
    const second = await handleToolCall(call, ctx, ports);

    expect(second).toEqual(first);
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.auditEvents(WORKSPACE)).toHaveLength(1);
    // The call and the claim of its approval.
    expect((await audit.runCounts(ctx)).toolCalls).toBe(2);
  });

  it('asks for approval again after a transient failure, because the failed write spent it', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const approval = new MemoryApproval();
    const store = new MemoryAgentStore();
    const audit = new MemoryAudit();
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('connection reset'));
    const ports = makeMemoryPorts({ approval, store, audit });
    const ctx = callContextOf(WORKSPACE, 'builder', PERSON);
    const args = { body: draftBody('Refunds') };
    approval.approve(ctx, { tool: 'draft_save', arguments: args });
    const call = { name: 'draft_save', arguments: args, callId: 'c-1' };

    const failed = await handleToolCall(call, ctx, ports);
    const retried = await handleToolCall(call, ctx, ports);

    expect(failed).toMatchObject({ ok: false, code: 'internal_error' });
    expect(retried).toMatchObject({ ok: false, code: 'approval_required' });
    expect(store.auditEvents(WORKSPACE)).toHaveLength(0);
    error.mockRestore();
  });

  it('answers the ids the store answered, not anything the arguments say', async () => {
    const approval = new MemoryApproval();
    const answered = { ok: true as const, agentId: crypto.randomUUID(), version: 7 };
    const store: AgentStorePort = {
      localVersion: () => Promise.resolve(null),
      creationsSince: () => Promise.resolve(0),
      save: () => Promise.resolve(answered),
    };
    const ports = makeMemoryPorts({ approval, store });
    const ctx = callContextOf(WORKSPACE, 'builder', PERSON);
    const args = { body: draftBody('Refunds') };
    approval.approve(ctx, { tool: 'draft_save', arguments: args });

    const result = await handleToolCall(
      { name: 'draft_save', arguments: args, callId: 'c-1' },
      ctx,
      ports,
    );

    expect(result).toMatchObject({ ok: true, agentId: answered.agentId, version: 7 });
  });
});

describe('draft_save contract and checks', () => {
  it('has no environment argument: the schema omits it and one that is sent is invalid', async () => {
    expect(Object.keys(BuilderToolInputSchemas.draft_save.shape)).not.toContain('environment');
    const ports = makeMemoryPorts();
    const ctx = callContextOf(WORKSPACE, 'builder', PERSON);

    const result = await handleToolCall(
      {
        name: 'draft_save',
        arguments: { body: draftBody('Refunds'), environment: 'production' },
        callId: 'c-1',
      },
      ctx,
      ports,
    );

    expect(result).toMatchObject({ ok: false, code: 'invalid_arguments' });
  });

  it('returns a failed check unchanged, saves nothing and counts it as a failed check', async () => {
    const approval = new MemoryApproval();
    const store = new MemoryAgentStore();
    const save = vi.spyOn(store, 'save');
    const ports = makeMemoryPorts({ approval, store });
    const ctx = callContextOf(WORKSPACE, 'builder', PERSON);
    const args = { body: draftBody('Refunds', ['crm']) };
    approval.approve(ctx, { tool: 'draft_save', arguments: args });

    const result = await handleToolCall(
      { name: 'draft_save', arguments: args, callId: 'c-1' },
      ctx,
      ports,
    );

    expect(result).toMatchObject({ ok: false, code: 'agent_definition_references_missing' });
    expect(save).not.toHaveBeenCalled();
    expect((await ports.audit.runCounts(ctx)).failedChecksInARow).toBe(1);
  });
});
