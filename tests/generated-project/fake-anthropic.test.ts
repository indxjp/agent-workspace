import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FAKE_MODELS,
  REJECTED_KEY_PREFIX,
  createAnthropicHandler,
  encodeSse,
  fakeReplyText,
  messageStreamEvents,
  modelList,
  type FakeRequestRecord,
} from './fake-anthropic.mjs';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close();
    await once(server, 'close');
  }
});

async function serve(requests: FakeRequestRecord[]): Promise<string> {
  const handle = createAnthropicHandler(requests);
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe('the fake Anthropic API of the generated-project E2E', () => {
  it('answers the nonce of the last message it is asked about', () => {
    expect(fakeReplyText(null)).toBe('Fake Anthropic reply.');
    expect(
      fakeReplyText([
        { role: 'user', content: 'Reply with e2e-nonce-api1a' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'text', text: 'Now e2e-nonce-cli2b' }] },
      ]),
    ).toBe('Fake Anthropic reply to e2e-nonce-cli2b: the generated project answered.');
  });

  it('lists claude-sonnet-4-5, the model the setup wizard requires, in the adapter’s shape', () => {
    const list = modelList();
    expect(FAKE_MODELS).toContain('claude-sonnet-4-5');
    expect(list.data.map((model) => model.id)).toEqual([...FAKE_MODELS]);
    for (const model of list.data) {
      expect(model).toEqual({
        type: 'model',
        id: model.id,
        display_name: model.id,
        created_at: expect.any(String) as unknown,
      });
    }
  });

  it('streams the reply in Anthropic’s event order, split across two deltas', () => {
    const text = 'Fake Anthropic reply to e2e-nonce-x: the generated project answered.';
    const events = messageStreamEvents('msg_1', 'claude-sonnet-4-5', text);
    expect(events.map((event) => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'ping',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const deltas = events
      .filter((event) => event.type === 'content_block_delta')
      .map((event) => (event['delta'] as { text: string }).text);
    expect(deltas.every((delta) => delta.length > 0)).toBe(true);
    expect(deltas.join('')).toBe(text);
    expect(encodeSse([{ type: 'ping' }])).toBe('event: ping\ndata: {"type":"ping"}\n\n');
  });

  it('serves models, streaming and plain messages and token counts, and records each request', async () => {
    const requests: FakeRequestRecord[] = [];
    const base = await serve(requests);
    const headers = { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' };
    const messages = [{ role: 'user', content: 'say e2e-nonce-abc' }];

    const models = await fetch(`${base}/v1/models`, { headers });
    expect(((await models.json()) as { data: unknown[] }).data).toHaveLength(FAKE_MODELS.length);

    const streamed = await fetch(`${base}/v1/messages?beta=true`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-sonnet-4-5', stream: true, messages }),
    });
    expect(streamed.headers.get('content-type')).toBe('text/event-stream');
    expect(await streamed.text()).toContain('event: message_stop');

    const plain = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages }),
    });
    const message = (await plain.json()) as { content: { text: string }[]; model: string };
    expect(message.model).toBe('claude-haiku-4-5');
    expect(message.content[0]?.text).toBe(fakeReplyText(messages));

    // The messages' nonce wins over the system prompt's; with none, the system prompt's answers.
    const ask = async (body: Record<string, unknown>) => {
      const response = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'claude-sonnet-4-5', ...body }),
      });
      return ((await response.json()) as { content: { text: string }[] }).content[0]?.text;
    };
    const system = [{ type: 'text', text: 'Name e2e-nonce-sys1 in every answer.' }];
    expect(await ask({ system, messages })).toBe(fakeReplyText(messages));
    expect(await ask({ system, messages: [{ role: 'user', content: 'Hello.' }] })).toBe(
      'Fake Anthropic reply to e2e-nonce-sys1: the generated project answered.',
    );
    requests.splice(-2);

    const counted = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages }),
    });
    expect(await counted.json()).toEqual({ input_tokens: 12 });

    expect((await fetch(`${base}/v1/unknown`)).status).toBe(404);
    expect(
      requests.map(({ method, path, stream, apiKey }) => ({ method, path, stream, apiKey })),
    ).toEqual([
      { method: 'GET', path: '/v1/models', stream: false, apiKey: 'sk-ant-test' },
      { method: 'POST', path: '/v1/messages', stream: true, apiKey: 'sk-ant-test' },
      { method: 'POST', path: '/v1/messages', stream: false, apiKey: 'sk-ant-test' },
      { method: 'POST', path: '/v1/messages/count_tokens', stream: false, apiKey: 'sk-ant-test' },
      { method: 'GET', path: '/v1/unknown', stream: false, apiKey: null },
    ]);
  });

  it('refuses a key with the rejected prefix with 401, as Anthropic refuses a wrong key', async () => {
    const requests: FakeRequestRecord[] = [];
    const base = await serve(requests);
    const rejected = `${REJECTED_KEY_PREFIX}abc`;
    const refused = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': rejected } });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: { type: 'authentication_error' } });
    const accepted = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': 'sk-ant-ok' } });
    expect(accepted.status).toBe(200);
    expect(requests.map((request) => request.apiKey)).toEqual([rejected, 'sk-ant-ok']);
  });

  it('refuses a body that is not JSON', async () => {
    const base = await serve([]);
    const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{' });
    expect(response.status).toBe(400);
  });
});
