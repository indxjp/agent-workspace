import { describe, expect, it, vi } from 'vitest';

import type { WireProtocolForwarder } from '../types.js';
import {
  context,
  LOCAL_ENDPOINT,
  message,
  modelIds,
  providerOf,
  SCRIPTED_MODEL_ID,
} from './registry.test-support.js';
import type { ScriptedModels } from './scripted.js';

const OPENAI_DIALECT_ROWS = ['openai', 'azure-openai', 'openai-compatible'] as const;

const scripted: ScriptedModels = {
  isScripted: (model) => model.startsWith('scripted:'),
  listModels: () =>
    Promise.resolve([
      {
        id: SCRIPTED_MODEL_ID,
        type: 'model' as const,
        display_name: 'Scripted: fixture',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]),
  createMessage: () => Promise.resolve(Response.json({ scripted: true })),
  countTokens: () => Promise.resolve({ input_tokens: 1 }),
};

const upstreamOk = () =>
  vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(Response.json({ data: [] })));

const anthropicAtLocalEndpoint = () => context('anthropic', { baseUrl: LOCAL_ENDPOINT });

describe('scripted models in the registry', () => {
  it('serves a scripted id on the anthropic row without calling upstream', async () => {
    const request = upstreamOk();
    const anthropic = providerOf('anthropic', { fetch: request, scripted });
    const response = await anthropic.createMessage(
      message(SCRIPTED_MODEL_ID),
      context('anthropic', {}),
    );
    expect(await response.json()).toEqual({ scripted: true });
    await expect(
      anthropic.countTokens?.(message(SCRIPTED_MODEL_ID), context('anthropic', {})),
    ).resolves.toEqual({ input_tokens: 1 });
    expect(request).not.toHaveBeenCalled();
  });

  it('still sends every other model id upstream', async () => {
    const request = upstreamOk();
    await providerOf('anthropic', { fetch: request, scripted }).createMessage(
      message('claude-fixture'),
      anthropicAtLocalEndpoint(),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reads no environment: the option omitted is off even with AW_SCRIPTED_MODELS_DIR set', async () => {
    vi.stubEnv('AW_SCRIPTED_MODELS_DIR', '/tmp/scripted-models-never-read');
    const request = upstreamOk();
    await providerOf('anthropic', { fetch: request })
      .createMessage(message(SCRIPTED_MODEL_ID), anthropicAtLocalEndpoint())
      .finally(() => vi.unstubAllEnvs());
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('sends scripted ids upstream as before when the option is off', async () => {
    const request = upstreamOk();
    await providerOf('anthropic', { fetch: request, scripted: null }).createMessage(
      message(SCRIPTED_MODEL_ID),
      anthropicAtLocalEndpoint(),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('adds scripted ids to discovery and keeps them when upstream discovery fails', async () => {
    const listed = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            id: 'claude-fixture',
            type: 'model',
            display_name: 'Claude',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    const merged = await providerOf('anthropic', { fetch: listed, scripted }).listModels(
      anthropicAtLocalEndpoint(),
    );
    expect(modelIds(merged)).toEqual(['claude-fixture', SCRIPTED_MODEL_ID]);

    const rejected = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response('no', { status: 401 })));
    const fallback = await providerOf('anthropic', { fetch: rejected, scripted }).listModels(
      anthropicAtLocalEndpoint(),
    );
    expect(modelIds(fallback)).toEqual([SCRIPTED_MODEL_ID]);
  });
});

describe('scripted models on the OpenAI dialects', () => {
  it('refuses a scripted id on the OpenAI dialects without calling upstream', async () => {
    const request = upstreamOk();
    for (const id of OPENAI_DIALECT_ROWS) {
      const row = providerOf(id, { fetch: request, scripted }) as unknown as WireProtocolForwarder;
      const response = await row.forward(
        message(SCRIPTED_MODEL_ID),
        'openai-responses',
        context(id, {}),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: 'scripted_model_protocol_unsupported' },
      });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a scripted id on anthropic-messages to an OpenAI connection without calling upstream', async () => {
    const request = upstreamOk();
    for (const id of OPENAI_DIALECT_ROWS) {
      const row = providerOf(id, { fetch: request, scripted });
      const response = await row.createMessage(message(SCRIPTED_MODEL_ID), context(id, {}));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: 'scripted_model_protocol_unsupported' },
      });
      await expect(row.countTokens?.(message(SCRIPTED_MODEL_ID), context(id, {}))).resolves.toEqual(
        { input_tokens: 1 },
      );
    }
    expect(request).not.toHaveBeenCalled();
  });
});
