/**
 * Compose to gateway (S2-02f, #531): the `http` MCP server compose hands the engine for an
 * `openapi` connector is driven, url and headers verbatim, through `initialize`, `tools/list` and
 * `tools/call` against an in-process gateway serving a loopback fixture API. That is exactly what
 * each engine's MCP client is handed; a real model run is S2-08's.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  authorizeToolCall,
  createGatewayApplication,
  createGatewayServer,
} from '@agent-workspace/gateway';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import {
  OpenApiToolConfigSchema,
  gatewayToolPath,
} from '@indx-workspace/contracts/tool-connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { createRunTokenIssuer } from '../gateway/issuer';
import type { LaunchContext } from '../runs/environment';
import { InMemoryRunStore } from '../runs/store';
import { buildRunRequestFor } from './run-request';

const SECRET = 'compose-gateway-tools-secret-at-least-32-bytes';
const UPSTREAM_CREDENTIAL = 'fixture-orders-api-credential';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const RUN = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN = '99999999-9999-4999-8999-999999999999';
const CEILING_RUN = '88888888-8888-4888-8888-888888888888';
const SESSION = '44444444-4444-4444-8444-444444444444';
const USER = '66666666-6666-4666-8666-666666666666';
const ORDERS = '00000000-0000-4000-8000-00000000000a';

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

let upstream: Server;
let upstreamUrl = '';
let gateway: Server;
let gatewayUrl = '';
const upstreamCalls: { path: string | undefined; authorization: string | undefined }[] = [];
/**
 * What compose's snapshot sink recorded, per run: the gateway authorises against it (C16).
 * `OTHER_RUN` is active with no tool connector.
 */
const snapshots = new Map<string, readonly string[]>([[OTHER_RUN, []]]);

beforeAll(async () => {
  upstream = createServer((request, response) => {
    upstreamCalls.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: request.url?.split('/').at(-1), status: 'shipped' }));
  });
  upstreamUrl = await listen(upstream);

  const application = createGatewayApplication({
    tokenSecret: SECRET,
    resolver: {
      resolve: () => Promise.reject(new Error('the tool route must not resolve a model key')),
    },
    tools: {
      resolve(claims, _tokenHash, connectorId) {
        const toolConnectorIds = snapshots.get(claims.runId);
        const decision = authorizeToolCall({
          tokenActive: true,
          run: toolConnectorIds === undefined ? null : { status: 'running', toolConnectorIds },
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
              allow: ['GET /orders/*'],
              operations: [{ name: 'getOrder', method: 'GET', path: '/orders/{orderId}' }],
            }),
            parameters: { getOrder: [{ name: 'orderId', in: 'path', required: true }] },
            credential: () => Promise.resolve(UPSTREAM_CREDENTIAL),
          },
        });
      },
    },
  });
  gateway = createGatewayServer(application);
  gatewayUrl = await listen(gateway);
});

afterAll(async () => {
  await Promise.all([close(upstream), close(gateway)]);
});

async function launchContext(runId: string) {
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'Orders agent',
      instructions: '',
      modelConnectionId: '77777777-7777-4777-8777-777777777777',
      model: null,
      permissions: {
        readFiles: false,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    },
    { principalId: USER, userId: USER },
  );
  if (created.kind !== 'created') throw new Error(created.kind);
  const run = await new InMemoryRunStore().create({
    engine: 'claude-agent-sdk',
    id: runId,
    workspaceId: WORKSPACE,
    agentId: created.agent.id,
    sessionId: SESSION,
  });
  const context: LaunchContext = {
    run,
    agent: { id: created.agent.id, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' },
    session: { id: SESSION, agentId: created.agent.id, engine: null },
    principal: {
      principalId: USER,
      ownerPrincipalId: USER,
      userId: USER,
      workspaceId: WORKSPACE,
      scope: null,
    },
    prompt: 'where is order 42?',
  };
  return {
    context,
    runAgent: {
      agent: created.agent,
      assignments: { files: [], skillIds: [], connectorIds: [] },
      toolBundles: [],
      subagents: [],
    },
  };
}

const issuer = () =>
  createRunTokenIssuer({ baseUrl: gatewayUrl, signingSecret: SECRET, ttlSeconds: 600 });

/** Compose a run with one `openapi` connector named and keyed `orders`. */
async function composeOrdersRequest(runId: string, ceiling: ProjectPolicy | null = null) {
  const { context, runAgent } = await launchContext(runId);
  return buildRunRequestFor(
    context,
    runAgent,
    { runnerUrl: 'http://runner:8080', workspaceRoot: '/workspace' },
    issuer(),
    {},
    undefined,
    null,
    {
      load: () =>
        Promise.resolve({
          files: [],
          skills: [],
          mcpServers: {},
          toolConnectors: [
            { key: 'orders', name: 'orders', connectorId: ORDERS, operationNames: ['getOrder'] },
          ],
        }),
    },
    undefined,
    null,
    undefined,
    (snapshotRunId, ids) => {
      snapshots.set(snapshotRunId, ids);
      return Promise.resolve();
    },
    ceiling,
  );
}

/** {@link composeOrdersRequest} without a ceiling, and the `orders` gateway entry it holds. */
async function composeOrders(runId: string) {
  const request = await composeOrdersRequest(runId);
  const entry = request.portable.mcpServers['orders'];
  if (entry?.type !== 'http') throw new Error('compose did not hand over an http entry');
  return { request, entry };
}

function rpc(
  entry: { readonly url: string; readonly headers?: Readonly<Record<string, string>> | undefined },
  body: unknown,
): Promise<Response> {
  return fetch(entry.url, {
    method: 'POST',
    headers: {
      ...entry.headers,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'compose-fixture', version: '1.0.0' },
  },
};
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const CALL = {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'getOrder', arguments: { orderId: '42' } },
};

describe('a composed openapi connector answers through the gateway', () => {
  it('initializes, lists and calls the tool with only the run token, over loopback', async () => {
    const { request, entry } = await composeOrders(RUN);
    expect(snapshots.get(RUN)).toEqual([ORDERS]);
    expect(entry.headers).toEqual({
      authorization: `Bearer ${String(request.env['ANTHROPIC_AUTH_TOKEN'])}`,
    });

    const initialized = await rpc(entry, INITIALIZE);
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({ result: { capabilities: { tools: {} } } });
    const listed = await rpc(entry, LIST);
    expect(await listed.json()).toMatchObject({ result: { tools: [{ name: 'getOrder' }] } });

    upstreamCalls.length = 0;
    const called = await rpc(entry, CALL);
    expect(await called.json()).toMatchObject({
      result: {
        isError: false,
        content: [{ type: 'text', text: '{"id":"42","status":"shipped"}' }],
      },
    });
    // The upstream saw the connector's own credential, which never left the gateway.
    expect(upstreamCalls).toEqual([
      { path: '/orders/42', authorization: `Bearer ${UPSTREAM_CREDENTIAL}` },
    ]);
    expect(JSON.stringify(request)).not.toContain(UPSTREAM_CREDENTIAL);
    expect(JSON.stringify(request)).not.toContain(upstreamUrl);
  });

  it("refuses another run's token on this run's connector with 403 tool_not_in_run", async () => {
    const { entry } = await composeOrders(RUN);
    const otherToken = await issuer().issue({
      runId: OTHER_RUN,
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      agentId: '33333333-3333-4333-8333-333333333333',
      modelConnectionId: '77777777-7777-4777-8777-777777777777',
    });
    const response = await rpc(
      { url: entry.url, headers: { authorization: `Bearer ${otherToken}` } },
      CALL,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'tool_not_in_run' } });
  });

  it('drops a connector outside the ceiling’s tools, records no snapshot, and the gateway answers 403 tool_not_in_run (S2-04c)', async () => {
    // The run row exists with no recorded tool set, as a run whose tools were all dropped does.
    snapshots.set(CEILING_RUN, []);
    const request = await composeOrdersRequest(CEILING_RUN, { tools: [] });
    expect(request.portable.mcpServers).toEqual({});
    expect(snapshots.get(CEILING_RUN)).toEqual([]);

    const response = await rpc(
      {
        url: `${gatewayUrl}${gatewayToolPath(ORDERS)}`,
        headers: { authorization: `Bearer ${String(request.env['ANTHROPIC_AUTH_TOKEN'])}` },
      },
      CALL,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'tool_not_in_run' } });
  });
});
