import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, expect } from 'vitest';

import type { RequestContext } from '../types.js';

export type FixtureServer = {
  readonly url: string;
  readonly requests: Record<string, unknown>[];
  close(): Promise<void>;
};

type JsonObject = Record<string, unknown>;

const FIXTURE_CREDENTIAL = 'compatibility-fixture-credential';

async function requestBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject;
}

export function responseBody(output: JsonObject[]): JsonObject {
  return {
    id: 'resp_fixture',
    object: 'response',
    status: 'completed',
    model: 'gpt-fixture',
    output,
    usage: {
      input_tokens: 11,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 13,
    },
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendStreamingScenario(response: ServerResponse): void {
  const events = [
    {
      type: 'response.created',
      sequence_number: 0,
      response: { id: 'resp_fixture', status: 'in_progress', model: 'gpt-fixture' },
    },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { id: 'msg_fixture', type: 'message', role: 'assistant' },
    },
    {
      type: 'response.content_part.added',
      sequence_number: 2,
      part: { type: 'output_text', text: '' },
    },
    { type: 'response.output_text.delta', sequence_number: 3, delta: 'Hi' },
    { type: 'response.output_text.done', sequence_number: 4, text: 'Hi' },
    { type: 'response.completed', sequence_number: 5, response: responseBody([]) },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

function sendToolCallScenario(response: ServerResponse, callCount: number): void {
  const calls = Array.from({ length: callCount }, (_, index) => ({
    id: `fc_${String(index)}`,
    type: 'function_call',
    call_id: `call_${String(index)}`,
    name: 'lookup',
    arguments: JSON.stringify({ index }),
    status: 'completed',
  }));
  sendJson(response, 200, responseBody(calls));
}

function sendTextScenario(response: ServerResponse): void {
  sendJson(
    response,
    200,
    responseBody([
      {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hi', annotations: [] }],
      },
    ]),
  );
}

/** Answer one request according to the `compatibility_scenario` the suite put in its metadata. */
function respondToScenario(response: ServerResponse, scenario: unknown): void {
  switch (scenario) {
    case 'streaming':
      sendStreamingScenario(response);
      return;
    case 'errors':
      sendJson(response, 429, {
        error: { message: 'Fixture limit reached', type: 'rate_limit_error' },
      });
      return;
    case 'tool-call':
      sendToolCallScenario(response, 1);
      return;
    case 'multiple-tool-calls':
      sendToolCallScenario(response, 2);
      return;
    default:
      sendTextScenario(response);
  }
}

async function handleFixtureRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  requests: JsonObject[],
): Promise<void> {
  expect(incoming.url).toBe('/v1/responses');
  expect(incoming.headers.authorization).toBe(`Bearer ${FIXTURE_CREDENTIAL}`);
  const parsed = await requestBody(incoming);
  requests.push(parsed);
  const metadata = parsed['metadata'] as JsonObject | undefined;
  respondToScenario(response, metadata?.['compatibility_scenario']);
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function startFixtureServer(): Promise<FixtureServer> {
  const requests: JsonObject[] = [];
  const server = createServer((incoming, response) => {
    handleFixtureRequest(incoming, response, requests).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const fixture: FixtureServer = {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    close: () => closeServer(server),
  };
  return fixture;
}

/**
 * A starter for local Responses API endpoints replaying recorded scenarios. Call it once per test
 * file: every endpoint it started is closed after each test.
 */
export function fixtureServerStarter(): () => Promise<FixtureServer> {
  const openServers: FixtureServer[] = [];
  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((server) => server.close()));
  });
  return async () => {
    const fixture = await startFixtureServer();
    openServers.push(fixture);
    return fixture;
  };
}

export function fixtureContext(): RequestContext {
  return {
    providerId: 'openai',
    credential: FIXTURE_CREDENTIAL,
    requestId: 'req_fixture',
    settings: {},
  };
}

/** An Anthropic request using every representable element: system, tool use and result, thinking. */
export const WEATHER_ANTHROPIC_REQUEST = {
  model: 'gpt-fixture',
  max_tokens: 128,
  stream: true,
  system: [{ type: 'text', text: 'Be concise.' }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Weather?' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Tokyo' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'sunny' }],
    },
  ],
  tools: [{ name: 'weather', description: 'Get weather', input_schema: { type: 'object' } }],
  thinking: { type: 'enabled', budget_tokens: 100 },
};

/** A Responses output carrying text, a function call and reasoning, in that order. */
export const TEXT_CALL_REASONING_OUTPUT: JsonObject[] = [
  { type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
  { type: 'function_call', call_id: 'call_2', name: 'weather', arguments: '{"city":"Kyoto"}' },
  { type: 'reasoning', summary: [{ text: 'Checked conditions.' }], encrypted_content: 'opaque' },
];
