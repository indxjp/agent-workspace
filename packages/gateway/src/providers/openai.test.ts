import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { runCompatibilitySuite } from '../../../../tests/providers/harness.js';
import type { RequestContext } from '../types.js';
import {
  anthropicToOpenAI,
  openAIError,
  openAIToAnthropic,
  OPENAI_APPROXIMATION_WARNINGS,
  OPENAI_CANNOT_REPRESENT,
  OPENAI_TRANSLATION_TABLE,
} from '../translate/openai.js';
import { createOpenAIProvider } from './openai.js';

type FixtureServer = {
  readonly url: string;
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

async function startFixtureServer(): Promise<FixtureServer> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((incoming, response) => {
    void (async () => {
      expect(incoming.url).toBe('/v1/responses');
      expect(incoming.headers.authorization).toBe('Bearer compatibility-fixture-credential');
      const parsed = await requestBody(incoming);
      requests.push(parsed);
      const metadata = parsed['metadata'] as Record<string, unknown> | undefined;
      const scenario = metadata?.['compatibility_scenario'];

      if (scenario === 'streaming') {
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
          {
            type: 'response.completed',
            sequence_number: 5,
            response: responseBody([]),
          },
        ];
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
        return;
      }
      if (scenario === 'errors') {
        sendJson(response, 429, {
          error: { message: 'Fixture limit reached', type: 'rate_limit_error' },
        });
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
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const result: FixtureServer = {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
  openServers.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function context(): RequestContext {
  return {
    providerId: 'openai',
    credential: 'compatibility-fixture-credential',
    requestId: 'req_fixture',
    settings: {},
  };
}

describe('OpenAI Responses provider', () => {
  it('passes all ten required §41 scenarios against the recorded-fixture endpoint', async () => {
    const fixture = await startFixtureServer();
    const report = await runCompatibilitySuite(createOpenAIProvider({ baseUrl: fixture.url }));

    expect(report.outcomes.slice(0, 10).map((outcome) => outcome.verdict)).toEqual(
      Array.from({ length: 10 }, () => 'native'),
    );
    expect(report.ok).toBe(true);
  });

  it('derives the complete translation inventory from spec §11', async () => {
    const spec = await readFile(new URL('../../../../docs/spec.md', import.meta.url), 'utf8');
    const section = spec.slice(
      spec.indexOf('# 11. Anthropic'),
      spec.indexOf('# 12. Never Pretend'),
    );
    const elements = [...section.matchAll(/^\* (.+)$/gm)].map((match) => match[1]);

    expect(OPENAI_TRANSLATION_TABLE.map((row) => row.element)).toEqual(elements);
    expect(OPENAI_TRANSLATION_TABLE.every((row) => row.verdict.length > 0)).toBe(true);
    expect(OPENAI_CANNOT_REPRESENT).toHaveLength(7);
    expect(OPENAI_CANNOT_REPRESENT).toContain('tool_result.is_error');
  });

  it('uses every operator-facing approximation sentence verbatim from the R-04 fixture', async () => {
    const sentencesFile = 'R-04-operator-sentences.md';
    const note = await readFile(
      new URL(`../../../../docs/research/fixtures/${sentencesFile}`, import.meta.url),
      'utf8',
    );
    const documented = new Set(
      [...note.matchAll(/Operator sentence[^\n]*?\*"([^"]+)"\*/g)].map((match) => match[1]),
    );

    const warnings = Object.values(OPENAI_APPROXIMATION_WARNINGS);
    expect(warnings.every((warning) => warning.trim().endsWith('.'))).toBe(true);
    expect(warnings.filter((warning) => !documented.has(warning))).toEqual([]);
  });

  it('round-trips the representable §11 request and response elements', () => {
    const request = anthropicToOpenAI({
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
      tools: [
        {
          name: 'weather',
          description: 'Get weather',
          input_schema: { type: 'object' },
        },
      ],
      thinking: { type: 'enabled', budget_tokens: 100 },
    });
    expect(request.instructions).toBe('Be concise.');
    expect(request.input).toContainEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'weather',
      arguments: '{"city":"Tokyo"}',
    });
    expect(request.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'sunny',
    });
    expect(request.tools?.[0]).toEqual({
      type: 'function',
      name: 'weather',
      description: 'Get weather',
      parameters: { type: 'object' },
      strict: true,
    });
    expect(request.stream).toBe(true);
    expect(request.reasoning).toEqual({ summary: 'auto' });

    const response = openAIToAnthropic(
      responseBody([
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Done' }],
        },
        {
          type: 'function_call',
          call_id: 'call_2',
          name: 'weather',
          arguments: '{"city":"Kyoto"}',
        },
        {
          type: 'reasoning',
          summary: [{ text: 'Checked conditions.' }],
          encrypted_content: 'opaque',
        },
      ]),
      'fallback',
    );
    expect(response['stop_reason']).toBe('tool_use');
    expect(response['content']).toEqual([
      { type: 'text', text: 'Done' },
      { type: 'tool_use', id: 'call_2', name: 'weather', input: { city: 'Kyoto' } },
      { type: 'thinking', thinking: 'Checked conditions.', signature: 'opaque' },
    ]);
    expect(response['usage']).toMatchObject({ input_tokens: 11, output_tokens: 2 });
    expect(openAIError(429, { error: { message: 'slow down' } }, 'req_1').status).toBe(429);
  });

  it('takes credentials only from RequestContext and sends the translated request', async () => {
    const fixture = await startFixtureServer();
    const provider = createOpenAIProvider({ baseUrl: fixture.url });
    const response = await provider.createMessage(
      { model: 'gpt-fixture', messages: [{ role: 'user', content: 'Hi' }] },
      context(),
    );

    expect(response.ok).toBe(true);
    expect(fixture.requests[0]).toMatchObject({
      model: 'gpt-fixture',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
    });
    const source = await readFile(new URL('./openai.ts', import.meta.url), 'utf8');
    expect(source).not.toContain(['process', 'env'].join('.'));
  });

  it('refuses a base URL that resolves to an RFC1918 address (W9-PROV-127)', async () => {
    const provider = createOpenAIProvider({ baseUrl: 'https://10.0.0.5/v1' });
    await expect(
      provider.createMessage({ model: 'gpt-fixture', messages: [] }, context()),
    ).rejects.toThrow(/Egress policy refused/);
  });
});
