/**
 * Seam check 1 for S2-02d, the engine legs, kept as a regression test: `openai-agents`'
 * `MCPServerStreamableHttp` and Mastra's `MCPClient` list and call an `openapi` tool through the
 * gateway's real `POST /v1/tools/:connectorId/mcp`, authenticated by the run token, against a
 * loopback fixture API. Both SDKs are reached only through their adapters' public engines, because
 * `tests/no-sdk-import.test.ts` confines each SDK to its adapter's boundary file. The MCP SDK's own
 * client is the gateway package's `src/tools/clients.test.ts`.
 *
 * The model side is scripted: the same HTTP server answers `/v1/responses` and `/v1/messages` with
 * one tool call and then text, so the only real component on the tool path is the gateway.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { EngineFrame, EngineRunRequest } from '@agent-workspace/engine';
import { createMastraEngine } from '@agent-workspace/engine-mastra';
import { createOpenAiAgentsEngine } from '@agent-workspace/engine-openai-agents';
import {
  authorizeToolCall,
  createGatewayApplication,
  createGatewayServer,
  type ToolConnectorResolver,
} from '@agent-workspace/gateway';
import { createRunTokenCodec } from '@agent-workspace/gateway/tokens';
import { OpenApiToolConfigSchema } from '@indx-workspace/contracts/tool-connectors';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const SECRET = 'fixture-signing-secret-that-is-longer-than-32-bytes';
const CREDENTIAL = 'fixture-tool-credential-value';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const RUN = '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b';
const CONNECTOR = '66666666-6666-4666-8666-666666666666';
const PETS = '[{"id":1,"name":"Rex"}]';

type Exchange = {
  readonly client: string;
  readonly method: string;
  readonly accept: string | null;
  readonly protocolVersion: string | null;
  readonly sessionId: string | null;
  readonly status: number;
  readonly contentType: string | null;
  readonly replySessionId: string | null;
};

const exchanges: Exchange[] = [];
const upstreamAuthorization: (string | undefined)[] = [];
let client = '';
let toolName = '';
let modelTurns = 0;
let upstream: Server;
let gateway: Server;
let gatewayUrl = '';
let token = '';
const roots: string[] = [];

function sse(events: readonly Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

/** One Responses turn: a call to the connector's tool first, then text. */
function responsesTurn(index: number): string {
  const id = `resp_${String(index)}`;
  const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
  const item =
    index === 0
      ? {
          type: 'function_call',
          id: 'fc_0',
          call_id: 'call_0',
          name: toolName,
          arguments: '{}',
          status: 'completed',
        }
      : {
          type: 'message',
          id: `msg_${String(index)}`,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Listed.', annotations: [] }],
        };
  return sse([
    {
      type: 'response.created',
      response: { id, object: 'response', status: 'in_progress', output: [] },
    },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: { id, object: 'response', status: 'completed', output: [item], usage },
    },
  ]);
}

/** One Messages turn: a call to the connector's tool first, then text. */
function messagesTurn(index: number): string {
  const call = index === 0;
  return sse([
    {
      type: 'message_start',
      message: {
        id: `msg_${String(index)}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    call
      ? {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_0', name: toolName, input: {} },
        }
      : { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    call
      ? {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        }
      : { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Listed.' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ]);
}

function scriptedModel(pathname: string): Response {
  const index = modelTurns;
  modelTurns += 1;
  const body =
    pathname === '/v1/responses'
      ? responsesTurn(index)
      : pathname === '/v1/messages'
        ? messagesTurn(index)
        : null;
  return body === null
    ? Response.json({ error: { message: `no route ${pathname}` } }, { status: 404 })
    : new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

beforeAll(async () => {
  // `@ai-sdk/anthropic` reads `ANTHROPIC_BASE_URL` when the adapter first loads it.
  vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
  upstream = createServer((request, response) => {
    upstreamAuthorization.push(request.headers.authorization);
    response.setHeader('content-type', 'application/json');
    response.end(PETS);
  });
  const upstreamUrl = await listen(upstream);
  const tools: ToolConnectorResolver = {
    resolve(claims, _tokenHash, connectorId) {
      const decision = authorizeToolCall({
        tokenActive: true,
        run: { status: 'running', toolConnectorIds: [CONNECTOR] },
        connector: { workspaceId: WORKSPACE, kind: 'openapi', enabled: true },
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
            operations: [{ name: 'listPets', method: 'GET', path: '/pets' }],
          }),
          parameters: {},
          credential: () => Promise.resolve(CREDENTIAL),
        },
      });
    },
  };
  const application = createGatewayApplication({
    tokenSecret: SECRET,
    resolver: {
      resolve: () => Promise.reject(new Error('the tool route must not resolve a model key')),
    },
    tools,
  });
  gateway = createGatewayServer({
    routes: application.routes,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith('/v1/tools/')) return scriptedModel(pathname);
      const response = await application.fetch(request);
      exchanges.push({
        client,
        method: request.method,
        accept: request.headers.get('accept'),
        protocolVersion: request.headers.get('mcp-protocol-version'),
        sessionId: request.headers.get('mcp-session-id'),
        status: response.status,
        contentType: response.headers.get('content-type'),
        replySessionId: response.headers.get('mcp-session-id'),
      });
      return response;
    },
  });
  gatewayUrl = await listen(gateway);
  token = await createRunTokenCodec({ secret: SECRET }).issue({
    runId: RUN,
    sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
    workspaceId: WORKSPACE,
    agentId: '33333333-3333-4333-8333-333333333333',
    modelConnectionId: '44444444-4444-4444-8444-444444444444',
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    [gateway, upstream].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function runRequest(
  engine: 'openai-agents' | 'mastra',
  protocol: 'openai-responses' | 'anthropic-messages',
): EngineRunRequest {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'gateway-tool-clients-')));
  roots.push(cwd);
  return {
    runId: RUN,
    sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
    projectKey: 'tenant-a',
    cwd,
    prompt: 'List the pets.',
    engine,
    portable: {
      name: 'Pets',
      instructions: 'Use the tool.',
      model: protocol === 'anthropic-messages' ? 'claude-sonnet-4-5' : 'gpt-test',
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {
        tools: {
          type: 'http',
          url: `${gatewayUrl}/v1/tools/${CONNECTOR}/mcp`,
          headers: { authorization: `Bearer ${token}` },
        },
      },
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: {},
    session: { mode: 'fresh' },
    gateway: { baseUrl: gatewayUrl, token, protocol },
    resources: { files: [], skills: [] },
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: cwd },
  };
}

async function drain(frames: AsyncIterable<EngineFrame>): Promise<EngineFrame[]> {
  const out: EngineFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

function expectStatelessJson(label: string): void {
  const posts = exchanges.filter(
    (exchange) => exchange.client === label && exchange.method === 'POST',
  );
  expect(posts.length).toBeGreaterThanOrEqual(3);
  for (const post of posts) {
    expect(post.accept).toContain('application/json');
    expect(post.accept).toContain('text/event-stream');
    expect(post.sessionId).toBeNull();
    expect(post.replySessionId).toBeNull();
    if (post.status === 200) expect(post.contentType).toContain('application/json');
  }
  for (const other of exchanges.filter(
    (exchange) => exchange.client === label && exchange.method !== 'POST',
  )) {
    expect(other.status).toBe(405);
  }
}

describe('engine MCP clients against the gateway tool route', () => {
  it.each([
    {
      label: 'openai-agents',
      engine: 'openai-agents',
      protocol: 'openai-responses',
      name: 'listPets',
    },
    { label: 'mastra', engine: 'mastra', protocol: 'anthropic-messages', name: 'tools_listPets' },
  ] as const)(
    '$label lists and calls the tool statelessly through the run token',
    async ({ label, engine, protocol, name }) => {
      client = label;
      toolName = name;
      modelTurns = 0;
      upstreamAuthorization.length = 0;
      const start = engine === 'mastra' ? createMastraEngine() : createOpenAiAgentsEngine();
      const frames = await drain(start.start(runRequest(engine, protocol)).frames);

      expect(frames.find((frame) => frame.frame === 'agent.tool.call')).toMatchObject({
        name,
        kind: 'mcp',
      });
      expect(frames.find((frame) => frame.frame === 'agent.tool.result')).toMatchObject({
        isError: false,
        output: expect.stringContaining('Rex') as unknown,
      });
      expect(upstreamAuthorization).toEqual([`Bearer ${CREDENTIAL}`]);
      expectStatelessJson(label);
    },
    60_000,
  );
});
