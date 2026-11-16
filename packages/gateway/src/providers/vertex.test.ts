import { describe, expect, it, vi } from 'vitest';

import { createJsonLogger, type LogLevel } from '@agent-workspace/core/telemetry';
import { VERTEX_CLAUDE_MODELS, type VertexLocation } from '@indx-workspace/contracts/models';

import { createRouter } from '../router.js';
import type { AnthropicMessageRequest, ModelProvider, RequestContext } from '../types.js';
import { loggedFetch } from '../upstream-log.js';
import { createAnthropicProvider } from './anthropic.js';
import { createProviderRegistry } from './registry.js';
import { vertexModels, vertexTarget } from './vertex.js';

const TOKEN = 'ya29.vertex-token-that-must-never-leak';
const PROJECT = 'my-project-123';

const context = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  providerId: 'vertex',
  credential: TOKEN,
  requestId: 'vertex-test',
  settings: { projectId: PROJECT },
  ...overrides,
});

function vertexProvider(request: typeof fetch, location: VertexLocation = 'global'): ModelProvider {
  return createAnthropicProvider({
    fetch: request,
    models: vertexModels(),
    target: vertexTarget({ projectId: PROJECT, location }),
  });
}

const ok = () => Response.json({ id: 'msg_1', type: 'message', usage: {} });
const messageBody = (extra: Record<string, unknown> = {}): AnthropicMessageRequest => ({
  model: 'claude-sonnet-5-5',
  max_tokens: 8,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

function firstCall(request: ReturnType<typeof vi.fn<typeof fetch>>) {
  const [url, init] = request.mock.calls[0] ?? [];
  const body = init?.body;
  return {
    url: typeof url === 'string' ? url : '',
    headers: new Headers(init?.headers),
    body: typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : undefined,
  };
}

async function refusalOf(
  body: AnthropicMessageRequest,
): Promise<{ status: number; error: Record<string, unknown>; calls: number }> {
  const request = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(ok()));
  const response = await vertexProvider(request).createMessage(body, context());
  const parsed = (await response.json()) as { error: Record<string, unknown> };
  return { status: response.status, error: parsed.error, calls: request.mock.calls.length };
}

describe('the Vertex request builder', () => {
  it.each([
    ['global', 'https://aiplatform.googleapis.com'],
    ['us', 'https://aiplatform.us.rep.googleapis.com'],
    ['eu', 'https://aiplatform.eu.rep.googleapis.com'],
  ] as const)('addresses the %s location at its own host', async (location, host) => {
    const request = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(ok()));
    await vertexProvider(request, location).createMessage(messageBody(), context());
    expect(firstCall(request).url).toBe(
      `${host}/v1/projects/${PROJECT}/locations/${location}/publishers/anthropic/models/claude-sonnet-5-5:rawPredict`,
    );
  });

  it('streams through streamRawPredict only when body.stream is true', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(ok()));
    const provider = vertexProvider(request);
    await provider.createMessage(messageBody({ stream: true }), context());
    await provider.createMessage(messageBody({ stream: false }), context());
    expect(request.mock.calls[0]?.[0]).toMatch(/:streamRawPredict$/u);
    expect(request.mock.calls[1]?.[0]).toMatch(/:rawPredict$/u);
  });

  it('drops model and adds the vertex anthropic_version', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(ok()));
    await vertexProvider(request).createMessage(messageBody(), context());
    const { body } = firstCall(request);
    expect(body).not.toHaveProperty('model');
    expect(body).toMatchObject({ anthropic_version: 'vertex-2023-10-16', max_tokens: 8 });
  });

  it('uses anthropic_version 2026-10-21 when the client sent that version', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(ok()));
    await vertexProvider(request).createMessage(
      messageBody(),
      context({ requestHeaders: new Headers({ 'anthropic-version': '2026-10-21' }) }),
    );
    expect(firstCall(request).body).toMatchObject({ anthropic_version: '2026-10-21' });
  });

  it('authenticates with the bearer token and forwards only anthropic-beta', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(ok()));
    await vertexProvider(request).createMessage(
      messageBody(),
      context({
        requestHeaders: new Headers({
          authorization: 'Bearer gateway-run-token',
          'x-api-key': 'caller-key',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'context-management-2025-06-27',
        }),
      }),
    );
    const { headers } = firstCall(request);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('anthropic-version')).toBeNull();
    expect(headers.get('anthropic-beta')).toBe('context-management-2025-06-27');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('rejects a model id outside the allowed alphabet before any upstream call', async () => {
    const refused = await refusalOf(messageBody({ model: '../../other:rawPredict' }));
    expect(refused.status).toBe(400);
    expect(refused.calls).toBe(0);
  });

  it('answers the static model list without calling Google', async () => {
    const request = vi.fn<typeof fetch>();
    const models = await vertexProvider(request).listModels(context());
    expect(models.map((model) => model.id)).toEqual(VERTEX_CLAUDE_MODELS.map((model) => model.id));
    expect(models.every((model) => model.type === 'model')).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('has no token counting', () => {
    expect('countTokens' in vertexProvider(vi.fn<typeof fetch>())).toBe(false);
  });
});

describe('features Vertex does not serve', () => {
  const unsupported: readonly [string, Record<string, unknown>, string][] = [
    [
      'mcp_servers',
      { mcp_servers: [{ type: 'url', url: 'https://x.example', name: 'x' }] },
      'mcp_servers',
    ],
    ['container', { container: 'container_1' }, 'container'],
    ['fallbacks', { fallbacks: [{ model: 'claude-haiku-5-5' }] }, 'fallbacks'],
    [
      'code execution',
      { tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] },
      'code_execution_20250825',
    ],
    [
      'web fetch',
      { tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] },
      'web_fetch_20250910',
    ],
    ['advisor', { tools: [{ type: 'advisor_20251201', name: 'advisor' }] }, 'advisor_20251201'],
    [
      'url image',
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: 'https://x.example/a.png' } }],
          },
        ],
      },
      'source.type "url"',
    ],
    [
      'file document',
      {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't',
                content: [{ type: 'document', source: { type: 'file', file_id: 'f' } }],
              },
            ],
          },
        ],
      },
      'source.type "file"',
    ],
  ];

  it.each(unsupported)(
    'refuses %s with a typed 400 and no upstream call',
    async (_name, extra, named) => {
      const refused = await refusalOf(messageBody(extra));
      expect(refused.status).toBe(400);
      expect(refused.calls).toBe(0);
      expect(refused.error).toMatchObject({
        type: 'invalid_request_error',
        code: 'vertex_unsupported_feature',
      });
      expect(String(refused.error['message'])).toContain(named);
    },
  );

  it('still serves base64 images and the web_search tool', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(ok()));
    const response = await vertexProvider(request).createMessage(
      messageBody({
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
            ],
          },
        ],
      }),
      context(),
    );
    expect(response.status).toBe(200);
  });
});

describe('a 401 from Vertex', () => {
  it('renews the token once and replays the request once', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: { code: 401, message: 'expired' } }, { status: 401 }),
      )
      .mockResolvedValueOnce(ok());
    const refresh = vi.fn(() => Promise.resolve('ya29.fresh'));
    const response = await vertexProvider(request).createMessage(
      messageBody(),
      context({ refreshCredential: refresh }),
    );
    expect(response.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer ya29.fresh',
    );
  });

  it('gives up after the one replay and answers the second 401 in the Anthropic shape', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ error: { code: 401, message: 'denied' } }, { status: 401 }),
        ),
      );
    const refresh = vi.fn(() => Promise.resolve('ya29.fresh'));
    const response = await vertexProvider(request).createMessage(
      messageBody(),
      context({ refreshCredential: refresh }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { type: 'authentication_error' } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('is relayed without a retry when the connection has no way to renew the token', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ error: { message: 'x' } }, { status: 401 })),
      );
    const response = await vertexProvider(request).createMessage(messageBody(), context());
    expect(response.status).toBe(401);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('Google-shaped errors', () => {
  const google = (status: number, code: string) =>
    Response.json(
      { error: { code: status, status: code, message: `google says ${code}` } },
      { status },
    );

  it.each([
    [429, 'RESOURCE_EXHAUSTED', 'rate_limit_error'],
    [529, 'OVERLOADED', 'overloaded_error'],
    [503, 'UNAVAILABLE', 'overloaded_error'],
    [400, 'INVALID_ARGUMENT', 'invalid_request_error'],
    [403, 'PERMISSION_DENIED', 'permission_error'],
    [500, 'INTERNAL', 'api_error'],
  ])('maps %i %s to %s', async (status, code, type) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(google(status, code));
    const response = await vertexProvider(request).createMessage(messageBody(), context());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type, message: `google says ${code}` },
    });
  });

  it('keeps retry-after so the SDK can back off', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { message: 'slow down' } },
          { status: 429, headers: { 'retry-after': '7' } },
        ),
      );
    const response = await vertexProvider(request).createMessage(messageBody(), context());
    expect(response.headers.get('retry-after')).toBe('7');
  });

  it('relays an Anthropic-shaped error body unchanged', async () => {
    const body = { type: 'error', error: { type: 'rate_limit_error', message: 'anthropic says' } };
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status: 429 }));
    const response = await vertexProvider(request).createMessage(messageBody(), context());
    expect(await response.json()).toEqual(body);
  });

  it('answers a body that is not JSON with a generic message', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>', { status: 502 }));
    const response = await vertexProvider(request).createMessage(messageBody(), context());
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'Vertex AI answered HTTP 502.' },
    });
  });
});

describe('the registry row', () => {
  it('builds the target from the connection and defaults the location to global', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(ok()));
    const row = createProviderRegistry({ fetch: request, scripted: null }).find(
      (provider) => provider.id === 'vertex',
    );
    expect(row?.capabilities.tokenCounting).toBe(false);
    // Verified live for the Anthropic API only (model-providers-live.yml), never on Vertex.
    expect(row?.capabilities.promptCaching).toBe(false);
    await row?.createMessage(messageBody(), context());
    expect(firstCall(request).url).toContain('https://aiplatform.googleapis.com/');
    expect(firstCall(request).url).toContain(`/projects/${PROJECT}/locations/global/`);
  });

  it('honours the connection location', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(ok()));
    const row = createProviderRegistry({ fetch: request, scripted: null }).find(
      (provider) => provider.id === 'vertex',
    );
    await row?.createMessage(
      messageBody(),
      context({ settings: { projectId: PROJECT, location: 'eu' } }),
    );
    expect(firstCall(request).url).toContain('https://aiplatform.eu.rep.googleapis.com/');
  });
});

describe('the token never reaches a log or a client', () => {
  it('stays out of every log line and response body, on success and on every error path', async () => {
    const lines: string[] = [];
    const log = createJsonLogger({
      service: 'gateway',
      write: (_level: LogLevel, line: string) => lines.push(line),
    });
    const answers: Response[] = [
      ok(),
      Response.json({ error: { code: 429, message: 'quota' } }, { status: 429 }),
      Response.json({ error: { code: 529, message: 'busy' } }, { status: 529 }),
      Response.json({ error: { code: 401, message: 'no' } }, { status: 401 }),
      Response.json({ error: { code: 401, message: 'no' } }, { status: 401 }),
      new Response('not json', { status: 500 }),
    ];
    const base = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(answers.shift() ?? ok()));
    const router = createRouter(
      createProviderRegistry({ fetch: loggedFetch(log, base), scripted: null }),
    );
    const send = async (extra: Record<string, unknown>, ctx: RequestContext) => {
      const response = await router.fetch(
        new Request('http://gateway.local/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...messageBody(), ...extra }),
        }),
        ctx,
      );
      return response.text();
    };
    const refresh = () => Promise.resolve('ya29.second-token-that-must-never-leak');
    const bodies = [
      await send({}, context()),
      await send({}, context()),
      await send({}, context()),
      await send({}, context({ refreshCredential: refresh })),
      await send({ mcp_servers: [] }, context()),
      await send({}, context()),
      await send({ model: 'bad model' }, context()),
    ];
    const failing = () => Promise.reject(new Error('metadata server said ' + TOKEN));
    await router
      .fetch(
        new Request('http://gateway.local/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...messageBody(), stream: true }),
        }),
        context({ refreshCredential: failing }),
      )
      .catch(() => undefined);

    const everything = [...lines, ...bodies].join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('ya29.second');
    expect(lines.every((line) => line.includes('aiplatform.googleapis.com'))).toBe(true);
    expect(everything).not.toContain('/v1/projects');
  });
});
