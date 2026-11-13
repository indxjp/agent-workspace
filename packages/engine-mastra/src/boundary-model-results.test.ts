import type { EngineFrame } from '@agent-workspace/engine';
import { expect, it } from 'vitest';

import {
  GATEWAY,
  TOKEN,
  chatCompletion,
  drain,
  request,
  scriptedGateway,
  slowText,
  text,
  workspace,
} from './boundary.test-support.js';
import { createMastraEngine } from './engine.js';

it('reaches an OpenAI-family connection through its own route, and nothing else', async () => {
  const cwd = workspace();
  scriptedGateway.script = [chatCompletion('hello from chat')];
  const frames = await drain(
    createMastraEngine().start(
      request(cwd, {
        gateway: { baseUrl: GATEWAY, token: TOKEN, protocol: 'openai-chat-completions' },
      }),
    ).frames,
  );
  expect(scriptedGateway.seen.map((entry) => [entry.url, entry.authorization])).toEqual([
    [`${GATEWAY}/v1/chat/completions`, `Bearer ${TOKEN}`],
  ]);
  expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'end_turn' });

  scriptedGateway.seen.length = 0;
  scriptedGateway.script = [
    new Response(JSON.stringify({ error: { message: 'scripted refusal' } }), { status: 400 }),
  ];
  await drain(
    createMastraEngine().start(
      request(cwd, { gateway: { baseUrl: GATEWAY, token: TOKEN, protocol: 'openai-responses' } }),
    ).frames,
  ).catch(() => undefined);
  expect(scriptedGateway.seen.map((entry) => [entry.url, entry.authorization])).toEqual([
    [`${GATEWAY}/v1/responses`, `Bearer ${TOKEN}`],
  ]);
});

it('forwards a finish that follows an error chunk as agent.native, after the error result', async () => {
  const cwd = workspace();
  scriptedGateway.script = [
    new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'no' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
  ];
  const frames = await drain(createMastraEngine().start(request(cwd)).frames);
  const results = frames.filter((frame) => frame.frame === 'agent.result');
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ stopReason: 'error' });
  const errorAt = frames.indexOf(results[0] as EngineFrame);
  expect(
    frames
      .slice(errorAt + 1)
      .some((frame) => frame.frame === 'agent.native' && frame.type === 'finish'),
  ).toBe(true);
});

it.each([401, 403] as const)(
  'fails fast and clearly when the provider answers %i, after the error result',
  async (status) => {
    const cwd = workspace();
    scriptedGateway.script = [
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'bad' },
        }),
        { status, headers: { 'content-type': 'application/json' } },
      ),
    ];
    const frames: EngineFrame[] = [];
    const failure = await (async () => {
      for await (const frame of createMastraEngine().start(request(cwd)).frames) {
        frames.push(frame);
      }
    })().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      message: `model_credential_rejected: the model provider rejected the API key (HTTP ${String(status)}).`,
    });
    expect(frames.filter((frame) => frame.frame === 'agent.result')).toHaveLength(1);
    expect(scriptedGateway.seen).toHaveLength(1);
  },
);

it("leaves the gateway's own token refusal as the plain error result", async () => {
  const cwd = workspace();
  scriptedGateway.script = [
    new Response(JSON.stringify({ error: { code: 'token_expired', message: 'expired' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  ];
  const frames = await drain(createMastraEngine().start(request(cwd)).frames);
  expect(frames.filter((frame) => frame.frame === 'agent.result')).toMatchObject([
    { stopReason: 'error' },
  ]);
});

it('ends a run interrupted mid-answer cancelled, and sends no further request', async () => {
  const cwd = workspace();
  scriptedGateway.script = [slowText('Hel'), text('never sent')];
  const connection = createMastraEngine().start(request(cwd));
  const frames: EngineFrame[] = [];
  for await (const frame of connection.frames) {
    frames.push(frame);
    if (frame.frame === 'agent.message.delta') await connection.interrupt();
  }
  expect(frames.some((frame) => frame.frame === 'agent.message.delta')).toBe(true);
  expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'cancelled' });
  expect(scriptedGateway.seen).toHaveLength(1);
});

it('ends an interrupted run cancelled without calling the model', async () => {
  const cwd = workspace();
  const connection = createMastraEngine().start(request(cwd));
  await connection.interrupt();
  const frames = await drain(connection.frames);
  expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'cancelled' });
  expect(scriptedGateway.seen).toEqual([]);
});
