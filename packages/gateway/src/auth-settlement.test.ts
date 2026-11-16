import { expect, it } from 'vitest';

import { createAuthenticatedGateway, type UsageRecorder } from './auth.js';

import { createRunTokenCodec } from './tokens/run-token.js';

import { SUBJECT, SECRET, routerReturning, issuedGateway } from './auth.fixture.test-support.js';

it('hands a settlement failure the request it belongs to, for its trace id (F-04)', async () => {
  const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
  const token = await tokens.issue(SUBJECT);
  const failures: { error: unknown; traceparent: string | null }[] = [];
  const gateway = createAuthenticatedGateway(
    routerReturning(
      Response.json({
        id: 'msg_fail',
        model: 'claude-fixture',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ),
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
    { record: () => Promise.reject(new Error('ledger down')), fail: () => Promise.resolve() },
    (error, request) => {
      failures.push({ error, traceparent: request.headers.get('traceparent') });
    },
  );
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  await gateway.fetch(
    new Request('http://gateway/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, traceparent },
      body: JSON.stringify({ model: 'claude-fixture', messages: [] }),
    }),
  );
  expect(failures).toEqual([{ error: new Error('ledger down'), traceparent }]);
});

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
