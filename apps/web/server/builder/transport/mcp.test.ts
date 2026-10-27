import { createRunTokenCodec } from '@agent-workspace/gateway/tokens';
import { BUILDER_TOOL_NAMES } from '@indx-workspace/contracts/builder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunTokenDatabase } from '../../gateway/run-token-verifier';
import type { DirectoryRoot } from '../../rbac/directory';
import { log } from '../../telemetry/logger';
import { callContextOf } from '../testing/context';
import { makeMemoryPorts } from '../testing/ports';
import type { CallContext } from '../ports';
import type { BuilderPorts } from '../tools/types';
import type { BuilderRunReader } from './call-context';
import {
  createBuilderCallerVerifier,
  serveBuilderMcp,
  type BuilderCallerVerifier,
  type BuilderDoor,
} from './mcp';

const RUN_IDENTITY = {
  kind: 'run',
  workspaceId: 'ws-secret-id',
  runId: 'run-secret-id',
  sessionId: 'session-1',
  agentId: 'agent-1',
} as const;

const CALLER = {
  ok: true,
  caller: {
    ...RUN_IDENTITY,
    kind: 'run-caller',
    principalId: 'principal-secret-sub',
    userId: 'user-1',
    role: 'builder',
  },
} as const;

const allow: BuilderCallerVerifier = () => Promise.resolve(CALLER);
const readOnly: BuilderCallerVerifier = () =>
  Promise.resolve({ ok: false, code: 'no_caller', reads: true, run: RUN_IDENTITY });
const refuse: BuilderCallerVerifier = () =>
  Promise.resolve({ ok: false, code: 'not_permitted', reads: false });

function rpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/builder/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token', ...headers },
    body: JSON.stringify(body),
  });
}

const call = (method: string, params?: unknown): unknown => ({
  jsonrpc: '2.0',
  id: 7,
  method,
  ...(params === undefined ? {} : { params }),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const readRun = vi.fn<BuilderRunReader>(() =>
  Promise.resolve({
    modelId: 'model-1',
    agentVersion: { id: 'version-1', number: 1, summary: 'v1' },
  }),
);

/** The door with no ports (every call `builder_disabled`) unless a test gives some. */
const door = (
  verifyCaller: BuilderCallerVerifier,
  more: Partial<BuilderDoor> = {},
): BuilderDoor => ({
  verifyCaller,
  ports: null,
  readRun,
  ...more,
});

/** Memory ports, switched on, whose every method call is recorded in `reached` as (port, method, ...args). */
function spyPorts() {
  const inner = makeMemoryPorts();
  const reached = vi.fn<(port: string, method: string, ...args: unknown[]) => void>();
  const wrap = (name: string, port: object) =>
    new Proxy(port, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          reached(name, String(key), ...args);
          const result: unknown = Reflect.apply(value, target, args);
          return result;
        };
      },
    });
  const ports = Object.fromEntries(
    Object.entries(inner).map(([name, port]) => [name, wrap(name, port)]),
  ) as unknown as BuilderPorts;
  // The journal of the run the test tokens name.
  const ctx = { ...callContextOf(RUN_IDENTITY.workspaceId, 'builder'), runId: RUN_IDENTITY.runId };
  const journalled = async () => (await inner.audit.runCounts(ctx)).toolCalls;
  return { ports, reached, journalled };
}

/** The ctx the shell handed the ports, read off the first port call. */
function ctxOf(reached: ReturnType<typeof spyPorts>['reached']): CallContext {
  return reached.mock.calls[0]?.[2] as CallContext;
}

async function toolAnswer(response: Response) {
  const text = await response.text();
  const body = JSON.parse(text) as {
    result: { isError: boolean; content: Array<{ type: string; text: string }> };
  };
  const [content] = body.result.content;
  return {
    text,
    isError: body.result.isError,
    result: JSON.parse(content?.text ?? 'null') as unknown,
  };
}

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
      const logged = (['log', 'error', 'warn', 'info'] as const).map((level) =>
        vi.spyOn(console, level),
      );
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

  const recordedIds = (reached: ReturnType<typeof spyPorts>['reached']) =>
    reached.mock.calls
      .filter(([port, method]) => port === 'audit' && method === 'record')
      .map((args) => (args[3] as { callId: string }).callId);

  it("journals the engine's tool-use id as the call id, so a retry is the same call", async () => {
    const { ports, reached } = spyPorts();
    const params = {
      name: 'catalog_list',
      arguments: {},
      _meta: { 'claudecode/toolUseId': 'toolu_01' },
    };
    for (let i = 0; i < 2; i += 1) {
      await serveBuilderMcp(rpc(call('tools/call', params)), door(allow, { ports }));
    }
    // The repeat is not stored under the taken id, so it is journaled again under a derived one.
    const ids = recordedIds(reached);
    expect(ids.slice(0, 2)).toEqual(['toolu_01', 'toolu_01']);
    expect(ids).toHaveLength(3);
    expect(ids[2]).toMatch(/^toolu_01:[0-9a-f-]{36}$/);
  });

  it.each([
    ['another _meta key', { _meta: { callId: 'client-id' } }],
    ['an empty id', { _meta: { 'claudecode/toolUseId': '' } }],
    ['an id over 128 characters', { _meta: { 'claudecode/toolUseId': 'x'.repeat(129) } }],
    ['an id that is not a string', { _meta: { 'claudecode/toolUseId': 7 } }],
  ])('mints a fresh call id per call when the request carries %s', async (_label, meta) => {
    const { ports, reached, journalled } = spyPorts();
    const params = { name: 'catalog_list', arguments: {}, ...meta };
    for (let i = 0; i < 2; i += 1) {
      await serveBuilderMcp(rpc(call('tools/call', params)), door(allow, { ports }));
    }
    const ids = recordedIds(reached);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).not.toMatch(/^(client-id|7)$/);
    expect(await journalled()).toBe(2);
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
    const logged = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'info'),
    ];
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

describe('the real verifier behind the door', () => {
  const database = new Proxy({} as RunTokenDatabase, {
    get() {
      throw new Error('the database must not be read for a token that does not verify');
    },
  });
  const directory = {
    forWorkspace() {
      throw new Error('the directory must not be read for a token that does not verify');
    },
  } as unknown as DirectoryRoot;
  const tokens = createRunTokenCodec({ secret: 'mcp-door-test-secret-at-least-thirty-two-bytes' });
  const verifyCaller = createBuilderCallerVerifier({
    tokens,
    database,
    directory,
    agents: {
      forWorkspace() {
        throw new Error('the agents must not be read for a token that does not verify');
      },
    },
    ceiling: null,
  });

  for (const [label, headers] of [
    ['a request with only a session cookie', { authorization: '', cookie: 'aw_session=abc' }],
    ['an API key', { authorization: 'Bearer ak_live_0123456789' }],
    ['an unsigned bearer', { authorization: 'Bearer not-a-run-token' }],
  ] as const) {
    it(`refuses ${label} with 403 not_permitted`, async () => {
      const request = rpc(call('tools/list'), headers);
      if (headers.authorization === '') request.headers.delete('authorization');
      const response = await serveBuilderMcp(request, door(verifyCaller));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'not_permitted' } });
    });
  }

  it.each([
    ['no credential', { authorization: '' }],
    ['a session cookie', { authorization: '', cookie: 'aw_session=abc' }],
    ['an API key', { authorization: 'Bearer ak_live_0123456789' }],
    ['an unsigned bearer', { authorization: 'Bearer not-a-run-token' }],
  ])(
    'refuses a draft_save with %s before any port, and writes nothing',
    async (_label, headers) => {
      const { ports, reached, journalled } = spyPorts();
      const request = rpc(
        call('tools/call', {
          name: 'draft_save',
          arguments: { body: {} },
          _meta: { 'claudecode/toolUseId': 'toolu_01' },
        }),
        headers,
      );
      if (headers.authorization === '') request.headers.delete('authorization');

      const response = await serveBuilderMcp(request, door(verifyCaller, { ports }));

      expect(response.status).toBe(403);
      expect(reached).not.toHaveBeenCalled();
      expect(await journalled()).toBe(0);
    },
  );

  it('refuses every call when no token secret is configured', async () => {
    const response = await serveBuilderMcp(
      rpc(call('tools/list')),
      door(createBuilderCallerVerifier(null)),
    );
    expect(response.status).toBe(403);
  });
});
