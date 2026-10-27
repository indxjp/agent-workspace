import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import { OpenApiToolConfigSchema } from '@indx-workspace/contracts/tool-connectors';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { GatewayRunResolver, GatewayUsageRecord } from '../auth.js';
import { createGatewayApplication } from '../index.js';
import { createRunTokenCodec } from '../tokens/run-token.js';
import { authorizeToolCall, type ToolConnectorResolver } from './authorize.js';

const SECRET = 'fixture-signing-secret-that-is-longer-than-32-bytes';
const CREDENTIAL = 'fixture-tool-credential-value';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const RUN_A = '11111111-1111-4111-8111-111111111111';
const CONNECTOR = '66666666-6666-4666-8666-666666666666';
const DISABLED = '77777777-7777-4777-8777-777777777777';
const RUN_B_CONNECTOR = '88888888-8888-4888-8888-888888888888';

const APPROVED_ARGUMENTS = { body: { name: 'Rex' } };

let upstream: Server;
let upstreamUrl = '';
const upstreamAuthorization: (string | undefined)[] = [];

beforeAll(async () => {
  upstream = createServer((request, response) => {
    upstreamAuthorization.push(request.headers.authorization);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([{ id: 1, name: 'Rex' }]));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function toolResolver(): ToolConnectorResolver & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve(claims, _tokenHash, connectorId) {
      calls.push(connectorId);
      const decision = authorizeToolCall({
        tokenActive: true,
        run:
          claims.runId === RUN_A
            ? { status: 'running', toolConnectorIds: [CONNECTOR, DISABLED] }
            : null,
        connector:
          connectorId === RUN_B_CONNECTOR
            ? { workspaceId: WORKSPACE, kind: 'openapi', enabled: true }
            : { workspaceId: WORKSPACE, kind: 'openapi', enabled: connectorId !== DISABLED },
        workspaceId: claims.workspaceId,
        connectorId,
      });
      if (!decision.ok) return Promise.resolve(decision);
      return Promise.resolve({
        ok: true,
        connector: {
          config: OpenApiToolConfigSchema.parse({
            spec: { digest: `sha256:${'a'.repeat(64)}`, bytes: 1 },
            baseUrl: upstreamUrl,
            auth: 'bearer',
            allow: ['GET /**'],
            operations: [
              { name: 'listPets', method: 'GET', path: '/pets' },
              { name: 'addPet', method: 'POST', path: '/pets' },
            ],
          }),
          parameters: {
            listPets: [{ name: 'limit', in: 'query', required: false }],
            addPet: [{ name: 'body', in: 'body', required: true }],
          },
          approval: {
            serverKey: 'pets',
            approvedToolCalls: [canonicalCall('mcp__pets__addPet', APPROVED_ARGUMENTS)],
            consume: () => Promise.resolve('consumed'),
          },
          credential: () => Promise.resolve(CREDENTIAL),
        },
      });
    },
  };
}

function modelResolver(): GatewayRunResolver & { readonly calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    resolve() {
      calls.push(1);
      return Promise.resolve({
        state: 'active',
        providerId: 'anthropic',
        connectionProvider: 'anthropic',
        credential: 'model-key',
      });
    },
  };
}

async function setup(toolsEnabled = true) {
  const tokens = createRunTokenCodec({ secret: SECRET });
  const token = await tokens.issue({
    runId: RUN_A,
    sessionId: '55555555-5555-4555-8555-555555555555',
    workspaceId: WORKSPACE,
    agentId: '33333333-3333-4333-8333-333333333333',
    modelConnectionId: '44444444-4444-4444-8444-444444444444',
  });
  const tools = toolResolver();
  const resolver = modelResolver();
  const recorded: GatewayUsageRecord[] = [];
  const application = createGatewayApplication({
    tokenSecret: SECRET,
    resolver,
    ...(toolsEnabled ? { tools } : {}),
    providers: {
      fetch: () =>
        Promise.resolve(
          Response.json({
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            model: 'claude-fixture',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
        ),
    },
    usage: {
      record(usage) {
        recorded.push(usage);
        return Promise.resolve();
      },
      fail: () => Promise.resolve(),
    },
  });
  return { application, token, tools, resolver, recorded };
}

function rpc(token: string | null, connectorId: string, body: unknown, method = 'POST'): Request {
  return new Request(`http://gateway/v1/tools/${connectorId}/mcp`, {
    method,
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fixture', version: '1.0.0' },
  },
};
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const CALL = {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'listPets', arguments: {} },
};

describe('POST /v1/tools/:connectorId/mcp', () => {
  it.each(['GET', 'DELETE'])('answers %s with 405 and allow: POST', async (method) => {
    const { application, token, tools } = await setup();
    const response = await application.fetch(rpc(token, CONNECTOR, null, method));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(tools.calls).toHaveLength(0);
  });

  it('initializes, lists the C17 names and calls a tool with JSON replies and no session', async () => {
    const { application, token } = await setup();
    const initialized = await application.fetch(rpc(token, CONNECTOR, INITIALIZE));
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get('content-type')).toContain('application/json');
    expect(initialized.headers.get('mcp-session-id')).toBeNull();
    expect(await initialized.json()).toMatchObject({
      result: { capabilities: { tools: {} }, serverInfo: { name: 'agent-workspace-tools' } },
    });

    const listed = await application.fetch(rpc(token, CONNECTOR, LIST));
    expect(await listed.json()).toMatchObject({
      result: { tools: [{ name: 'listPets' }, { name: 'addPet' }] },
    });

    upstreamAuthorization.length = 0;
    const called = await application.fetch(rpc(token, CONNECTOR, CALL));
    expect(await called.json()).toMatchObject({
      result: { isError: false, content: [{ type: 'text', text: '[{"id":1,"name":"Rex"}]' }] },
    });
    expect(upstreamAuthorization).toEqual([`Bearer ${CREDENTIAL}`]);
  });

  it('runs a write the run approved and refuses the same write with other arguments', async () => {
    const { application, token } = await setup();
    const write = (args: unknown) => ({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'addPet', arguments: args },
    });
    upstreamAuthorization.length = 0;
    const approved = await application.fetch(rpc(token, CONNECTOR, write(APPROVED_ARGUMENTS)));
    expect(await approved.json()).toMatchObject({ result: { isError: false } });
    expect(upstreamAuthorization).toHaveLength(1);

    upstreamAuthorization.length = 0;
    const other = await application.fetch(rpc(token, CONNECTOR, write({ body: { name: 'Max' } })));
    expect(await other.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error: { code: 'approval_required', status: 403 } },
      },
    });
    expect(upstreamAuthorization).toHaveLength(0);
  });

  it('re-authorises every request and never reaches the model resolver', async () => {
    const { application, token, tools, resolver } = await setup();
    await application.fetch(rpc(token, CONNECTOR, LIST));
    await application.fetch(rpc(token, CONNECTOR, CALL));
    expect(tools.calls).toEqual([CONNECTOR, CONNECTOR]);
    expect(resolver.calls).toHaveLength(0);
  });

  it.each([
    ['a disabled connector', DISABLED],
    ["run B's connector", RUN_B_CONNECTOR],
  ])('refuses %s with 403 tool_not_in_run', async (_name, connectorId) => {
    const { application, token } = await setup();
    const response = await application.fetch(rpc(token, connectorId, CALL));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        type: 'permission_error',
        code: 'tool_not_in_run',
        message: 'This run cannot use the requested tool connector.',
      },
    });
  });

  it('refuses a missing token with the gateway token code', async () => {
    const { application } = await setup();
    const response = await application.fetch(rpc(null, CONNECTOR, LIST));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'token_missing' } });
  });

  it('never puts the credential or the upstream URL in a response body or a log line', async () => {
    const { application, token } = await setup();
    const written: string[] = [];
    const capture = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      });
    }
    const bodies: string[] = [];
    for (const body of [INITIALIZE, LIST, CALL]) {
      bodies.push(await (await application.fetch(rpc(token, CONNECTOR, body))).text());
    }
    bodies.push(await (await application.fetch(rpc(token, DISABLED, CALL))).text());
    vi.restoreAllMocks();
    for (const text of [...bodies, ...written]) {
      expect(text).not.toContain(CREDENTIAL);
      expect(text).not.toContain(upstreamUrl);
    }
  });

  it('still meters a model request after a tool request', async () => {
    const { application, token, recorded } = await setup();
    await application.fetch(rpc(token, CONNECTOR, CALL));
    expect(recorded).toHaveLength(0);
    const response = await application.fetch(
      new Request('http://gateway/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-fixture', max_tokens: 8, messages: [] }),
      }),
    );
    expect(response.status).toBe(200);
    expect(recorded).toHaveLength(1);
  });

  it('answers the router 404 when the application has no tool resolver', async () => {
    const { application, token, resolver } = await setup(false);
    const response = await application.fetch(rpc(token, CONNECTOR, LIST));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { type: 'not_found_error' } });
    expect(resolver.calls).toHaveLength(0);
  });
});
