import { once } from 'node:events';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { selectAllowedOperations } from '@indx-workspace/contracts/tool-connectors';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createAnthropicHandler,
  type FakeRequestRecord,
} from '../generated-project/fake-anthropic.mjs';
import {
  ORDER_OPERATION_ID,
  createAnthropicToolsHandler,
  createOrdersApi,
  type OrdersCall,
  type ToolRequestRecord,
} from './fake-anthropic-tools.mjs';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close();
    await once(server, 'close');
  }
});

async function serve(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function serveTools(
  requests: FakeRequestRecord[],
  toolRequests: ToolRequestRecord[],
  bodies: string[] = [],
): Promise<string> {
  const handle = createAnthropicToolsHandler(requests, toolRequests, bodies);
  return serve((request, response) => {
    void handle(request, response);
  });
}

const NONCE = 'e2e-nonce-0a1b2c';
const TOOL = `mcp__orders__${ORDER_OPERATION_ID}`;
const ORDER_TOOL = {
  name: TOOL,
  description: 'Look up one order',
  input_schema: {
    type: 'object',
    properties: { orderNumber: { type: 'string' }, verbose: { type: 'boolean' } },
    required: ['orderNumber', 'verbose'],
  },
};
const BASH_TOOL = { name: 'Bash', input_schema: { type: 'object', properties: {} } };

function ask(body: Record<string, unknown>, url: string): Promise<Response> {
  return fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-e2e-fake-x' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64, ...body }),
  });
}

/** Each `data:` payload of an SSE body. */
function events(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
}

describe('the fake Anthropic API that calls the orders tool', () => {
  it('answers tool_use with the nonce in every required string input, not streaming', async () => {
    const toolRequests: ToolRequestRecord[] = [];
    const bodies: string[] = [];
    const url = await serveTools([], toolRequests, bodies);
    const response = await ask(
      {
        tools: [BASH_TOOL, ORDER_TOOL],
        messages: [{ role: 'user', content: `Please look up order ${NONCE}.` }],
      },
      url,
    );
    const body = (await response.json()) as {
      stop_reason: string;
      content: { type: string; name: string; input: unknown }[];
    };
    expect(body.stop_reason).toBe('tool_use');
    expect(body.content).toEqual([
      {
        type: 'tool_use',
        id: expect.any(String) as unknown,
        name: TOOL,
        input: { orderNumber: NONCE },
      },
    ]);
    expect(toolRequests).toEqual([
      {
        nonce: NONCE,
        toolNames: ['Bash', TOOL],
        toolUse: { name: TOOL, input: { orderNumber: NONCE } },
        toolResult: null,
      },
    ]);
    // The raw body, for the journey's secret check.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(`Please look up order ${NONCE}.`);
  });

  it('streams tool_use as Anthropic does: a tool_use block, JSON deltas, stop_reason tool_use', async () => {
    const url = await serveTools([], []);
    const response = await ask(
      {
        stream: true,
        tools: [ORDER_TOOL],
        messages: [{ role: 'user', content: [{ type: 'text', text: `Order ${NONCE}?` }] }],
      },
      url,
    );
    const stream = events(await response.text());
    expect(stream.map((event) => event['type'])).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(stream[1]).toMatchObject({ content_block: { type: 'tool_use', name: TOOL } });
    const json = stream
      .slice(2, 4)
      .map((event) => (event['delta'] as { partial_json: string }).partial_json)
      .join('');
    expect(JSON.parse(json)).toEqual({ orderNumber: NONCE });
    expect(stream[5]).toMatchObject({ delta: { stop_reason: 'tool_use' } });
  });

  it('answers a tool_result turn with text naming the nonce and the order data', async () => {
    const requests: FakeRequestRecord[] = [];
    const toolRequests: ToolRequestRecord[] = [];
    const url = await serveTools(requests, toolRequests);
    const result = JSON.stringify({ orderNumber: NONCE, note: `order-data-${NONCE}` });
    const response = await ask(
      {
        tools: [ORDER_TOOL],
        messages: [
          { role: 'user', content: `Please look up order ${NONCE}.` },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: TOOL, input: { orderNumber: NONCE } }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: result }] },
            ],
          },
        ],
      },
      url,
    );
    const body = (await response.json()) as { content: { text: string }[] };
    expect(body.content[0]?.text).toBe(`Fake Anthropic reply to ${NONCE}: ${result}`);
    expect(body.content[0]?.text).toContain(`order-data-${NONCE}`);
    expect(toolRequests[0]?.toolResult).toBe(result);
    // The slice-1 record, so assertReplyRecorded reads a tool answer as it reads any other.
    expect(requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/v1/messages',
        reply: `Fake Anthropic reply to ${NONCE}: ${result}`,
        apiKey: 'sk-ant-e2e-fake-x',
      }),
    ]);
  });

  it('regression: without the tool, or without a nonce, gives the slice-1 reply byte for byte', async () => {
    const slice1Handle = createAnthropicHandler([]);
    const slice1 = await serve((request, response) => {
      void slice1Handle(request, response);
    });
    const toolRequests: ToolRequestRecord[] = [];
    const tools = await serveTools([], toolRequests);
    for (const body of [
      { stream: true, tools: [BASH_TOOL], messages: [{ role: 'user', content: `Hi ${NONCE}` }] },
      { stream: false, tools: [BASH_TOOL], messages: [{ role: 'user', content: `Hi ${NONCE}` }] },
      { stream: true, tools: [ORDER_TOOL], messages: [{ role: 'user', content: 'No marker.' }] },
    ]) {
      const expected = await (await ask(body, slice1)).text();
      expect(await (await ask(body, tools)).text()).toBe(expected);
    }
    expect(toolRequests.map((record) => record.toolNames)).toEqual([['Bash'], ['Bash'], [TOOL]]);
    expect(toolRequests.every((record) => record.toolUse === null)).toBe(true);
    // The other routes are the slice-1 handler's own.
    const models = await fetch(`${tools}/v1/models`);
    expect(models.status).toBe(200);
  });
});

describe('the loopback orders API', () => {
  it('serves its own document: servers[0] is its origin, one 21-character operation, bearer', async () => {
    const api = createOrdersApi([]);
    const url = await serve(api.handler);
    const document = (await (await fetch(`${url}/openapi.json`)).json()) as {
      servers: { url: string }[];
      paths: Record<string, { get: { operationId: string } }>;
      components: { securitySchemes: Record<string, { scheme: string }> };
    };
    expect(document.servers[0]?.url).toBe(url);
    const operationId = document.paths['/orders/{orderNumber}']?.get.operationId;
    expect(operationId).toBe(ORDER_OPERATION_ID);
    expect(operationId).toHaveLength(21);
    expect(document.components.securitySchemes['bearer']?.scheme).toBe('bearer');
    expect(JSON.parse(api.document('http://127.0.0.1:9'))).toMatchObject({
      servers: [{ url: 'http://127.0.0.1:9' }],
    });
  });

  it("admits an operation for every rule of setup's allow list and of the hand-written tool", () => {
    const document = JSON.parse(createOrdersApi([]).document('http://127.0.0.1:9')) as {
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    const candidates = Object.entries(document.paths).flatMap(([path, operations]) =>
      Object.entries(operations).map(([method, operation]) => ({
        method,
        path,
        operationId: operation.operationId,
      })),
    );
    // Setup's rules (packages/sdk/src/project/render.ts OPENAPI_TOOL_ALLOW), and run.mjs's B3b tool.
    for (const allow of [['GET /**'], ['GET /orders/*']]) {
      const selected = selectAllowedOperations(allow, candidates);
      expect(selected.refusals).toEqual([]);
      expect(selected.admitted.map((operation) => operation.operationId)).toContain(
        ORDER_OPERATION_ID,
      );
    }
  });

  it('records GET /orders/<n> with its authorization and answers the order data', async () => {
    const calls: OrdersCall[] = [];
    const url = await serve(createOrdersApi(calls).handler);
    const response = await fetch(`${url}/orders/${NONCE}`, {
      headers: { authorization: 'Bearer orders-e2e-x' },
    });
    expect(await response.json()).toEqual({ orderNumber: NONCE, note: `order-data-${NONCE}` });
    expect(calls).toEqual([
      { method: 'GET', path: `/orders/${NONCE}`, authorization: 'Bearer orders-e2e-x' },
    ]);
  });

  it('answers 404 to an unknown path and records nothing', async () => {
    const calls: OrdersCall[] = [];
    const url = await serve(createOrdersApi(calls).handler);
    expect((await fetch(`${url}/customers/1`)).status).toBe(404);
    expect((await fetch(`${url}/orders/a/b`)).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
