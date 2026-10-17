/**
 * Seam check 1, the `@modelcontextprotocol/sdk` client leg, kept as a regression test: the SDK's
 * own client lists and calls a tool through the gateway's stateless endpoint over real HTTP. The
 * `openai-agents` and Mastra legs are `tests/gateway-tool-clients.test.ts`, because only the root
 * tests may reach those SDKs (through the engine adapters).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { OpenApiToolConfigSchema } from '@indx-workspace/contracts/tool-connectors';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGatewayApplication } from '../index.js';
import { createGatewayServer } from '../server.js';
import { createRunTokenCodec } from '../tokens/run-token.js';
import type { ToolConnectorResolver } from './authorize.js';

const SECRET = 'fixture-signing-secret-that-is-longer-than-32-bytes';
const CONNECTOR = '66666666-6666-4666-8666-666666666666';

type Exchange = {
  readonly method: string;
  readonly accept: string | null;
  readonly protocolVersion: string | null;
  readonly sessionId: string | null;
  readonly status: number;
  readonly contentType: string | null;
  readonly replySessionId: string | null;
};

const exchanges: Exchange[] = [];
let upstream: Server;
let gateway: Server;
let gatewayUrl = '';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

beforeAll(async () => {
  upstream = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('[{"id":1,"name":"Rex"}]');
  });
  const upstreamUrl = await listen(upstream);
  const tools: ToolConnectorResolver = {
    resolve: () =>
      Promise.resolve({
        ok: true,
        connector: {
          config: OpenApiToolConfigSchema.parse({
            spec: { digest: `sha256:${'a'.repeat(64)}`, bytes: 1 },
            baseUrl: upstreamUrl,
            auth: 'none',
            allow: ['GET /**'],
            operations: [{ name: 'listPets', method: 'GET', path: '/pets' }],
          }),
          parameters: {},
          credential: () => Promise.resolve(null),
        },
      }),
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
      const response = await application.fetch(request);
      exchanges.push({
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
});

afterAll(async () => {
  await Promise.all(
    [gateway, upstream].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe('the MCP SDK client against the tool endpoint', () => {
  it('lists and calls a tool statelessly, with JSON replies', async () => {
    const token = await createRunTokenCodec({ secret: SECRET }).issue({
      runId: '11111111-1111-4111-8111-111111111111',
      sessionId: '55555555-5555-4555-8555-555555555555',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      agentId: '33333333-3333-4333-8333-333333333333',
      modelConnectionId: '44444444-4444-4444-8444-444444444444',
    });
    const client = new Client({ name: 'seam-check', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`/v1/tools/${CONNECTOR}/mcp`, gatewayUrl),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    );
    // The SDK's own client transport is its `Transport`; the two declarations differ only under this
    // repository's `exactOptionalPropertyTypes` (`get sessionId(): string | undefined` against
    // `sessionId?: string`), which is a property of the `.d.ts`, not of the object.
    await client.connect(transport as Transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(['listPets']);
    const called = await client.callTool({ name: 'listPets', arguments: {} });
    expect(called).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: '[{"id":1,"name":"Rex"}]' }],
    });
    await client.close();

    // The recorded facts: every POST accepts JSON and SSE; after `initialize` the client sends the
    // negotiated protocol version; no session id is ever asked for or handed out; every reply to a
    // request is JSON. The client's optional standalone SSE GET is answered 405, which the SDK
    // treats as "no server stream".
    const posts = exchanges.filter((exchange) => exchange.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(4);
    for (const post of posts) {
      expect(post.accept).toBe('application/json, text/event-stream');
      expect(post.sessionId).toBeNull();
      expect(post.replySessionId).toBeNull();
    }
    expect(posts[0]?.protocolVersion).toBeNull();
    for (const post of posts.slice(1)) expect(post.protocolVersion).toBe('2025-11-25');
    for (const post of posts.filter((p) => p.status === 200)) {
      expect(post.contentType).toContain('application/json');
    }
    for (const get of exchanges.filter((exchange) => exchange.method === 'GET')) {
      expect(get.status).toBe(405);
    }
  });
});
