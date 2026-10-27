/**
 * The two OpenAI-dialect ingress routes, end to end through the real router, the real provider
 * registry and the real metering boundary (ADR-0068). Only the upstream is a stub.
 */
import { describe, expect, it } from 'vitest';

import {
  createAuthenticatedGateway,
  type GatewayRunResolver,
  type GatewayUsageRecord,
  type RunResolution,
  type UsageRecorder,
} from './auth.js';
import { createProviderRegistry } from './providers/registry.js';
import { createRouter } from './router.js';
import { createRunTokenCodec, type RunTokenSubject } from './tokens/run-token.js';
import type { GatewayRouter } from './types.js';

const SUBJECT: RunTokenSubject = {
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: '55555555-5555-4555-8555-555555555555',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  agentId: '33333333-3333-4333-8333-333333333333',
  modelConnectionId: '44444444-4444-4444-8444-444444444444',
};
const SECRET = 'ingress-fixture-signing-secret-longer-than-32-bytes';
const CREDENTIAL = 'stored-openai-credential';

const RESPONSES_STREAM = [
  'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-fixture","usage":null}}',
  '',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call"}}',
  '',
  'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-fixture","output":[{"id":"fc_1","type":"function_call"}],"usage":{"input_tokens":90,"output_tokens":30,"input_tokens_details":{"cached_tokens":20}}}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

const CHAT_STREAM = [
  'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","model":"gpt-fixture","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}],"usage":null}',
  '',
  'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","model":"gpt-fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}',
  '',
  'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","model":"gpt-fixture","choices":[],"usage":{"prompt_tokens":90,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":20}}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

type Harness = {
  readonly gateway: Pick<GatewayRouter, 'fetch'>;
  readonly token: Promise<string>;
  readonly recorded: GatewayUsageRecord[];
  readonly failures: { runId: string; reason: string }[];
  readonly upstream: { url: string; init: RequestInit }[];
  readonly errors: unknown[];
};

type HarnessOptions = {
  readonly provider?: 'anthropic' | 'openai' | 'azure-openai' | 'openai-compatible';
  readonly resolution?: RunResolution;
  readonly respond?: () => Response;
};

/** The URL a `fetch` double was called with. Every adapter passes a string; the other two shapes
are narrowed rather than stringified, which `no-base-to-string` requires. */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The JSON body a relayed upstream request carried. */
function relayedBodyOf(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('a relayed body must be a JSON string');
  return JSON.parse(init.body) as Record<string, unknown>;
}

function eventStream(wire: string): Response {
  return new Response(wire, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function harness(options: HarnessOptions = {}): Harness {
  const providerId = options.provider ?? 'openai';
  const upstream: { url: string; init: RequestInit }[] = [];
  const recorded: GatewayUsageRecord[] = [];
  const failures: { runId: string; reason: string }[] = [];
  const errors: unknown[] = [];
  const transport: typeof fetch = (input, init) => {
    upstream.push({ url: urlOf(input), init: init ?? {} });
    return Promise.resolve(options.respond?.() ?? eventStream(RESPONSES_STREAM));
  };

  const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
  const resolver: GatewayRunResolver = {
    resolve: () =>
      Promise.resolve(
        options.resolution ?? {
          state: 'active',
          providerId,
          connectionProvider: providerId,
          credential: CREDENTIAL,
          // `localhost` keeps the egress policy satisfied while the transport stays a stub.
          settings: {
            baseUrl: 'http://localhost/v1',
            deployment: 'prod-deployment',
            ...(providerId === 'azure-openai' ? { apiVersion: 'v1' } : {}),
          },
        },
      ),
  };
  const recorder: UsageRecorder = {
    record(usage) {
      recorded.push(usage);
      return Promise.resolve();
    },
    fail(runId, reason) {
      failures.push({ runId, reason });
      return Promise.resolve();
    },
  };
  return {
    gateway: createAuthenticatedGateway(
      createRouter(createProviderRegistry({ fetch: transport })),
      tokens,
      resolver,
      recorder,
      (error) => errors.push(error),
    ),
    token: tokens.issue(SUBJECT),
    recorded,
    failures,
    upstream,
    errors,
  };
}

async function post(
  test: Harness,
  path: string,
  body: unknown,
  authorization?: string,
): Promise<Response> {
  return test.gateway.fetch(
    new Request(`http://gateway:4000${path}`, {
      method: 'POST',
      headers: {
        authorization: authorization ?? `Bearer ${await test.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /v1/responses', () => {
  it('relays a streamed request and records one openai-responses usage row', async () => {
    const test = harness();
    const response = await post(test, '/v1/responses', {
      model: 'gpt-fixture',
      input: 'hi',
      stream: true,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(RESPONSES_STREAM);
    expect(test.upstream).toHaveLength(1);
    expect(test.upstream[0]?.url).toBe('http://localhost/v1/responses');
    expect(test.recorded).toEqual<GatewayUsageRecord[]>([
      {
        runId: SUBJECT.runId,
        providerResponseId: 'resp_1',
        provider: 'openai',
        model: 'gpt-fixture',
        inputTokens: 70,
        outputTokens: 30,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        toolCalls: 1,
        wireProtocol: 'openai-responses',
        metered: true,
      },
    ]);
    expect(test.failures).toEqual([]);
  });

  it('keeps the stored credential off the client and the run token off the upstream', async () => {
    const test = harness();
    const response = await post(test, '/v1/responses', { model: 'gpt-fixture', input: 'hi' });
    const upstreamHeaders = new Headers(test.upstream[0]?.init.headers);
    expect(upstreamHeaders.get('authorization')).toBe(`Bearer ${CREDENTIAL}`);
    expect(JSON.stringify([...upstreamHeaders])).not.toContain(await test.token);
    expect(JSON.stringify([...response.headers])).not.toContain(CREDENTIAL);
    expect(await response.text()).not.toContain(CREDENTIAL);
  });

  it('refuses an anthropic connection with protocol_not_supported_for_connection', async () => {
    const test = harness({ provider: 'anthropic' });
    const response = await post(test, '/v1/responses', { model: 'claude-fixture', input: 'hi' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: 'protocol_not_supported_for_connection' },
    });
    expect(test.upstream).toEqual([]);
    expect(test.recorded).toEqual([]);
  });

  it('refuses a vendor-hosted tool with hosted_tool_not_permitted and calls no upstream', async () => {
    const test = harness();
    const response = await post(test, '/v1/responses', {
      model: 'gpt-fixture',
      input: 'hi',
      tools: [{ type: 'web_search' }],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: 'hosted_tool_not_permitted' } });
    expect(test.upstream).toEqual([]);
    expect(test.recorded).toEqual([]);
  });

  it('refuses a body with no model', async () => {
    const test = harness();
    const response = await post(test, '/v1/responses', { input: 'hi' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error' } });
    expect(test.upstream).toEqual([]);
  });

  // No `GET /v1/responses/{id}` exists, so a relayed background request would spend the run's
  // tokens on a turn no route could ever meter. The rule is to refuse, not to emulate.
  it('refuses background: true with background_not_supported and calls no upstream', async () => {
    const test = harness();
    const response = await post(test, '/v1/responses', {
      model: 'gpt-fixture',
      input: 'hi',
      background: true,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: 'background_not_supported', code: 'background_not_supported' },
    });
    expect(test.upstream).toEqual([]);
    expect(test.recorded).toEqual([]);
    expect(test.failures).toEqual([]);
  });

  // Conversation state kept at the vendor is outside the platform's session boundary and outside
  // `session_transcripts`, so the relay turns retention off and refuses a request that resumes it
  // (ADR-0068 D10).
  it('relays store: false, whatever the client asked for', async () => {
    const test = harness();
    await (
      await post(test, '/v1/responses', { model: 'gpt-fixture', input: 'hi', store: true })
    ).text();
    expect(relayedBodyOf(test.upstream[0]?.init)['store']).toBe(false);
  });

  it.each(['previous_response_id', 'conversation'])(
    'refuses %s with vendor_state_not_permitted and calls no upstream',
    async (field) => {
      const test = harness();
      const response = await post(test, '/v1/responses', {
        model: 'gpt-fixture',
        input: 'hi',
        [field]: 'resp_elsewhere',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: 'vendor_state_not_permitted', code: 'vendor_state_not_permitted' },
      });
      expect(test.upstream).toEqual([]);
      expect(test.recorded).toEqual([]);
      expect(test.failures).toEqual([]);
    },
  );

  it('relays background: false, which asks for nothing unreachable', async () => {
    const test = harness();
    await (
      await post(test, '/v1/responses', { model: 'gpt-fixture', input: 'hi', background: false })
    ).text();
    expect(test.upstream).toHaveLength(1);
  });

  it.each([
    ['a missing token', undefined, 401, 'token_missing'],
    ['an unsigned token', 'Bearer not-a-token', 401, 'token_invalid'],
  ] as const)('refuses %s', async (_name, authorization, status, code) => {
    const test = harness();
    const response = await test.gateway.fetch(
      new Request('http://gateway:4000/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: JSON.stringify({ model: 'gpt-fixture', input: 'hi' }),
      }),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(test.upstream).toEqual([]);
  });

  it('refuses an expired token', async () => {
    const issuer = createRunTokenCodec({ secret: SECRET, now: () => 0 });
    const expired = await issuer.issue(SUBJECT);
    const test = harness();
    const response = await post(
      test,
      '/v1/responses',
      { model: 'gpt-fixture' },
      `Bearer ${expired}`,
    );
    // The harness's codec reads the clock at 1000s, well past a token minted at 0.
    expect(response.status).toBe(401);
    expect(test.upstream).toEqual([]);
  });

  it('refuses a revoked token', async () => {
    const test = harness({ resolution: { state: 'revoked' } });
    const response = await post(test, '/v1/responses', { model: 'gpt-fixture' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'token_revoked' } });
    expect(test.upstream).toEqual([]);
  });

  it('answers 405 for GET, which the route table declares as POST only', async () => {
    const test = harness();
    const response = await test.gateway.fetch(
      new Request('http://gateway:4000/v1/responses', {
        headers: { authorization: `Bearer ${await test.token}` },
      }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('fails settlement for a stream cut before its terminal frame', async () => {
    const truncated = RESPONSES_STREAM.slice(0, RESPONSES_STREAM.indexOf('response.completed'));
    const test = harness({ respond: () => eventStream(truncated) });
    await (await post(test, '/v1/responses', { model: 'gpt-fixture', stream: true })).text();
    expect(test.recorded).toEqual([]);
    expect(test.failures).toHaveLength(1);
    expect(test.failures[0]?.reason).toContain('no authoritative usage fields');
  });
});

describe('POST /v1/chat/completions', () => {
  it('relays a streamed request, injecting stream_options, and records the usage row', async () => {
    const test = harness({ respond: () => eventStream(CHAT_STREAM) });
    const response = await post(test, '/v1/chat/completions', {
      model: 'gpt-fixture',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(CHAT_STREAM);
    expect(test.upstream[0]?.url).toBe('http://localhost/v1/chat/completions');
    // The client omitted it; without it the upstream reports no usage and the run cannot settle.
    expect(relayedBodyOf(test.upstream[0]?.init)).toMatchObject({
      stream_options: { include_usage: true },
    });
    expect(test.recorded).toEqual<GatewayUsageRecord[]>([
      {
        runId: SUBJECT.runId,
        providerResponseId: 'chatcmpl_1',
        provider: 'openai',
        model: 'gpt-fixture',
        inputTokens: 70,
        outputTokens: 30,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        toolCalls: 0,
        wireProtocol: 'openai-chat-completions',
        metered: true,
      },
    ]);
  });

  it('records an unmetered row for a compatible upstream that finished without usage', async () => {
    const withoutUsage = [
      'data: {"id":"chatcmpl_2","object":"chat.completion.chunk","model":"local-fixture","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const test = harness({
      provider: 'openai-compatible',
      respond: () => eventStream(withoutUsage),
    });
    await (
      await post(test, '/v1/chat/completions', { model: 'local-fixture', stream: true })
    ).text();
    expect(test.failures).toEqual([]);
    expect(test.recorded).toEqual<GatewayUsageRecord[]>([
      {
        runId: SUBJECT.runId,
        providerResponseId: 'chatcmpl_2',
        provider: 'openai-compatible',
        model: 'local-fixture',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        toolCalls: 0,
        wireProtocol: 'openai-chat-completions',
        // Zeros that were never measured. The recorder prices them as unavailable, not as free.
        metered: false,
      },
    ]);
  });

  it('refuses an anthropic connection with protocol_not_supported_for_connection', async () => {
    const test = harness({ provider: 'anthropic' });
    const response = await post(test, '/v1/chat/completions', { model: 'claude-fixture' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: 'protocol_not_supported_for_connection' },
    });
    expect(test.upstream).toEqual([]);
  });

  // OpenAI turns on its hosted web search here through a top-level field rather than a `tools`
  // entry, so a request declaring no tool at all would otherwise walk past the allowlist and get
  // exactly the vendor-side execution the rule exists to prevent.
  it('refuses a top-level web_search_options with hosted_tool_not_permitted and calls no upstream', async () => {
    const test = harness();
    const response = await post(test, '/v1/chat/completions', {
      model: 'gpt-4o-search-preview',
      messages: [{ role: 'user', content: 'hi' }],
      web_search_options: {},
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: 'hosted_tool_not_permitted', code: 'hosted_tool_not_permitted' },
    });
    expect(test.upstream).toEqual([]);
    expect(test.recorded).toEqual([]);
    expect(test.failures).toEqual([]);
  });

  it('relays through an azure connection at its deployment-pinned model', async () => {
    const test = harness({ provider: 'azure-openai', respond: () => eventStream(CHAT_STREAM) });
    await (
      await post(test, '/v1/chat/completions', { model: 'a-model-the-client-chose', stream: true })
    ).text();
    expect(test.upstream[0]?.url).toBe('http://localhost/v1/openai/v1/chat/completions');
    expect(new Headers(test.upstream[0]?.init.headers).get('api-key')).toBe(CREDENTIAL);
    expect(relayedBodyOf(test.upstream[0]?.init)).toMatchObject({
      model: 'prod-deployment',
    });
  });
});

describe('GET /v1/models negotiates its envelope', () => {
  /** What the Anthropic SDK sends on every request, including `models.list()`. */
  const ANTHROPIC_SDK_HEADERS = { 'anthropic-version': '2023-06-01' } as const;

  async function listModels(
    test: Harness,
    query = '',
    headers: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    const response = await test.gateway.fetch(
      new Request(`http://gateway:4000/v1/models${query}`, {
        headers: { authorization: `Bearer ${await test.token}`, ...headers },
      }),
    );
    expect(response.status).toBe(200);
    return response.json();
  }

  function anthropicCatalogue(): Response {
    return Response.json({
      data: [
        {
          id: 'claude-fixture',
          type: 'model',
          display_name: 'Claude Fixture',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  }

  it('answers the Anthropic envelope for an Anthropic-SDK request on an anthropic connection', async () => {
    const test = harness({ provider: 'anthropic', respond: anthropicCatalogue });
    expect(await listModels(test, '', ANTHROPIC_SDK_HEADERS)).toMatchObject({
      data: [{ id: 'claude-fixture', type: 'model' }],
      first_id: 'claude-fixture',
      has_more: false,
    });
  });

  // The regression the envelope rule exists for: `ANTHROPIC_BASE_URL` points Claude Code at the
  // gateway on every connection family, so an Anthropic-SDK request on an `openai` connection must
  // still get the envelope that SDK can parse (ADR-0068 D6).
  it('answers the Anthropic envelope for an Anthropic-SDK request on an openai connection', async () => {
    const test = harness({ respond: anthropicCatalogue });
    expect(await listModels(test, '', ANTHROPIC_SDK_HEADERS)).toMatchObject({
      data: [{ id: 'claude-fixture', type: 'model' }],
      first_id: 'claude-fixture',
      has_more: false,
    });
  });

  it('answers the OpenAI envelope for an OpenAI-SDK request on an openai connection', async () => {
    const test = harness({
      respond: () => Response.json({ data: [{ id: 'gpt-fixture', created: 1_700_000_000 }] }),
    });
    expect(await listModels(test)).toEqual({
      object: 'list',
      data: [{ id: 'gpt-fixture', object: 'model', created: 1_700_000_000, owned_by: 'openai' }],
    });
  });

  it('answers the OpenAI envelope for an OpenAI-SDK request on an anthropic connection', async () => {
    const test = harness({ provider: 'anthropic', respond: anthropicCatalogue });
    expect(await listModels(test)).toMatchObject({ object: 'list' });
  });

  it('lets ?format and x-gateway-model-format override the client signal', async () => {
    const openai = harness({
      respond: () => Response.json({ data: [{ id: 'gpt-fixture', created: 0 }] }),
    });
    expect(await listModels(openai, '?format=anthropic')).toMatchObject({ has_more: false });
    expect(await listModels(openai, '', { 'x-gateway-model-format': 'anthropic' })).toMatchObject({
      has_more: false,
    });
    expect(await listModels(openai, '?format=openai', ANTHROPIC_SDK_HEADERS)).toMatchObject({
      object: 'list',
    });
  });

  it('is never metered, so a model listing cannot mark a run accounting-failed', async () => {
    const test = harness({ respond: () => Response.json({ data: [] }) });
    await listModels(test);
    expect(test.recorded).toEqual([]);
    expect(test.failures).toEqual([]);
    expect(test.errors).toEqual([]);
  });
});
