import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { createRouter } from '../router.js';
import type { RequestContext } from '../types.js';
import { createAnthropicUsageAccumulator } from '../usage/anthropic.js';
import { createProviderRegistry } from './registry.js';
import { createScriptedModels, scriptedModelsFromEnv } from './scripted.js';

const context: RequestContext = {
  providerId: 'anthropic',
  credential: 'placeholder',
  requestId: 'scripted-test',
  settings: {},
};

const SCRIPT = {
  turns: [
    { text: 'Looking it up.', toolUses: [{ name: 'lookup', input: { id: 7 } }] },
    { text: 'The answer is 42.' },
  ],
};

const dir = mkdtempSync(join(tmpdir(), 'aw-scripted-'));
writeFileSync(join(dir, 'two-turns.json'), JSON.stringify(SCRIPT));
writeFileSync(join(dir, 'broken.json'), JSON.stringify({ turns: [] }));
writeFileSync(join(dir, 'Not-A-Name.json'), JSON.stringify(SCRIPT));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function request(extra: Record<string, unknown>, model = 'scripted:two-turns') {
  return { model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra };
}

function sseEvents(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      return JSON.parse(String(data).slice('data: '.length)) as Record<string, unknown>;
    });
}

function usageOf(events: readonly Record<string, unknown>[]) {
  const accumulator = createAnthropicUsageAccumulator();
  for (const event of events) accumulator.observe(event);
  return accumulator.snapshot();
}

async function errorOf(response: Response) {
  const body = (await response.json()) as { error: { type: string; message: string } };
  return { status: response.status, ...body.error };
}

describe('scripted model replies', () => {
  const scripted = createScriptedModels({ dir });

  it('answers a non-streaming tool turn with deterministic ids and settleable usage', async () => {
    const response = await scripted.createMessage(request({}), context);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'msg_scripted_two-turns_0',
      type: 'message',
      model: 'scripted:two-turns',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Looking it up.' },
        { type: 'tool_use', id: 'toolu_scripted_0_0', name: 'lookup', input: { id: 7 } },
      ],
    });
    const usage = usageOf([body]);
    expect(usage).toMatchObject({
      responseId: 'msg_scripted_two-turns_0',
      model: 'scripted:two-turns',
      metered: true,
      completed: true,
      toolCalls: 1,
    });
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  it('streams the Anthropic event order and advances after a tool result', async () => {
    const first = await scripted.createMessage(request({ stream: true }), context);
    expect(first.headers.get('content-type')).toBe('text/event-stream');
    const events = sseEvents(await first.text());
    expect(events.map((event) => event['type'])).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(events[5]).toMatchObject({
      delta: { type: 'input_json_delta', partial_json: '{"id":7}' },
    });
    expect(events[7]).toMatchObject({ delta: { stop_reason: 'tool_use' } });
    expect(usageOf(events)).toMatchObject({
      responseId: 'msg_scripted_two-turns_0',
      model: 'scripted:two-turns',
      metered: true,
      completed: true,
      toolCalls: 1,
    });

    const second = await scripted.createMessage(
      request({
        stream: true,
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'x', name: 'lookup', input: {} }],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
        ],
      }),
      context,
    );
    const next = sseEvents(await second.text());
    expect(next[2]).toMatchObject({ delta: { type: 'text_delta', text: 'The answer is 42.' } });
    expect(next.at(-2)).toMatchObject({ delta: { stop_reason: 'end_turn' } });
  });

  it('refuses an exhausted script, naming the script and the turn count', async () => {
    const messages = [
      { role: 'assistant', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const error = await errorOf(await scripted.createMessage(request({ messages }), context));
    expect(error).toMatchObject({ status: 400, type: 'invalid_request_error' });
    expect(error.message).toContain('two-turns');
    expect(error.message).toContain('2 turn(s)');
  });

  it.each(['scripted:missing', 'scripted:broken', 'scripted:../two-turns', 'scripted:a/b'])(
    'refuses %s without reading outside the directory or leaking the path',
    async (model) => {
      const error = await errorOf(await scripted.createMessage(request({}, model), context));
      expect(error).toMatchObject({ status: 400, type: 'invalid_request_error' });
      expect(error.message).not.toContain(dir);
    },
  );

  it('lists one id per well-named script file', async () => {
    const models = await scripted.listModels();
    expect(models.map((model) => model.id)).toEqual(['scripted:broken', 'scripted:two-turns']);
  });

  it('lists nothing when the directory does not exist', async () => {
    const none = createScriptedModels({ dir: join(dir, 'absent') });
    await expect(none.listModels()).resolves.toEqual([]);
  });
});

describe('scriptedModelsFromEnv', () => {
  it('is off when the variable is unset or blank, in any posture', () => {
    expect(scriptedModelsFromEnv({ NODE_ENV: 'production' })).toBeUndefined();
    expect(scriptedModelsFromEnv({ AW_SCRIPTED_MODELS_DIR: '  ' })).toBeUndefined();
  });

  it('refuses to start outside the local posture', () => {
    expect(() =>
      scriptedModelsFromEnv({ AW_SCRIPTED_MODELS_DIR: dir, AW_DEPLOYMENT_POSTURE: 'production' }),
    ).toThrow(/local posture/u);
    expect(() =>
      scriptedModelsFromEnv({ AW_SCRIPTED_MODELS_DIR: dir, NODE_ENV: 'production' }),
    ).toThrow(/local posture/u);
  });

  it('refuses a relative directory', () => {
    expect(() => scriptedModelsFromEnv({ AW_SCRIPTED_MODELS_DIR: 'scripts' })).toThrow(/absolute/u);
  });

  it('is on for an absolute directory in the local posture', () => {
    const enabled = scriptedModelsFromEnv({
      AW_SCRIPTED_MODELS_DIR: dir,
      AW_DEPLOYMENT_POSTURE: 'local',
      HOST: '127.0.0.1',
    });
    expect(enabled?.isScripted('scripted:two-turns')).toBe(true);
    expect(enabled?.isScripted('claude-sonnet-5')).toBe(false);
  });
});

describe('scripted models through the gateway router', () => {
  const upstream = vi.fn<typeof fetch>(() => Promise.reject(new Error('no network in this test')));
  const router = createRouter(
    createProviderRegistry({ fetch: upstream, scripted: createScriptedModels({ dir }) }),
  );

  function post(path: string, body: unknown) {
    return router.fetch(
      new Request(`http://gateway.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      context,
    );
  }

  it('replays a two-turn tool script over /v1/messages without any upstream call', async () => {
    const first = await post('/v1/messages', request({ stream: true }));
    expect(first.status).toBe(200);
    expect(usageOf(sseEvents(await first.text())).toolCalls).toBe(1);

    const second = await post(
      '/v1/messages',
      request({
        stream: true,
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'x', name: 'lookup', input: {} }],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
        ],
      }),
    );
    const usage = usageOf(sseEvents(await second.text()));
    expect(usage).toMatchObject({
      completed: true,
      toolCalls: 0,
      responseId: 'msg_scripted_two-turns_1',
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('counts tokens without an upstream call', async () => {
    const response = await post('/v1/messages/count_tokens', request({}));
    expect(response.status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses the OpenAI dialects with a typed error on an OpenAI connection', async () => {
    const openai: RequestContext = { ...context, providerId: 'openai' };
    for (const path of ['/v1/responses', '/v1/chat/completions']) {
      const response = await router.fetch(
        new Request(`http://gateway.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request({})),
        }),
        openai,
      );
      expect(await errorOf(response)).toMatchObject({
        status: 400,
        type: 'scripted_model_protocol_unsupported',
      });
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});
