import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, expect } from 'vitest';

import type { RequestContext } from '../types.js';

export type FixtureServer = {
  readonly endpoint: string;
  readonly requests: Record<string, unknown>[];
  close(): Promise<void>;
};

type JsonObject = Record<string, unknown>;

export const FIXTURE_DEPLOYMENT = 'azure-deployment';
/** The key `azureContext` carries, which a request must present as its `api-key`. */
export const AZURE_CONTEXT_KEY = 'azure-fixture-key';
const SUITE_CREDENTIAL = 'compatibility-fixture-credential';

async function requestBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject;
}

export function responseBody(output: JsonObject[]): JsonObject {
  return {
    id: 'resp_azure_fixture',
    object: 'response',
    status: 'completed',
    model: 'ignored-service-model-name',
    output,
    usage: {
      input_tokens: 11,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
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
      response: { id: 'resp_fixture', status: 'in_progress', model: FIXTURE_DEPLOYMENT },
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

function sendThrottledScenario(response: ServerResponse): void {
  response.writeHead(429, {
    'content-type': 'application/json',
    'retry-after-ms': '2000',
    'x-ratelimit-limit-tokens': '1000',
  });
  response.end(JSON.stringify({ error: { message: 'Azure fixture throttled the request' } }));
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
      sendThrottledScenario(response);
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
  expect(incoming.url).toBe('/openai/v1/responses');
  expect(incoming.headers['api-key']).toBe(SUITE_CREDENTIAL);
  const parsed = await requestBody(incoming);
  expect(parsed['model']).toBe(FIXTURE_DEPLOYMENT);
  requests.push(parsed);
  const metadata = parsed['metadata'] as JsonObject | undefined;
  respondToScenario(response, metadata?.['compatibility_scenario']);
}

async function startFixtureServer(): Promise<FixtureServer> {
  const requests: JsonObject[] = [];
  const server = createServer((incoming, response) => {
    handleFixtureRequest(incoming, response, requests).catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/**
 * A starter for local Azure Responses endpoints replaying recorded scenarios. Call it once per
 * test file: every endpoint it started is closed after each test.
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

export function azureContext(): RequestContext {
  return {
    providerId: 'azure-openai',
    credential: AZURE_CONTEXT_KEY,
    requestId: 'req_azure_fixture',
    settings: {},
  };
}

/** An Anthropic request whose `model` the adapter must replace with the deployment name. */
export const MISNAMED_MODEL_REQUEST = {
  model: 'must-not-be-used',
  messages: [{ role: 'user', content: 'Hi' }],
};
