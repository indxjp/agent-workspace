import { expect, it } from 'vitest';

import { createRouter } from './router.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import {
  createAuthenticatedGateway,
  type GatewayRunResolver,
  type GatewayUsageRecord,
} from './auth.js';

import { createRunTokenCodec } from './tokens/run-token.js';
import type { GatewayRouter } from './types.js';

import { SUBJECT, SECRET, activeResolver, usageRecorder } from './auth.fixture.test-support.js';

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
    resolve: (_claims, tokenHash) => {
      resolvedTokenHash = tokenHash;
      return Promise.resolve({
        state: 'active',
        providerId: 'anthropic',
        connectionProvider: 'anthropic',
        credential: 'provider-master-key',
        settings: {},
      });
    },
  };
  const recorded: GatewayUsageRecord[] = [];
  const gateway = createAuthenticatedGateway(
    createRouter([provider]),
    tokens,
    resolver,
    usageRecorder(recorded),
  );
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
    usageRecorder(recorded),
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
    activeResolver(),
    usageRecorder(recorded),
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
