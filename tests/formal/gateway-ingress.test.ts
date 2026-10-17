/**
 * Differential conformance for the `gateway-ingress` family
 * (formal/AgentWorkspace/Behaviour/GatewayIngress.lean), replayed against the REAL gateway.
 *
 * Nothing here reimplements a decision. Each vector drives
 * `createAuthenticatedGateway(createRouter(createProviderRegistry(...)), …)` — the production
 * composition, with only the upstream `fetch` and the run resolver stubbed — and compares what the
 * gateway actually did with what the Lean model says it should:
 *
 *   * `routes.json` — whether the request was forwarded at all, and if so which URL, credential,
 *     model and `stream_options` the upstream saw; if not, which status and stable code the client
 *     saw.
 *   * `models.json` — which `GET /v1/models` envelope was answered.
 *   * `usage.json` — the counters `extractResponseUsage` read out of a real SSE stream rebuilt from
 *     the vector's frames, and whether the metering boundary recorded a row or failed the run.
 *   * `tools.json` — the application's route table in order, and for each path whether serving it
 *     resolved the model key and whether the usage recorder settled it (the tool route of C16 does
 *     neither), through `createGatewayApplication`.
 *
 * A disagreement is a failing test, and the fix is never to edit a vector
 * (docs/formal/00-orchestrator-prompt.md §10). The accounting state a settlement leaves the run in
 * is the repository's derivation and is covered by the PostgreSQL-backed
 * `packages/core/src/db/repositories/run-usage.test.ts`, not here.
 */
import { describe, expect, it } from 'vitest';

import {
  createAuthenticatedGateway,
  createGatewayApplication,
  createRouter,
  extractResponseUsage,
  type GatewayRunResolver,
  type GatewayUsageRecord,
  type RunResolution,
  type UsageRecorder,
  type WireProtocol,
} from '@agent-workspace/gateway';
import {
  createProviderRegistry,
  registryProviderId,
  type RegisteredProviderId,
} from '@agent-workspace/gateway/providers/registry';
import {
  createEndpointGrantCodec,
  createRunTokenCodec,
  type RunTokenSubject,
} from '@agent-workspace/gateway/tokens';
import { MODEL_PROVIDERS, type ModelProvider } from '@indx-workspace/contracts/runs';
import { OpenApiToolConfigSchema } from '@indx-workspace/contracts/tool-connectors';

import { asRecord, asString, loadVectors } from './vectors.js';

const routeVectors = loadVectors('gateway-ingress', 'routes.json');
const modelVectors = loadVectors('gateway-ingress', 'models.json');
const usageVectors = loadVectors('gateway-ingress', 'usage.json');
const ingressVectors = loadVectors('gateway-ingress', 'tools.json');

/** The subject of `fixtureClaims` in `formal/Vectors/GatewayIngress.lean`. */
const SUBJECT: RunTokenSubject = {
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: '55555555-5555-4555-8555-555555555555',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  agentId: '33333333-3333-4333-8333-333333333333',
  modelConnectionId: '44444444-4444-4444-8444-444444444444',
};
const SECRET = 'gateway-ingress-vector-replay-secret-0000001';
/** `fixtureConnection` in the vector emitter. */
const CREDENTIAL = 'stored-credential';
const DEPLOYMENT = 'prod-deployment';

const ROUTE_OF: Readonly<Record<string, string>> = {
  'anthropic-messages': '/v1/messages',
  'openai-responses': '/v1/responses',
  'openai-chat-completions': '/v1/chat/completions',
};

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${what}: expected a boolean`);
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what}: expected a number`);
  return value;
}

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value;
}

function asProtocol(value: unknown, what: string): WireProtocol {
  const protocol = asString(value, what);
  if (!Object.hasOwn(ROUTE_OF, protocol)) throw new Error(`${what}: unknown protocol ${protocol}`);
  return protocol as WireProtocol;
}

// ---------------------------------------------------------------------------------------------
// The gateway under test: the production composition with a stub upstream and resolver.

type Driven = {
  readonly response: Response;
  readonly upstream: readonly { url: string; init: RequestInit }[];
  readonly recorded: readonly GatewayUsageRecord[];
  readonly failures: readonly { runId: string; reason: string }[];
  /** The run token the request was made with, so an assertion can name the secret it looks for
   * rather than a prefix of one encoding of it. */
  readonly token: string;
};

type DriveOptions = {
  readonly path: string;
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly family: string;
  readonly token: 'valid' | 'missing' | 'expired' | 'revoked';
  readonly headers?: Readonly<Record<string, string>>;
  readonly upstreamResponse?: () => Response;
};

/**
 * The connection provider a vector's family names. `createDatabaseGatewayRunResolver` maps it with
 * `registryProviderId`: an `anthropic-compatible` connection is served by the `anthropic` adapter,
 * so the router only ever sees the four registry ids.
 */
function connectionProviderOf(family: string): ModelProvider {
  const provider = MODEL_PROVIDERS.find((candidate) => candidate === family);
  if (provider === undefined) throw new Error(`unknown model provider family ${family}`);
  return provider;
}

/** The URL a `fetch` double was called with, narrowed rather than stringified. */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The JSON body a relayed upstream request carried. */
function relayedBodyOf(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') throw new Error('a relayed body must be a JSON string');
  return JSON.parse(init.body) as Record<string, unknown>;
}

async function drive(options: DriveOptions): Promise<Driven> {
  const upstream: { url: string; init: RequestInit }[] = [];
  const recorded: GatewayUsageRecord[] = [];
  const failures: { runId: string; reason: string }[] = [];
  const transport: typeof fetch = (input, init) => {
    upstream.push({ url: urlOf(input), init: init ?? {} });
    return Promise.resolve(options.upstreamResponse?.() ?? Response.json({ id: 'resp_fixture' }));
  };

  const resolution: RunResolution =
    options.token === 'revoked'
      ? { state: 'revoked' }
      : {
          state: 'active',
          providerId: registryProviderId(connectionProviderOf(options.family)),
          connectionProvider: connectionProviderOf(options.family),
          credential: CREDENTIAL,
          // `localhost` satisfies the egress policy while the transport stays a stub.
          settings: { baseUrl: 'http://localhost/v1', deployment: DEPLOYMENT },
        };
  const resolver: GatewayRunResolver = { resolve: () => Promise.resolve(resolution) };
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

  const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
  const gateway = createAuthenticatedGateway(
    createRouter(createProviderRegistry({ fetch: transport })),
    tokens,
    resolver,
    recorder,
    () => undefined,
  );

  // `expired` mints the token against a clock at 0, which the gateway's clock at 1000 is past.
  const issued =
    options.token === 'expired'
      ? await createRunTokenCodec({ secret: SECRET, now: () => 0 }).issue(SUBJECT)
      : await tokens.issue(SUBJECT);
  const method = options.method ?? 'POST';
  const response = await gateway.fetch(
    new Request(`http://gateway:4000${options.path}`, {
      method,
      headers: {
        ...(options.token === 'missing' ? {} : { authorization: `Bearer ${issued}` }),
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      ...(method === 'POST' ? { body: JSON.stringify(options.body) } : {}),
    }),
  );
  // The gateway gates a streamed body's end-of-stream on settlement, so reading it first is what
  // makes the recorded row observable here (issue #134).
  const text = await response.text();
  return {
    response: new Response(text, { status: response.status, headers: response.headers }),
    upstream,
    recorded,
    failures,
    token: issued,
  };
}

/** The stable code a gateway refusal carries: authentication uses `error.code`, and the router's
 * own validation envelope carries only `error.type`. Both are the code the model names. */
function refusalCodeOf(body: unknown): string {
  const error = asRecord(asRecord(body, 'body')['error'], 'error');
  const code = error['code'] ?? error['type'];
  return asString(code, 'error.code');
}

// ---------------------------------------------------------------------------------------------
// routes.json

describe('gateway-ingress: the ingress decision', () => {
  it.each(routeVectors)('$id', async ({ input, expected }) => {
    const request = asRecord(input, 'input');
    const outcome = asRecord(expected, 'expected');
    const protocol = asProtocol(request['protocol'], 'protocol');
    const family = asString(request['family'], 'family');
    const token = asString(request['token'], 'token');
    if (token !== 'valid' && token !== 'missing' && token !== 'expired' && token !== 'revoked') {
      throw new Error(`unknown token state ${token}`);
    }
    const tools = asArray(request['tools'], 'tools').map((tool) => ({
      type: asString(tool, 'tool'),
    }));
    // The field this vector asks for vendor-side conversation state with, if any: the rule refuses
    // `previous_response_id` and `conversation` alike, so the vector names which one it sends.
    const vendorStateField = request['vendorStateField'];

    const driven = await drive({
      path: ROUTE_OF[protocol] ?? '',
      family,
      token,
      body: {
        model: asString(request['model'], 'model'),
        stream: asBoolean(request['stream'], 'stream'),
        ...(tools.length === 0 ? {} : { tools }),
        // The two ways a body asks for something the platform refuses without declaring a tool.
        ...(asBoolean(request['webSearchOptions'], 'webSearchOptions')
          ? { web_search_options: {} }
          : {}),
        ...(asBoolean(request['background'], 'background') ? { background: true } : {}),
        ...(typeof vendorStateField === 'string' ? { [vendorStateField]: 'resp_elsewhere' } : {}),
      },
      upstreamResponse: () =>
        new Response('data: {"type":"response.completed"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    });

    if (!asBoolean(outcome['forwarded'], 'forwarded')) {
      expect(driven.upstream, 'a refused request must reach no upstream').toEqual([]);
      expect(driven.response.status).toBe(asNumber(outcome['status'], 'status'));
      expect(refusalCodeOf(await driven.response.json())).toBe(asString(outcome['code'], 'code'));
      return;
    }

    expect(driven.upstream).toHaveLength(1);
    const call = driven.upstream[0];
    if (call === undefined) throw new Error('an upstream call was expected');
    const headers = new Headers(call.init.headers);
    const body = relayedBodyOf(call.init);

    // The relayed endpoint follows the protocol, and the relayed model follows the connection.
    expect(call.url.endsWith(ROUTE_OF[asString(outcome['protocol'], 'protocol')] ?? '')).toBe(true);
    expect(body['model']).toBe(asString(outcome['model'], 'model'));

    // `stream_options.include_usage` on a streamed Chat Completions body, and nowhere else.
    const streamOptions = body['stream_options'];
    const includeUsage =
      streamOptions !== undefined &&
      asRecord(streamOptions, 'stream_options')['include_usage'] === true;
    expect(includeUsage).toBe(asBoolean(outcome['includeUsage'], 'includeUsage'));

    // The substituted credential, in the header the family uses, and the run token nowhere.
    const credentialHeader = asString(outcome['credentialHeader'], 'credentialHeader');
    const credential = asString(outcome['credential'], 'credential');
    expect(headers.get(credentialHeader)).toContain(credential);
    expect(JSON.stringify([...headers])).not.toContain(driven.token);
    expect(JSON.stringify([...driven.response.headers])).not.toContain(credential);
  });
});

// ---------------------------------------------------------------------------------------------
// models.json

describe('gateway-ingress: the model-listing envelope', () => {
  it.each(modelVectors)('$id', async ({ input, expected }) => {
    const request = asRecord(input, 'input');
    const family = asString(request['family'], 'family');
    const query = request['query'];
    const header = request['header'];
    const format = asString(asRecord(expected, 'expected')['format'], 'format');
    // What the Anthropic SDK sends on every request, and the OpenAI SDK on none: the signal D6
    // negotiates on.
    const client = asBoolean(request['anthropicVersion'], 'anthropicVersion')
      ? { 'anthropic-version': '2023-06-01' }
      : {};

    const driven = await drive({
      path: `/v1/models${query === null ? '' : `?format=${asString(query, 'query')}`}`,
      method: 'GET',
      family,
      token: 'valid',
      headers: {
        ...client,
        ...(header === null ? {} : { 'x-gateway-model-format': asString(header, 'header') }),
      },
      upstreamResponse: () =>
        Response.json({
          data: [
            {
              id: 'model-fixture',
              type: 'model',
              display_name: 'Model Fixture',
              created_at: '2026-01-01T00:00:00.000Z',
              created: 1_767_225_600,
            },
          ],
        }),
    });

    expect(driven.response.status).toBe(200);
    const body = asRecord(await driven.response.json(), 'body');
    // The vector is about the envelope, not the catalogue: which models an adapter lists is its
    // own business (the Azure adapter answers with its deployment rather than the stub's body).
    if (format === 'openai') {
      expect(body['object']).toBe('list');
      expect(asArray(body['data'], 'data')[0]).toMatchObject({
        object: 'model',
        owned_by: registryProviderId(connectionProviderOf(family)),
      });
    } else {
      expect(body).not.toHaveProperty('object');
      expect(body).toMatchObject({ has_more: false });
      expect(asString(body['first_id'], 'first_id').length).toBeGreaterThan(0);
    }
    // A model listing carries no model turn, so it is never metered and never fails a run.
    expect(driven.recorded).toEqual([]);
    expect(driven.failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// usage.json

/** Rebuild the SSE wire a provider would have sent for one Lean frame. */
function frameToPayload(protocol: WireProtocol, frame: Record<string, unknown>): string {
  const kind = asString(frame['kind'], 'kind');
  if (protocol === 'anthropic-messages') {
    if (kind === 'usage') {
      return JSON.stringify({
        type: 'message_delta',
        usage: {
          input_tokens: asNumber(frame['inputTokens'], 'inputTokens'),
          output_tokens: asNumber(frame['outputTokens'], 'outputTokens'),
          cache_read_input_tokens: asNumber(frame['cacheReadInputTokens'], 'cacheReadInputTokens'),
          cache_creation_input_tokens: asNumber(
            frame['cacheCreationInputTokens'],
            'cacheCreationInputTokens',
          ),
        },
      });
    }
    if (kind === 'toolBlockStart') {
      return JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tool_1' },
      });
    }
    return JSON.stringify({ type: 'message_stop' });
  }
  if (protocol === 'openai-responses') {
    if (kind === 'created') {
      return JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_1', model: 'gpt-fixture', usage: null },
      });
    }
    if (kind === 'functionCallDone') {
      return JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: asString(frame['itemId'], 'itemId'), type: 'function_call' },
      });
    }
    return JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_1',
        model: 'gpt-fixture',
        output: asArray(frame['items'], 'items').map((id) => ({
          id: asString(id, 'item id'),
          type: 'function_call',
        })),
        usage: {
          input_tokens: asNumber(frame['inputTokens'], 'inputTokens'),
          output_tokens: asNumber(frame['outputTokens'], 'outputTokens'),
          input_tokens_details: { cached_tokens: asNumber(frame['cachedTokens'], 'cachedTokens') },
        },
      },
    });
  }
  const chunk = { id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'gpt-fixture' };
  if (kind === 'toolCallDelta') {
    return JSON.stringify({
      ...chunk,
      choices: [
        {
          index: asNumber(frame['choiceIndex'], 'choiceIndex'),
          delta: { tool_calls: [{ index: asNumber(frame['callIndex'], 'callIndex') }] },
          finish_reason: null,
        },
      ],
      usage: null,
    });
  }
  if (kind === 'finish') {
    return JSON.stringify({
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: null,
    });
  }
  return JSON.stringify({
    ...chunk,
    choices: [],
    usage: {
      prompt_tokens: asNumber(frame['promptTokens'], 'promptTokens'),
      completion_tokens: asNumber(frame['completionTokens'], 'completionTokens'),
      prompt_tokens_details: { cached_tokens: asNumber(frame['cachedTokens'], 'cachedTokens') },
    },
  });
}

/** Small enough to split every frame, and most JSON tokens, across a chunk boundary. */
const SSE_CHUNK_BYTES = 7;

/**
 * The SSE wire for a frame list, delivered in {@link SSE_CHUNK_BYTES}-sized chunks so that the
 * reader's cross-chunk reassembly is exercised by the replay too, and not only by
 * `packages/gateway/src/usage/usage.test.ts`.
 */
function eventStream(payloads: readonly string[]): Response {
  const wire = payloads.map((payload) => `data: ${payload}\n\n`).join('');
  const bytes = new TextEncoder().encode(wire);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += SSE_CHUNK_BYTES) {
        controller.enqueue(bytes.slice(offset, offset + SSE_CHUNK_BYTES));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('gateway-ingress: per-protocol usage extraction', () => {
  it.each(usageVectors)('$id', async ({ input, expected }) => {
    const request = asRecord(input, 'input');
    const outcome = asRecord(expected, 'expected');
    const protocol = asProtocol(request['protocol'], 'protocol');
    const payloads = asArray(request['frames'], 'frames').map((frame) =>
      frameToPayload(protocol, asRecord(frame, 'frame')),
    );
    const counters = asRecord(outcome['counters'], 'counters');

    // 1. The extractor, over a real SSE stream chunked mid-frame, so the reader is exercised too.
    const extracted = await extractResponseUsage(eventStream(payloads), protocol);
    expect({
      inputTokens: extracted.inputTokens,
      outputTokens: extracted.outputTokens,
      cacheReadInputTokens: extracted.cacheReadInputTokens,
      cacheCreationInputTokens: extracted.cacheCreationInputTokens,
      toolCalls: extracted.toolCalls,
    }).toEqual({
      inputTokens: asNumber(counters['inputTokens'], 'inputTokens'),
      outputTokens: asNumber(counters['outputTokens'], 'outputTokens'),
      cacheReadInputTokens: asNumber(counters['cacheReadInputTokens'], 'cacheReadInputTokens'),
      cacheCreationInputTokens: asNumber(
        counters['cacheCreationInputTokens'],
        'cacheCreationInputTokens',
      ),
      toolCalls: asNumber(counters['toolCalls'], 'toolCalls'),
    });
    expect(extracted.metered).toBe(asBoolean(outcome['metered'], 'metered'));
    expect(extracted.completed).toBe(asBoolean(outcome['completed'], 'completed'));

    // 2. The settlement the real metering boundary reaches for the same stream.
    const family = protocol === 'anthropic-messages' ? 'anthropic' : 'openai';
    const driven = await drive({
      path: ROUTE_OF[protocol] ?? '',
      family,
      token: 'valid',
      body: { model: 'a-model', stream: true },
      upstreamResponse: () => eventStream(payloads),
    });
    const settlement = asString(outcome['settlement'], 'settlement');
    if (settlement === 'failed') {
      expect(driven.recorded).toEqual([]);
      expect(driven.failures).toHaveLength(1);
      return;
    }
    expect(driven.failures).toEqual([]);
    expect(driven.recorded).toHaveLength(1);
    expect(driven.recorded[0]).toMatchObject({
      wireProtocol: protocol,
      metered: settlement === 'recorded',
      inputTokens: asNumber(counters['inputTokens'], 'inputTokens'),
      outputTokens: asNumber(counters['outputTokens'], 'outputTokens'),
      cacheReadInputTokens: asNumber(counters['cacheReadInputTokens'], 'cacheReadInputTokens'),
      toolCalls: asNumber(counters['toolCalls'], 'toolCalls'),
    });
  });
});

// ---------------------------------------------------------------------------------------------
// tools.json

const TOOL_CONNECTOR = '66666666-6666-4666-8666-666666666666';

/** A body each model path accepts, and the registry id that serves it. */
const INGRESS_REQUEST: Readonly<
  Record<
    string,
    { readonly method: 'GET' | 'POST'; readonly providerId: RegisteredProviderId; body?: unknown }
  >
> = {
  '/v1/messages': {
    method: 'POST',
    providerId: 'anthropic',
    body: { model: 'fixture', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
  },
  '/v1/messages/count_tokens': {
    method: 'POST',
    providerId: 'anthropic',
    body: { model: 'fixture', messages: [{ role: 'user', content: 'hi' }] },
  },
  '/v1/responses': {
    method: 'POST',
    providerId: 'openai',
    body: { model: 'fixture', input: 'hi' },
  },
  '/v1/chat/completions': {
    method: 'POST',
    providerId: 'openai',
    body: { model: 'fixture', messages: [{ role: 'user', content: 'hi' }] },
  },
  '/v1/models': { method: 'GET', providerId: 'anthropic' },
  '/health': { method: 'GET', providerId: 'anthropic' },
  '/v1/tools/:connectorId/mcp': {
    method: 'POST',
    providerId: 'anthropic',
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'formal-replay', version: '1.0.0' },
      },
    },
  },
  '/v1/tool-sandbox/mcp': {
    method: 'POST',
    providerId: 'anthropic',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  },
  '/v1/tool-sandbox/endpoint/mcp': {
    method: 'POST',
    providerId: 'anthropic',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  },
};

const ENDPOINT_PATH = '/v1/tool-sandbox/endpoint/mcp';

function ingressApplication(providerId: RegisteredProviderId): {
  readonly gateway: ReturnType<typeof createGatewayApplication>;
  readonly calls: { resolver: number; tools: number; settled: number };
} {
  const calls = { resolver: 0, tools: 0, settled: 0 };
  const gateway = createGatewayApplication({
    tokenSecret: SECRET,
    // One body every upstream call accepts: a response id, a token count and an empty listing.
    providers: {
      fetch: () =>
        Promise.resolve(Response.json({ id: 'resp_fixture', input_tokens: 3, data: [] })),
    },
    resolver: {
      resolve: () => {
        calls.resolver += 1;
        return Promise.resolve({
          state: 'active',
          providerId,
          connectionProvider: providerId,
          credential: CREDENTIAL,
          settings: { baseUrl: 'http://localhost/v1', deployment: DEPLOYMENT },
        });
      },
    },
    usage: {
      record: () => {
        calls.settled += 1;
        return Promise.resolve();
      },
      fail: () => {
        calls.settled += 1;
        return Promise.resolve();
      },
    },
    onUsageError: () => undefined,
    toolSandbox: {
      resolve: () => {
        calls.tools += 1;
        return Promise.resolve({ ok: true, origin: 'http://tool-sandbox.test:9000' });
      },
    },
    toolSandboxFetch: () => Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result: {} })),
    tools: {
      resolve: () => {
        calls.tools += 1;
        return Promise.resolve({
          ok: true,
          connector: {
            config: OpenApiToolConfigSchema.parse({
              spec: { digest: `sha256:${'a'.repeat(64)}`, bytes: 1 },
              baseUrl: 'https://tools.example.test/api',
              auth: 'none',
              allow: ['GET /**'],
              operations: [{ name: 'listPets', method: 'GET', path: '/pets' }],
            }),
            parameters: {},
            credential: () => Promise.resolve(null),
          },
        });
      },
    },
  });
  return { gateway, calls };
}

describe('gateway-ingress: the application route table', () => {
  it('serves exactly the paths of the vectors, in order', () => {
    const { gateway } = ingressApplication('anthropic');
    expect(gateway.routes.map((route) => route.path)).toEqual(
      ingressVectors.map(({ id, input }) => asString(asRecord(input, id)['path'], 'path')),
    );
  });

  it.each(ingressVectors)('$id', async ({ id, input, expected }) => {
    const path = asString(asRecord(input, id)['path'], 'path');
    const outcome = asRecord(expected, id);
    const shape = INGRESS_REQUEST[path];
    if (shape === undefined) throw new Error(`${id}: no request for ${path}`);
    const { gateway, calls } = ingressApplication(shape.providerId);
    const token =
      path === ENDPOINT_PATH
        ? await createEndpointGrantCodec({ secret: SECRET }).issue({
            workspaceId: SUBJECT.workspaceId,
            clientId: 'client-1',
            origin: 'http://tool-sandbox.test:9000',
          })
        : await createRunTokenCodec({ secret: SECRET }).issue(SUBJECT);
    const response = await gateway.fetch(
      new Request(`http://gateway:4000${path.replace(':connectorId', TOOL_CONNECTOR)}`, {
        method: shape.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json, text/event-stream',
          ...(shape.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(shape.method === 'POST' ? { body: JSON.stringify(shape.body) } : {}),
      }),
    );
    // Settlement gates the end of the body, so reading it first makes the recorder observable.
    await response.text();
    expect(response.status).toBe(200);
    expect(calls.resolver > 0).toBe(asBoolean(outcome['resolvesModelKey'], 'resolvesModelKey'));
    expect(calls.settled > 0).toBe(asBoolean(outcome['metered'], 'metered'));
    expect(calls.tools > 0).toBe(
      path.startsWith('/v1/tools/') ||
        (path.startsWith('/v1/tool-sandbox/') && path !== ENDPOINT_PATH),
    );
  });
});
