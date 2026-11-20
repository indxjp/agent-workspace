import { BUILDER_TOOL_NAMES } from '@indx-workspace/contracts/builder';
import { describe, expect, it, vi } from 'vitest';

import { log } from '../../telemetry/logger';
import { counterIds } from '../../ids';
import { makeMemoryPorts } from '../testing/ports';
import { serveBuilderMcp } from './mcp';
import {
  CALLER,
  RUN_IDENTITY,
  allow,
  call,
  ctxOf,
  door,
  readOnly,
  readRun,
  refuse,
  resetDoorAfterEach,
  rpc,
  spyOnConsole,
  spyPorts,
  toolAnswer,
} from './mcp.test-support';

resetDoorAfterEach();

describe('POST /api/builder/mcp (#1846)', () => {
  it('answers initialize', async () => {
    const response = await serveBuilderMcp(rpc(call('initialize')), door(allow));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { capabilities: unknown } };
    expect(body.result.capabilities).toEqual({ tools: {} });
  });

  it('lists exactly the six Builder tools, each with an object input schema', async () => {
    const response = await serveBuilderMcp(rpc(call('tools/list')), door(allow));
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string; inputSchema: { type: string } }> };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([...BUILDER_TOOL_NAMES]);
    expect(body.result.tools).toHaveLength(6);
    for (const tool of body.result.tools) expect(tool.inputSchema.type).toBe('object');
  });

  it('lets a token without a person list the tools', async () => {
    const response = await serveBuilderMcp(rpc(call('tools/list')), door(readOnly));
    expect(response.status).toBe(200);
  });

  it('answers a tool call with builder_disabled when the deployment has no ports', async () => {
    const response = await serveBuilderMcp(
      rpc(call('tools/call', { name: 'draft_save', arguments: {} })),
      door(allow),
    );
    const body = (await response.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'builder_disabled',
    });
  });

  it.each(['draft_save', 'evals_run', 'trial_run'])(
    'refuses %s with no_caller when the token has no person, and logs nothing',
    async (tool) => {
      const logged = spyOnConsole();
      const { ports, reached, journalled } = spyPorts();
      const response = await serveBuilderMcp(
        rpc(call('tools/call', { name: tool, arguments: {} }), {
          authorization: 'Bearer very-secret-token',
        }),
        door(readOnly, { ports }),
      );
      const text = await response.text();
      const body = JSON.parse(text) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(body.result.isError).toBe(true);
      expect(JSON.parse(body.result.content[0]?.text ?? '{}')).toMatchObject({
        ok: false,
        code: 'no_caller',
      });
      expect(text).not.toContain('very-secret-token');
      expect(text).not.toContain('stack');
      for (const spy of logged) expect(spy).not.toHaveBeenCalled();
      expect(reached).not.toHaveBeenCalled();
      expect(readRun).not.toHaveBeenCalled();
      expect(await journalled()).toBe(0);
    },
  );

  it.each([
    ['a person', allow],
    ['no person', readOnly],
  ] as const)(
    'refuses Draft_Save, "draft_save " and DRAFT_SAVE from %s as unknown_tool, reaching only the journal',
    async (_label, verifyCaller) => {
      for (const name of ['Draft_Save', 'draft_save ', 'DRAFT_SAVE']) {
        const { ports, reached, journalled } = spyPorts();
        const response = await serveBuilderMcp(
          rpc(call('tools/call', { name, arguments: {} })),
          door(verifyCaller, { ports }),
        );
        const answer = await toolAnswer(response);
        expect(answer.isError).toBe(true);
        expect(answer.result).toMatchObject({ ok: false, code: 'unknown_tool' });
        expect(reached.mock.calls.map(([port, method]) => `${port}.${method}`)).toEqual([
          'audit.record',
        ]);
        expect(await journalled()).toBe(1);
      }
    },
  );

  it('runs a read tool for the person behind the run and answers its result as JSON text', async () => {
    const { ports, reached, journalled } = spyPorts();
    const response = await serveBuilderMcp(
      rpc(call('tools/call', { name: 'catalog_list', arguments: {} }), {
        authorization: 'Bearer very-secret-token',
      }),
      door(allow, { ports }),
    );
    const answer = await toolAnswer(response);
    expect(answer.isError).toBe(false);
    expect(answer.result).toMatchObject({ ok: true });
    expect(answer.text).not.toContain('very-secret-token');
    expect(readRun).toHaveBeenCalledWith(CALLER.caller);
    expect(ctxOf(reached)).toMatchObject({
      workspaceId: 'ws-secret-id',
      runId: 'run-secret-id',
      modelId: 'model-1',
      promptVersion: 'version-1',
      caller: {
        kind: 'person',
        principal: { principalId: 'principal-secret-sub', userId: 'user-1', role: 'builder' },
      },
    });
    expect(await journalled()).toBe(1);
  });

  it('takes a read tool of a token without a person to the core, with no caller', async () => {
    const { ports, reached, journalled } = spyPorts();
    const response = await serveBuilderMcp(
      rpc(call('tools/call', { name: 'catalog_list', arguments: {} })),
      door(readOnly, { ports }),
    );
    // The door lets the read through; the authorization port then fails closed for nobody.
    expect((await toolAnswer(response)).result).toMatchObject({ ok: false, code: 'not_permitted' });
    expect(readRun).toHaveBeenCalledWith(RUN_IDENTITY);
    expect(ctxOf(reached).caller).toEqual({ kind: 'none' });
    expect(await journalled()).toBe(1);
  });

  it("names a call with no tool-use id from the ports' id generator (refactoring plan part 07, step 8)", async () => {
    const ports = makeMemoryPorts({ ids: counterIds() });
    const record = vi.spyOn(ports.audit, 'record');
    await serveBuilderMcp(
      rpc(call('tools/call', { name: 'catalog_list', arguments: {} })),
      door(readOnly, { ports }),
    );
    expect(record.mock.calls[0]?.[1].callId).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('answers not_permitted, reaching no port, when the run has no model or pinned version', async () => {
    const { ports, reached } = spyPorts();
    readRun.mockResolvedValueOnce(null);
    const response = await serveBuilderMcp(
      rpc(call('tools/call', { name: 'catalog_list', arguments: {} })),
      door(allow, { ports }),
    );
    const answer = await toolAnswer(response);
    expect(answer.isError).toBe(true);
    expect(answer.result).toMatchObject({ ok: false, code: 'not_permitted' });
    expect(reached).not.toHaveBeenCalled();
  });

  it('answers internal_error and logs only the run when the run cannot be read', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const { ports, reached } = spyPorts();
    readRun.mockRejectedValueOnce(new Error('postgres://user:pw@db/secret'));
    const response = await serveBuilderMcp(
      rpc(call('tools/call', { name: 'catalog_list', arguments: {} }), {
        authorization: 'Bearer very-secret-token',
      }),
      door(allow, { ports }),
    );
    const answer = await toolAnswer(response);
    expect(answer.result).toStrictEqual({
      ok: false,
      code: 'internal_error',
      message: 'The tool failed. Try again or stop.',
    });
    for (const secret of ['postgres://', 'very-secret-token', ' at ']) {
      expect(answer.text).not.toContain(secret);
    }
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toStrictEqual({
      op: 'builder.transport',
      runId: 'run-secret-id',
      workspaceId: 'ws-secret-id',
    });
    expect(reached).not.toHaveBeenCalled();
  });

  it('answers any other method with -32601', async () => {
    const response = await serveBuilderMcp(rpc(call('resources/list')), door(allow));
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it('truncates the method it echoes in a -32601 to 128 characters', async () => {
    const long = 'm'.repeat(5000);
    const response = await serveBuilderMcp(rpc(call(long)), door(allow));
    const body = (await response.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toContain('m'.repeat(128));
    expect(body.error.message).not.toContain('m'.repeat(129));
  });

  it('refuses a body over 1 MiB with 413', async () => {
    const big = 'x'.repeat(1_048_577);
    const response = await serveBuilderMcp(rpc({ ...(call('ping') as object), big }), door(allow));
    expect(response.status).toBe(413);
  });

  it('refuses a GET', async () => {
    const response = await serveBuilderMcp(
      new Request('http://localhost/api/builder/mcp'),
      door(allow),
    );
    expect(response.status).toBe(405);
  });

  it('refuses with 403 not_permitted and reveals nothing about the token or the person', async () => {
    const logged = spyOnConsole();
    const response = await serveBuilderMcp(
      rpc(call('tools/list'), { authorization: 'Bearer very-secret-token' }),
      door(refuse),
    );
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'not_permitted' } });
    for (const secret of ['very-secret-token', 'principal-secret-sub', 'ws-secret-id', ' at ']) {
      expect(text).not.toContain(secret);
    }
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });
});
