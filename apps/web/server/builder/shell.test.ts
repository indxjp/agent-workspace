import crypto from 'node:crypto';

import {
  BUILDER_DEFAULT_LIMITS,
  BUILDER_REFUSAL_CODES,
  BuilderToolOutputSchemas,
} from '@indx-workspace/contracts/builder';
import { describe, expect, it, vi } from 'vitest';

import { log } from '../telemetry/logger';
import { MemoryApproval } from './adapters/approval/memory';
import { draftBody } from './adapters/checker/checker.contract';
import { MemoryPolicy } from './adapters/policy/memory';
import { MemoryAgentStore } from './adapters/store/memory';
import { EXAMPLES } from './examples/index';
import { capped, handleToolCall } from './shell';
import type { CallContext } from './ports';
import { callContextOf } from './testing/context';
import { makeMemoryPorts } from './testing/ports';
import { TOOLS } from './tools/index';
import type { ToolResult } from './tools/types';

const WORKSPACE = crypto.randomUUID();
const OWNER = crypto.randomUUID();

function call(name: string, args: unknown = {}) {
  return { name, arguments: args, callId: crypto.randomUUID() };
}

describe('handleToolCall: parsing', () => {
  it('refuses a tool that is not on the aw-control list with unknown_tool, in one journal row', async () => {
    const ports = makeMemoryPorts();
    const ctx = callContextOf(WORKSPACE, 'builder');

    const result = await handleToolCall(call('agents_delete'), ctx, ports);

    expect(result).toMatchObject({ ok: false, code: 'unknown_tool' });
    expect((await ports.audit.runCounts(ctx)).toolCalls).toBe(1);
  });

  it('counts an unknown tool toward the tool-call budget, so a model that keeps calling bad names is stopped', async () => {
    const limit = 3;
    const ports = makeMemoryPorts({ policy: new MemoryPolicy({ maxToolCallsPerRun: limit }) });
    const ctx = callContextOf(WORKSPACE, 'builder');

    for (let index = 0; index < limit; index += 1) {
      const result = await handleToolCall(call('agents_delete'), ctx, ports);
      expect(result).toMatchObject({ ok: false, code: 'unknown_tool' });
    }

    expect((await ports.audit.runCounts(ctx)).toolCalls).toBe(limit);
    const stopped = await handleToolCall(call('catalog_list'), ctx, ports);
    expect(stopped).toMatchObject({ ok: false, code: 'tool_call_limit_reached' });
  });

  it.each(['workspaceId', 'principal', 'role', 'via'])(
    'refuses an extra %s argument with invalid_arguments, in one journal row',
    async (key) => {
      const ports = makeMemoryPorts();
      const ctx = callContextOf(WORKSPACE, 'builder');

      const result = await handleToolCall(call('catalog_list', { [key]: 'x' }), ctx, ports);

      expect(result).toMatchObject({ ok: false, code: 'invalid_arguments' });
      expect((await ports.audit.runCounts(ctx)).toolCalls).toBe(1);
    },
  );
});

describe('handleToolCall: decide, run and journal', () => {
  it('returns the refusal decide() makes, with the contracts fix, in one journal row', async () => {
    const ports = makeMemoryPorts({ feature: { enabled: () => Promise.resolve(false) } });
    const ctx = callContextOf(WORKSPACE, 'builder');

    const result = await handleToolCall(call('catalog_list'), ctx, ports);

    const fix = BUILDER_REFUSAL_CODES.builder_disabled.fix;
    expect(result).toStrictEqual({ ok: false, code: 'builder_disabled', message: fix, fix });
    expect((await ports.audit.runCounts(ctx)).toolCalls).toBe(1);
  });
});

describe('handleToolCall: approval', () => {
  it("draft_save from a Builder without approval answers approval_required with details ['approve_save'] and reaches no store", async () => {
    const store = new MemoryAgentStore();
    const save = vi.spyOn(store, 'save');
    const ports = makeMemoryPorts({ store });
    const ctx = callContextOf(WORKSPACE, 'builder', OWNER);

    const result = await handleToolCall(
      call('draft_save', { body: EXAMPLES[0]?.body }),
      ctx,
      ports,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'approval_required',
      details: ['approve_save'],
    });
    expect(save).not.toHaveBeenCalled();
  });
});

describe('handleToolCall: a call id the client repeats', () => {
  it('still counts every call, so repeating the id cannot get past the tool-call limit', async () => {
    const ports = makeMemoryPorts();
    const ctx = callContextOf(WORKSPACE, 'builder', OWNER);
    const sameId = { name: 'draft_check', arguments: { body: EXAMPLES[0]?.body }, callId: 'same' };
    const { maxToolCallsPerRun } = BUILDER_DEFAULT_LIMITS;

    for (let sent = 0; sent < maxToolCallsPerRun; sent += 1) {
      expect(await handleToolCall(sameId, ctx, ports)).not.toMatchObject({
        code: 'tool_call_limit_reached',
      });
    }

    expect((await ports.audit.runCounts(ctx)).toolCalls).toBe(maxToolCallsPerRun);
    expect(await handleToolCall(sameId, ctx, ports)).toMatchObject({
      ok: false,
      code: 'tool_call_limit_reached',
    });
  });

  it('does not replay the stored result of a call id that another tool journaled', async () => {
    const ports = makeMemoryPorts();
    const ctx = callContextOf(WORKSPACE, 'builder', OWNER);
    await ports.audit.record(ctx, {
      callId: 'c-1',
      tool: 'evals_run',
      decision: 'run',
      outcome: 'ok',
      code: null,
      input: {},
      result: { ok: true, evaluation: {} },
    });

    const result = await handleToolCall(
      { name: 'draft_save', arguments: { body: EXAMPLES[0]?.body }, callId: 'c-1' },
      ctx,
      ports,
    );

    expect(result).toMatchObject({ ok: false, code: 'approval_required' });
    expect((await ports.audit.runCounts(ctx)).toolCalls).toBe(2);
  });
});

describe('handleToolCall: replay', () => {
  const stored = {
    ok: true,
    agentId: crypto.randomUUID(),
    version: 4,
    pointer: 'local',
    awCommand: 'aw x',
  };
  const record = (ports: ReturnType<typeof makeMemoryPorts>, ctx: CallContext, result: unknown) =>
    ports.audit.record(ctx, {
      callId: 'c-1',
      tool: 'draft_save',
      decision: 'run',
      outcome: 'ok',
      code: null,
      input: {},
      result,
    });

  it('returns the stored result of a successful write unchanged, and counts no new call', async () => {
    const ports = makeMemoryPorts();
    const ctx = callContextOf(WORKSPACE, 'builder', OWNER);
    await record(ports, ctx, stored);

    const result = await handleToolCall(
      { name: 'draft_save', arguments: { body: EXAMPLES[0]?.body }, callId: 'c-1' },
      ctx,
      ports,
    );

    expect(result).toStrictEqual(stored);
    expect((await ports.audit.runCounts(ctx)).toolCalls).toBe(1);
  });

  it('refuses a repeated write as builder_disabled once the feature is switched off mid-run, not the stored result', async () => {
    const feature = { on: true };
    const ports = makeMemoryPorts({ feature: { enabled: () => Promise.resolve(feature.on) } });
    const ctx = callContextOf(WORKSPACE, 'builder', OWNER);
    await record(ports, ctx, stored);
    const repeat = { name: 'draft_save', arguments: { body: EXAMPLES[0]?.body }, callId: 'c-1' };

    expect(await handleToolCall(repeat, ctx, ports)).toStrictEqual(stored);
    feature.on = false;
    const result = await handleToolCall(repeat, ctx, ports);

    const fix = BUILDER_REFUSAL_CODES.builder_disabled.fix;
    expect(result).toStrictEqual({ ok: false, code: 'builder_disabled', message: fix, fix });
  });

  it('answers internal_error, logged, for a stored result its schema does not accept', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const ports = makeMemoryPorts();
    const ctx = callContextOf(WORKSPACE, 'builder', OWNER);
    await record(ports, ctx, { ok: true, agentId: 'not-a-uuid' });

    const result = await handleToolCall(
      { name: 'draft_save', arguments: { body: EXAMPLES[0]?.body }, callId: 'c-1' },
      ctx,
      ports,
    );

    expect(result).toMatchObject({ ok: false, code: 'internal_error' });
    expect(error).toHaveBeenCalledTimes(1);
    // The stored call and the failed repeat of its id: both count.
    expect((await ports.audit.runCounts(ctx)).toolCalls).toBe(2);
    error.mockRestore();
  });
});

describe('handleToolCall: unexpected failures', () => {
  const INTERNAL = {
    ok: false,
    code: 'internal_error',
    message: 'The tool failed. Try again or stop.',
  };

  it('turns a throwing port into internal_error: one log line, no secret, one journal row', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const boom = new Error('upstream said tok_live_FAKE_TOKEN');
    const ports = makeMemoryPorts({ policy: { limits: () => Promise.reject(boom) } });
    const ctx = callContextOf(WORKSPACE, 'builder');

    const result = await handleToolCall(call('catalog_list'), ctx, ports);

    expect(result).toStrictEqual(INTERNAL);
    expect(JSON.stringify(result)).not.toContain('tok_live_FAKE_TOKEN');
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toStrictEqual({
      op: 'builder.tool',
      tool: 'catalog_list',
      runId: ctx.runId,
      workspaceId: WORKSPACE,
      traceId: ctx.traceId,
      errorName: 'Error',
    });
    expect(JSON.stringify(error.mock.calls[0]?.[1])).not.toContain('tok_live_FAKE_TOKEN');
    expect((await ports.audit.runCounts(ctx)).toolCalls).toBe(1);
    error.mockRestore();
  });

  it('turns a throwing executor into internal_error: one log line, one journal row', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const boom = new Error('executor broke');
    const executor = vi.spyOn(TOOLS, 'catalog_list').mockRejectedValue(boom);
    const ports = makeMemoryPorts();
    const ctx = callContextOf(WORKSPACE, 'builder');

    expect(await handleToolCall(call('catalog_list'), ctx, ports)).toStrictEqual(INTERNAL);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ op: 'builder.tool', errorName: 'Error' });
    expect((await ports.audit.runCounts(ctx)).toolCalls).toBe(1);
    executor.mockRestore();
    error.mockRestore();
  });

  it.each(['before', 'during'])(
    'stops a request aborted %s fact gathering before any tool runs',
    async (when) => {
      const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
      const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
      const executor = vi.spyOn(TOOLS, 'catalog_list');
      const controller = new AbortController();
      if (when === 'before') controller.abort();
      const ports = makeMemoryPorts({ policy: { limits: () => new Promise(() => undefined) } });
      const ctx = callContextOf(WORKSPACE, 'builder');

      const pending = handleToolCall(call('catalog_list'), ctx, ports, controller.signal);
      controller.abort();

      expect(await pending).toStrictEqual(INTERNAL);
      expect(executor).not.toHaveBeenCalled();
      expect((await ports.audit.runCounts(ctx)).toolCalls).toBe(1);
      expect(error).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0]?.[1]).toMatchObject({ op: 'builder.tool.aborted' });
      executor.mockRestore();
      info.mockRestore();
      error.mockRestore();
    },
  );
});

describe('capped', () => {
  const many = Array.from({ length: 200 }, (_, i) => `connector:missing-${String(i)}`);
  const awCommand = 'aw skills list';
  /** One over-limit output per tool with an array, each checked against its own contracts schema. */
  const outputs = {
    catalog_list: {
      ok: true,
      entries: many.map((name, i) => ({ kind: 'skills', id: String(i), name })),
      awCommand,
    },
    examples_get: { ok: true, names: many, awCommand },
    draft_check: {
      ok: true,
      valid: false,
      problems: many.map((message) => ({ code: 'missing', message })),
      awCommand,
    },
    evals_run: {
      ok: true,
      score: 0,
      total: 20,
      passed: 0,
      failed: 20,
      failures: many.map((name) => ({ name, reason: 'contains' })),
      cases: many.slice(0, 20).map((name) => ({ name, passed: false })),
      awCommand,
    },
  } as const;
  const failed: ToolResult = {
    ok: false,
    code: 'agent_definition_references_missing',
    message: 'Missing.',
    details: many,
  };
  const limit = () =>
    new MemoryPolicy({ toolOutputMaxBytes: 512 })
      .limits(callContextOf(WORKSPACE, 'builder'))
      .then((limits) => limits.toolOutputMaxBytes);

  it.each(Object.keys(outputs) as (keyof typeof outputs)[])(
    'cuts a %s output to the limit, and the cut output still parses with its schema',
    async (tool) => {
      const schema = BuilderToolOutputSchemas[tool];
      const result: ToolResult = schema.parse(outputs[tool]);
      const maxBytes = await limit();
      const cut = capped(result, maxBytes);
      expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(maxBytes);
      expect(schema.parse(cut)).toMatchObject({ truncated: true });
      expect(Object.keys(cut).sort()).toEqual([...Object.keys(result), 'truncated'].sort());
      expect(capped(result, Number.MAX_SAFE_INTEGER)).toBe(result);
    },
  );

  it('cuts a failure the same way, keeping its keys', async () => {
    const maxBytes = await limit();
    const cut = capped(failed, maxBytes);
    expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(maxBytes);
    expect(Object.keys(cut).sort()).toEqual([...Object.keys(failed), 'truncated'].sort());
  });
});

describe('handleToolCall: the workspace creation quota', () => {
  it("a person's creation counts toward the workspace quota", async () => {
    const approval = new MemoryApproval();
    const policy = new MemoryPolicy({ creationsPerWorkspacePerDay: 1 });
    const ports = makeMemoryPorts({ approval, policy });
    const ctx = callContextOf(WORKSPACE, 'builder', OWNER);
    const save = (name: string) => {
      const args = { body: draftBody(name) };
      approval.approve(ctx, { tool: 'draft_save', arguments: args });
      return handleToolCall(call('draft_save', args), ctx, ports);
    };

    expect(await save('First')).toMatchObject({ ok: true });
    expect(await save('Second')).toMatchObject({ ok: false, code: 'quota_exceeded' });
  });
});
