import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { runCompatibilitySuite } from '../../../../tests/providers/harness.js';
import type { RequestContext } from '../types.js';
import { buildAzureOpenAIUrl, createAzureOpenAIProvider } from './azure-openai.js';

type FixtureServer = {
  readonly endpoint: string;
  readonly requests: Record<string, unknown>[];
  close(): Promise<void>;
};

const openServers: FixtureServer[] = [];

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function responseBody(output: Record<string, unknown>[]): Record<string, unknown> {
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

async function startFixtureServer(): Promise<FixtureServer> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((incoming, response) => {
    void (async () => {
      expect(incoming.url).toBe('/openai/v1/responses');
      expect(incoming.headers['api-key']).toBe('compatibility-fixture-credential');
      const parsed = await requestBody(incoming);
      expect(parsed['model']).toBe('azure-deployment');
      requests.push(parsed);
      const metadata = parsed['metadata'] as Record<string, unknown> | undefined;
      const scenario = metadata?.['compatibility_scenario'];
      if (scenario === 'streaming') {
        const events = [
          {
            type: 'response.created',
            sequence_number: 0,
            response: { id: 'resp_fixture', status: 'in_progress', model: 'azure-deployment' },
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
        return;
      }
      if (scenario === 'errors') {
        response.writeHead(429, {
          'content-type': 'application/json',
          'retry-after-ms': '2000',
          'x-ratelimit-limit-tokens': '1000',
        });
        response.end(JSON.stringify({ error: { message: 'Azure fixture throttled the request' } }));
        return;
      }
      if (scenario === 'tool-call' || scenario === 'multiple-tool-calls') {
        const count = scenario === 'multiple-tool-calls' ? 2 : 1;
        sendJson(
          response,
          200,
          responseBody(
            Array.from({ length: count }, (_, index) => ({
              id: `fc_${String(index)}`,
              type: 'function_call',
              call_id: `call_${String(index)}`,
              name: 'lookup',
              arguments: JSON.stringify({ index }),
              status: 'completed',
            })),
          ),
        );
        return;
      }
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
    })().catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const fixture: FixtureServer = {
    endpoint: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
  openServers.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function context(): RequestContext {
  return {
    providerId: 'azure-openai',
    credential: 'azure-fixture-key',
    requestId: 'req_azure_fixture',
    settings: {},
  };
}

describe('Azure OpenAI provider', () => {
  it('passes the ten required scenarios and publishes every optional matrix cell', async () => {
    const fixture = await startFixtureServer();
    const report = await runCompatibilitySuite(
      createAzureOpenAIProvider({ endpoint: fixture.endpoint, deployment: 'azure-deployment' }),
    );
    expect(report.ok).toBe(true);
    expect(report.outcomes).toHaveLength(14);
    expect(report.outcomes.slice(0, 10).every((outcome) => outcome.verdict === 'native')).toBe(
      true,
    );
    expect(report.outcomes.slice(10).map((outcome) => outcome.verdict)).toEqual([
      'unsupported',
      'unsupported',
      'native',
      'unsupported',
    ]);
  });

  it('builds R-05 legacy and v1 URLs without substituting a model name for deployment', () => {
    expect(
      buildAzureOpenAIUrl(
        'https://example-resource.openai.azure.com',
        'my-deployment',
        '2024-10-21',
        'chat/completions',
      ),
    ).toBe(
      'https://example-resource.openai.azure.com/openai/deployments/my-deployment/chat/completions?api-version=2024-10-21',
    );
    expect(
      buildAzureOpenAIUrl(
        'https://example-resource.openai.azure.com',
        'my-deployment',
        undefined,
        'responses',
      ),
    ).toBe('https://example-resource.openai.azure.com/openai/v1/responses');
  });

  it('absorbs Azure content filtering into an Anthropic refusal response', async () => {
    const provider = createAzureOpenAIProvider({
      endpoint: 'http://localhost',
      deployment: 'azure-deployment',
      fetch: () =>
        Promise.resolve(
          Response.json(
            { error: { code: 'content_filter', message: 'The prompt was filtered by Azure.' } },
            { status: 400 },
          ),
        ),
    });
    const response = await provider.createMessage(
      { model: 'must-not-be-used', messages: [{ role: 'user', content: 'Hi' }] },
      context(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stop_reason: 'refusal',
      content: [],
      stop_details: { type: 'refusal', category: null },
    });
  });

  it('normalizes a 429 and does not leak Azure rate-limit headers', async () => {
    const provider = createAzureOpenAIProvider({
      endpoint: 'http://localhost',
      deployment: 'azure-deployment',
      fetch: () =>
        Promise.resolve(
          Response.json(
            { error: { message: 'Rate limit exceeded' } },
            {
              status: 429,
              headers: { 'retry-after-ms': '2000', 'x-ratelimit-limit-tokens': '1000' },
            },
          ),
        ),
    });
    const response = await provider.createMessage(
      { model: 'must-not-be-used', messages: [{ role: 'user', content: 'Hi' }] },
      context(),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after-ms')).toBeNull();
    expect(response.headers.get('x-ratelimit-limit-tokens')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
    });
  });

  it('refuses redirects and sources the key only from RequestContext', async () => {
    let init: RequestInit | undefined;
    const provider = createAzureOpenAIProvider({
      endpoint: 'http://localhost',
      deployment: 'azure-deployment',
      fetch: (_input, received) => {
        init = received;
        return Promise.resolve(Response.json(responseBody([])));
      },
    });
    await provider.createMessage(
      { model: 'not-the-deployment', messages: [{ role: 'user', content: 'Hi' }] },
      context(),
    );
    // W9-PROV-127's shared egress guard requests with `redirect: 'error'` at every provider
    // call site, superseding this adapter's own former `redirect: 'manual'`.
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('api-key')).toBe('azure-fixture-key');
    expect(typeof init?.body).toBe('string');
    const sent: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    expect(sent).toMatchObject({ model: 'azure-deployment' });
  });
});
