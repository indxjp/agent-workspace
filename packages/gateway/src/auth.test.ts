import { describe, expect, it } from 'vitest';

import { createRouter } from './router.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import {
  authenticateGatewayRequest,
  createAuthenticatedGateway,
  verifyRunToken,
  type GatewayRunResolver,
  type GatewayUsageRecord,
  type UsageRecorder,
} from './auth.js';
import { createRunTokenCodec, type RunTokenSubject } from './tokens/run-token.js';
import type { GatewayRouter } from './types.js';

const SUBJECT: RunTokenSubject = {
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: '55555555-5555-4555-8555-555555555555',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  agentId: '33333333-3333-4333-8333-333333333333',
  modelConnectionId: '44444444-4444-4444-8444-444444444444',
};
const SECRET = 'fixture-signing-secret-that-is-longer-than-32-bytes';

function errorCode(response: Response): Promise<string> {
  return response
    .json()
    .then((value: unknown) => (value as { error: { code: string } }).error.code);
}

describe('gateway run authentication', () => {
  it('uses a valid run token to inject the master key upstream, never into the caller', async () => {
    const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
    const token = await tokens.issue(SUBJECT);
    let upstreamCredential = '';
    const provider = createAnthropicProvider({
      baseUrl: 'http://localhost:9999',
      fetch: (_input, init) => {
        upstreamCredential = new Headers(init?.headers).get('x-api-key') ?? '';
        return Promise.resolve(
          Response.json({
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            model: 'claude-fixture',
            content: [{ type: 'text', text: 'safe response' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
        );
      },
    });
    let resolvedTokenHash = '';
    const resolver: GatewayRunResolver = {
      resolve: (claims, tokenHash) => {
        resolvedTokenHash = tokenHash;
        return Promise.resolve({
          state: 'active',
          providerId: 'anthropic',
          connectionProvider: 'anthropic',
          credential: 'provider-master-key',
          settings: { connectionId: claims.modelConnectionId },
        });
      },
    };
    const recorded: GatewayUsageRecord[] = [];
    const gateway = createAuthenticatedGateway(createRouter([provider]), tokens, resolver, {
      record(usage) {
        recorded.push(usage);
        return Promise.resolve();
      },
      fail: () => Promise.resolve(),
    });
    const callerEnvironment = {
      ANTHROPIC_BASE_URL: 'http://gateway:4000',
      ANTHROPIC_AUTH_TOKEN: token,
    };
    const response = await gateway.fetch(
      new Request('http://gateway:4000/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${callerEnvironment.ANTHROPIC_AUTH_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude-fixture', messages: [] }),
      }),
    );

    expect(response.status).toBe(200);
    // No extra tick awaited: a non-streaming response is settled *before* `fetch` returns it
    // (issue #134), so this is already true the instant `gateway.fetch` resolves above — a
    // regression to the old fire-and-forget `void recordResponseUsage(...)` would fail this.
    expect(recorded).toEqual([
      {
        runId: SUBJECT.runId,
        providerResponseId: 'msg_fixture',
        provider: 'anthropic',
        model: 'claude-fixture',
        inputTokens: 3,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        toolCalls: 0,
        wireProtocol: 'anthropic-messages',
        metered: true,
      },
    ]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    expect(resolvedTokenHash).toBe(
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
    expect(upstreamCredential).toBe('provider-master-key');
    expect(JSON.stringify(await response.json())).not.toContain('provider-master-key');
    expect(Object.values(callerEnvironment)).not.toContain('provider-master-key');
  });

  it('records usage under the connection provider, not the registry row', async () => {
    const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
    const token = await tokens.issue(SUBJECT);
    const routed: string[] = [];
    const router: GatewayRouter = {
      routes: [],
      fetch: (_request, context) => {
        routed.push(context?.providerId ?? '');
        return Promise.resolve(
          Response.json({
            id: 'msg_compatible',
            type: 'message',
            role: 'assistant',
            model: 'proxy-model',
            content: [],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
        );
      },
    };
    const recorded: GatewayUsageRecord[] = [];
    const gateway = createAuthenticatedGateway(
      router,
      tokens,
      {
        resolve: () =>
          Promise.resolve({
            state: 'active',
            providerId: 'anthropic',
            connectionProvider: 'anthropic-compatible',
            credential: 'provider-master-key',
          }),
      },
      {
        record(usage) {
          recorded.push(usage);
          return Promise.resolve();
        },
        fail: () => Promise.resolve(),
      },
    );
    const response = await gateway.fetch(
      new Request('http://gateway:4000/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'proxy-model', messages: [] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(routed).toEqual(['anthropic']);
    expect(recorded.map((usage) => usage.provider)).toEqual(['anthropic-compatible']);
  });

  it('merges streaming usage snapshots and counts tool calls without buffering the caller', async () => {
    const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
    const token = await tokens.issue(SUBJECT);
    const wire = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_stream","model":"claude-stream","usage":{"input_tokens":12,"output_tokens":0,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tool_1","name":"fixture"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":7}}',
      '',
    ].join('\n');
    const provider = createAnthropicProvider({
      baseUrl: 'http://localhost:9999',
      fetch: () =>
        Promise.resolve(
          new Response(wire, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        ),
    });
    const recorded: GatewayUsageRecord[] = [];
    const gateway = createAuthenticatedGateway(
      createRouter([provider]),
      tokens,
      {
        resolve: () =>
          Promise.resolve({
            state: 'active',
            providerId: 'anthropic',
            connectionProvider: 'anthropic',
            credential: 'provider-master-key',
          }),
      },
      {
        record(usage) {
          recorded.push(usage);
          return Promise.resolve();
        },
        fail: () => Promise.resolve(),
      },
    );
    const response = await gateway.fetch(
      new Request('http://gateway/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-stream', stream: true, messages: [] }),
      }),
    );
    expect(await response.text()).toBe(wire);
    // No extra tick awaited: `.text()` only resolves once the stream's end-of-body is signalled,
    // and that signal is gated on settlement completing (issue #134) — so it is already recorded.
    expect(recorded).toEqual([
      {
        runId: SUBJECT.runId,
        providerResponseId: 'msg_stream',
        provider: 'anthropic',
        model: 'claude-stream',
        inputTokens: 12,
        outputTokens: 7,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 2,
        toolCalls: 1,
        wireProtocol: 'anthropic-messages',
        metered: true,
      },
    ]);
  });

  it('refuses a token for run A when run B is requested', async () => {
    const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
    const resolver: GatewayRunResolver = {
      resolve: () => Promise.resolve({ state: 'missing' }),
    };
    const result = await authenticateGatewayRequest(
      new Request('http://gateway/v1/messages', {
        headers: { authorization: `Bearer ${await tokens.issue(SUBJECT)}` },
      }),
      tokens,
      resolver,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(403);
    await expect(errorCode(result.response)).resolves.toBe('token_run_mismatch');
  });

  it('refuses an expired token with its own status and code', async () => {
    let now = 1000;
    const tokens = createRunTokenCodec({ secret: SECRET, ttlSeconds: 60, now: () => now });
    const token = await tokens.issue(SUBJECT);
    now = 1060;
    const result = await authenticateGatewayRequest(
      new Request('http://gateway/v1/messages', {
        headers: { authorization: `Bearer ${token}` },
      }),
      tokens,
      { resolve: () => Promise.resolve({ state: 'missing' }) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(401);
    await expect(errorCode(result.response)).resolves.toBe('token_expired');
  });

  it('refuses a token whose run has been deleted with its own status and code', async () => {
    const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
    const result = await authenticateGatewayRequest(
      new Request('http://gateway/v1/messages', {
        headers: { authorization: `Bearer ${await tokens.issue(SUBJECT)}` },
      }),
      tokens,
      { resolve: () => Promise.resolve({ state: 'deleted' }) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(410);
    await expect(errorCode(result.response)).resolves.toBe('run_deleted');
  });

  it('refuses an individually revoked token before provider resolution', async () => {
    const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
    const result = await authenticateGatewayRequest(
      new Request('http://gateway/v1/messages', {
        headers: { authorization: `Bearer ${await tokens.issue(SUBJECT)}` },
      }),
      tokens,
      { resolve: () => Promise.resolve({ state: 'revoked' }) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(401);
    await expect(errorCode(result.response)).resolves.toBe('token_revoked');
  });

  /** A stub router under full test control, bypassing the real provider adapters. */
  function routerReturning(response: Response): GatewayRouter {
    return { routes: [], fetch: () => Promise.resolve(response) };
  }

  async function issuedGateway(
    recorder: UsageRecorder,
    response: Response,
    settlementTimeoutMs?: number,
  ): Promise<{ gateway: Pick<GatewayRouter, 'fetch'>; token: string }> {
    const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
    const token = await tokens.issue(SUBJECT);
    const gateway = createAuthenticatedGateway(
      routerReturning(response),
      tokens,
      {
        resolve: () =>
          Promise.resolve({
            state: 'active',
            providerId: 'anthropic',
            connectionProvider: 'anthropic',
            credential: 'k',
          }),
      },
      recorder,
      () => undefined,
      settlementTimeoutMs,
    );
    return { gateway, token };
  }

  it('holds a streamed response open until settlement completes, without delaying its bytes', async () => {
    const encoder = new TextEncoder();
    const frame =
      'data: {"type":"message_start","message":{"id":"msg_gate","model":"claude-fixture","usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    let settled = false;
    const recorder: UsageRecorder = {
      record: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            settled = true;
            resolve();
          }, 30);
        }),
      fail: () => Promise.resolve(),
    };
    const { gateway, token } = await issuedGateway(
      recorder,
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      5_000,
    );
    const response = await gateway.fetch(
      new Request('http://gateway/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-fixture', stream: true, messages: [] }),
      }),
    );
    // The bytes are readable immediately — settlement being in flight never delays delivery.
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('expected a body');
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(settled).toBe(false);
    // But the stream's *end* — the second read reporting done — waits for settlement.
    const second = await reader.read();
    expect(second.done).toBe(true);
    expect(settled).toBe(true);
  });

  it('times out a stream past a bounded wait rather than hanging on a settlement that never finishes', async () => {
    const encoder = new TextEncoder();
    const frame =
      'data: {"type":"message_start","message":{"id":"msg_timeout","model":"claude-fixture","usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    const recorder: UsageRecorder = {
      record: () => new Promise(() => undefined), // never resolves
      fail: () => Promise.resolve(),
    };
    const { gateway, token } = await issuedGateway(
      recorder,
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      25,
    );
    const response = await gateway.fetch(
      new Request('http://gateway/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-fixture', stream: true, messages: [] }),
      }),
    );
    const started = Date.now();
    await expect(response.text()).resolves.toBe(frame);
    // Bounded by the 25ms timeout, not by the settlement that never resolves. A generous margin
    // keeps this from being timing-flaky while still failing if the bound were dropped entirely.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  /**
   * The two shapes a real Anthropic Messages 200 without `usage` actually arrives in. Both declare
   * themselves finished — a non-streaming body through `type: "message"`, a stream through
   * `message_stop` — which is why a fixture that omits them cannot guard this rule at all: it
   * settles for the wrong reason. Anthropic's rule is `failed` either way (ADR-0068 D9), and
   * `unavailable` belongs to the two OpenAI dialects only.
   */
  const ANTHROPIC_RESPONSES_WITHOUT_USAGE = [
    [
      'a non-streaming body',
      () =>
        Response.json({
          id: 'msg_no_usage',
          type: 'message',
          model: 'claude-fixture',
          content: [],
        }),
    ],
    [
      'a stream that ended with message_stop',
      () =>
        new Response(
          'data: {"type":"message_start","message":{"id":"msg_no_usage","model":"claude-fixture"}}\n\ndata: {"type":"message_stop"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    ],
  ] as const;

  it.each(ANTHROPIC_RESPONSES_WITHOUT_USAGE)(
    'marks the run failed via fail(), and never calls record(), for %s with no usage fields',
    async (_shape, respond) => {
      const recorded: unknown[] = [];
      const failed: { runId: string; reason: string }[] = [];
      const recorder: UsageRecorder = {
        record: (usage) => {
          recorded.push(usage);
          return Promise.resolve();
        },
        fail: (runId, reason) => {
          failed.push({ runId, reason });
          return Promise.resolve();
        },
      };
      const { gateway, token } = await issuedGateway(recorder, respond());
      const response = await gateway.fetch(
        new Request('http://gateway/v1/messages', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-fixture',
            messages: [{ secret: 'provider-body-marker' }],
          }),
        }),
      );
      // A streamed body settles on its end of stream, so it has to be drained before asserting.
      await response.text();

      expect(recorded).toEqual([]);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.runId).toBe(SUBJECT.runId);
      expect(failed[0]?.reason).toContain('no authoritative usage fields');
      // The redaction this settlement path exists to guarantee: never the caller's own request or
      // provider body content in the reason string an operator's audit trail will hold.
      expect(failed[0]?.reason).not.toContain('provider-body-marker');
    },
  );
});

describe('seam check 2: the tool route needs no model key and is never metered', () => {
  const TOOL_PATH = 'http://gateway/v1/tools/66666666-6666-4666-8666-666666666666/mcp';

  it('verifies a run token from the codec alone, with nothing resolved', async () => {
    const tokens = createRunTokenCodec({ secret: SECRET });
    const token = await tokens.issue(SUBJECT);
    const verified = await verifyRunToken(
      new Request(TOOL_PATH, { method: 'POST', headers: { authorization: `Bearer ${token}` } }),
      tokens,
    );
    expect(verified).toMatchObject({ ok: true, claims: SUBJECT });
    if (!verified.ok) throw new Error('expected a verified token');
    expect(verified.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('records no usage for a tool path even behind the authenticated model boundary', async () => {
    const tokens = createRunTokenCodec({ secret: SECRET });
    const token = await tokens.issue(SUBJECT);
    const recorded: GatewayUsageRecord[] = [];
    const failed: string[] = [];
    const router: GatewayRouter = {
      routes: [],
      fetch: () => Promise.resolve(Response.json({ usage: { input_tokens: 1, output_tokens: 1 } })),
    };
    const gateway = createAuthenticatedGateway(
      router,
      tokens,
      {
        resolve: () =>
          Promise.resolve({
            state: 'active',
            providerId: 'anthropic',
            connectionProvider: 'anthropic',
            credential: 'model-key',
          }),
      },
      {
        record(usage) {
          recorded.push(usage);
          return Promise.resolve();
        },
        fail(runId) {
          failed.push(runId);
          return Promise.resolve();
        },
      },
    );
    const response = await gateway.fetch(
      new Request(TOOL_PATH, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(recorded).toEqual([]);
    expect(failed).toEqual([]);
  });
});
