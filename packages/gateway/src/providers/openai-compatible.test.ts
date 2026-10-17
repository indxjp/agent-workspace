import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { runCompatibilitySuite } from '../../../../tests/providers/harness.js';
import {
  createOpenAICompatibleProvider,
  normalizeOpenAICompatibleBaseUrl,
} from './openai-compatible.js';

type FixtureServer = { readonly baseUrl: string; close(): Promise<void> };
const openServers: FixtureServer[] = [];

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function responseBody(output: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    id: 'resp_compatible_fixture',
    object: 'response',
    status: 'completed',
    model: 'compatible-model',
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

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer((incoming, response) => {
    void (async () => {
      expect(incoming.url).toBe('/recorded/v1/responses');
      expect(incoming.headers.authorization).toBe('Bearer compatibility-fixture-credential');
      const parsed = await body(incoming);
      const metadata = parsed['metadata'] as Record<string, unknown> | undefined;
      const scenario = metadata?.['compatibility_scenario'];
      if (scenario === 'streaming') {
        const events = [
          {
            type: 'response.created',
            sequence_number: 0,
            response: { id: 'resp_fixture', status: 'in_progress', model: 'compatible-model' },
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
        sendJson(response, 429, { error: { message: 'Compatible fixture limit reached' } });
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
    baseUrl: `http://127.0.0.1:${String(address.port)}/recorded/v1`,
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

describe('OpenAI-compatible provider', () => {
  it('runs the same ten required scenarios through only its configured base URL', async () => {
    const fixture = await startFixtureServer();
    const report = await runCompatibilitySuite(
      createOpenAICompatibleProvider({ baseUrl: fixture.baseUrl }),
    );
    expect(report.ok).toBe(true);
    expect(report.outcomes.slice(0, 10).map((outcome) => outcome.verdict)).toEqual(
      Array.from({ length: 10 }, () => 'native'),
    );
    expect(report.outcomes.slice(10).map((outcome) => outcome.verdict)).toEqual(
      Array.from({ length: 4 }, () => 'unsupported'),
    );
  });

  it('refuses insecure remote and malformed base URLs with a named configuration error', () => {
    expect(() => normalizeOpenAICompatibleBaseUrl('http://models.example.com/v1')).toThrow(
      'OpenAI-compatible base URL must use https',
    );
    expect(() => normalizeOpenAICompatibleBaseUrl('not a URL')).toThrow(
      'OpenAI-compatible base URL must be an absolute URL.',
    );
    expect(normalizeOpenAICompatibleBaseUrl('http://localhost:8000/v1/')).toBe(
      'http://localhost:8000/v1',
    );
  });

  it('declares no translation of its own and delegates to the shared adapter', async () => {
    const source = await readFile(new URL('./openai-compatible.ts', import.meta.url), 'utf8');
    expect(source).toContain("from './openai.js'");
    for (const forbidden of [
      'anthropicToOpenAI',
      'openAIToAnthropic',
      'translateOpenAIStream',
      'function_call_output',
      'input_text',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
