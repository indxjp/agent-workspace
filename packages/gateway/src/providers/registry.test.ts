import { describe, expect, it, vi } from 'vitest';

import { MODEL_PROVIDERS } from '@indx-workspace/contracts/runs';

import type { RequestContext, WireProtocolForwarder } from '../types.js';
import { createProviderRegistry, PROVIDER_IDS, registryProviderId } from './registry.js';
import type { ScriptedModels } from './scripted.js';

const context = (
  providerId: string,
  settings: Readonly<Record<string, unknown>>,
): RequestContext => ({
  providerId,
  credential: 'secret-from-run-resolution',
  requestId: 'registry-test',
  settings,
});

const providerOf = (id: string, options: Parameters<typeof createProviderRegistry>[0]) => {
  const provider = createProviderRegistry(options).find((row) => row.id === id);
  if (provider === undefined) throw new Error(`no registry row ${id}`);
  return provider;
};

describe('registryProviderId', () => {
  it('maps every model connection provider onto a registry row', () => {
    for (const provider of MODEL_PROVIDERS) {
      expect(PROVIDER_IDS).toContain(registryProviderId(provider));
    }
  });

  it('serves anthropic-compatible through the anthropic row and leaves the rest alone', () => {
    expect(registryProviderId('anthropic-compatible')).toBe('anthropic');
    expect(registryProviderId('openai-compatible')).toBe('openai-compatible');
  });
});

describe('Wave 4 provider registry', () => {
  it('contains exactly the four declared provider rows', () => {
    const ids = createProviderRegistry().map((provider) => provider.id);
    expect(ids).toEqual(PROVIDER_IDS);
    expect(new Set(ids).size).toBe(4);
  });

  it('constructs Azure from the selected connection instead of process configuration', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: { message: 'fixture', code: 'fixture' } }, { status: 400 }),
      );
    const azure = createProviderRegistry({ fetch: request }).find(
      (provider) => provider.id === 'azure-openai',
    );
    expect(azure).toBeDefined();
    await azure!.createMessage(
      { model: 'ignored', max_tokens: 1, messages: [] },
      context('azure-openai', {
        baseUrl: 'http://localhost:9500',
        deployment: 'selected-deployment',
        apiVersion: '2025-04-01-preview',
      }),
    );
    expect(request.mock.calls[0]?.[0]).toBe(
      'http://localhost:9500/openai/responses?api-version=2025-04-01-preview',
    );
    const body = request.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe('string');
    if (typeof body === 'string') {
      expect(JSON.parse(body)).toMatchObject({ model: 'selected-deployment' });
    }
  });

  it('refuses connection types whose required endpoint settings are absent', () => {
    const registry = createProviderRegistry();
    const compatible = registry.find((provider) => provider.id === 'openai-compatible');
    expect(() =>
      compatible!.createMessage({ model: 'model' }, context('openai-compatible', {})),
    ).toThrow(/require config\.baseUrl/);
  });

  it('routes the mandatory token-count operation through the selected adapter', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ input_tokens: 42 }));
    const openai = providerOf('openai', { fetch: request });
    const result = await openai.countTokens!(
      { model: 'gpt-fixture', messages: [] },
      context('openai', { baseUrl: 'http://localhost:9600/v1' }),
    );
    expect(result).toEqual({ input_tokens: 42 });
    expect(request.mock.calls[0]?.[0]).toBe('http://localhost:9600/v1/responses/input_tokens');
  });

  it('discovers models with the credential and endpoint selected by the run', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [{ id: 'gpt-fixture', object: 'model', created: 1_700_000_000 }],
      }),
    );
    const openai = providerOf('openai', { fetch: request });
    const models = await openai.listModels(
      context('openai', { baseUrl: 'http://localhost:9600/v1' }),
    );

    expect(models).toEqual([
      expect.objectContaining({ id: 'gpt-fixture', display_name: 'gpt-fixture', type: 'model' }),
    ]);
    expect(request).toHaveBeenCalledWith(
      'http://localhost:9600/v1/models',
      expect.objectContaining({
        headers: { authorization: 'Bearer secret-from-run-resolution' },
      }),
    );
  });
});

describe('scripted models in the registry', () => {
  const scriptedModel = {
    id: 'scripted:fixture',
    type: 'model' as const,
    display_name: 'Scripted: fixture',
    created_at: '2026-01-01T00:00:00Z',
  };
  const scripted: ScriptedModels = {
    isScripted: (model) => model.startsWith('scripted:'),
    listModels: () => Promise.resolve([scriptedModel]),
    createMessage: () => Promise.resolve(Response.json({ scripted: true })),
    countTokens: () => Promise.resolve({ input_tokens: 1 }),
  };
  const message = (model: string) => ({ model, max_tokens: 1, messages: [] });
  const upstreamOk = () =>
    vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(Response.json({ data: [] })));

  it('serves a scripted id on the anthropic row without calling upstream', async () => {
    const request = upstreamOk();
    const anthropic = providerOf('anthropic', { fetch: request, scripted });
    const response = await anthropic.createMessage(
      message('scripted:fixture'),
      context('anthropic', {}),
    );
    expect(await response.json()).toEqual({ scripted: true });
    await expect(
      anthropic.countTokens!(message('scripted:fixture'), context('anthropic', {})),
    ).resolves.toEqual({ input_tokens: 1 });
    expect(request).not.toHaveBeenCalled();
  });

  it('still sends every other model id upstream', async () => {
    const request = upstreamOk();
    await providerOf('anthropic', { fetch: request, scripted }).createMessage(
      message('claude-fixture'),
      context('anthropic', { baseUrl: 'http://localhost:9500' }),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('sends scripted ids upstream as before when the option is off', async () => {
    const request = upstreamOk();
    await providerOf('anthropic', { fetch: request, scripted: null }).createMessage(
      message('scripted:fixture'),
      context('anthropic', { baseUrl: 'http://localhost:9500' }),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('adds scripted ids to discovery and keeps them when upstream discovery fails', async () => {
    const anthropicContext = context('anthropic', { baseUrl: 'http://localhost:9500' });
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
      anthropicContext,
    );
    expect(merged.map((model) => model.id)).toEqual(['claude-fixture', 'scripted:fixture']);

    const rejected = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response('no', { status: 401 })));
    const fallback = await providerOf('anthropic', { fetch: rejected, scripted }).listModels(
      anthropicContext,
    );
    expect(fallback.map((model) => model.id)).toEqual(['scripted:fixture']);
  });

  it('refuses a scripted id on the OpenAI dialects without calling upstream', async () => {
    const request = upstreamOk();
    for (const id of ['openai', 'azure-openai', 'openai-compatible'] as const) {
      const row = providerOf(id, { fetch: request, scripted }) as unknown as WireProtocolForwarder;
      const response = await row.forward(
        message('scripted:fixture'),
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
    for (const id of ['openai', 'azure-openai', 'openai-compatible'] as const) {
      const row = providerOf(id, { fetch: request, scripted });
      const response = await row.createMessage(message('scripted:fixture'), context(id, {}));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: 'scripted_model_protocol_unsupported' },
      });
      await expect(row.countTokens!(message('scripted:fixture'), context(id, {}))).resolves.toEqual(
        { input_tokens: 1 },
      );
    }
    expect(request).not.toHaveBeenCalled();
  });
});
