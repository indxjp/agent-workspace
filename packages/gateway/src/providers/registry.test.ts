import { describe, expect, it, vi } from 'vitest';

import { MODEL_PROVIDERS } from '@indx-workspace/contracts/runs';

import { createRouter } from '../router.js';
import type { ModelProvider } from '../types.js';
import {
  createProviderRegistry,
  ModelConnectionIncompleteError,
  PROVIDER_IDS,
  registryProviderId,
} from './registry.js';
import {
  context,
  LOCAL_ENDPOINT,
  LOCAL_V1_ENDPOINT,
  RESOLVED_CREDENTIAL,
  providerOf,
} from './registry.test-support.js';

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
  it('contains exactly the five declared provider rows, vertex last', () => {
    const ids = createProviderRegistry().map((provider) => provider.id);
    expect(ids).toEqual(PROVIDER_IDS);
    expect(new Set(ids).size).toBe(5);
    expect(ids.at(-1)).toBe('vertex');
    expect(registryProviderId('vertex')).toBe('vertex');
  });

  it('constructs Azure from the selected connection instead of process configuration', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: { message: 'fixture', code: 'fixture' } }, { status: 400 }),
      );
    await providerOf('azure-openai', { fetch: request }).createMessage(
      { model: 'ignored', max_tokens: 1, messages: [] },
      context('azure-openai', {
        baseUrl: LOCAL_ENDPOINT,
        deployment: 'selected-deployment',
        apiVersion: '2025-04-01-preview',
      }),
    );
    expect(request.mock.calls[0]?.[0]).toBe(
      `${LOCAL_ENDPOINT}/openai/responses?api-version=2025-04-01-preview`,
    );
    const body = request.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe('string');
    if (typeof body === 'string') {
      expect(JSON.parse(body)).toMatchObject({ model: 'selected-deployment' });
    }
  });

  it('refuses connection types whose required endpoint settings are absent', () => {
    const compatible = providerOf('openai-compatible', undefined);
    expect(() =>
      compatible.createMessage({ model: 'model' }, context('openai-compatible', {})),
    ).toThrow(ModelConnectionIncompleteError);
  });
});

describe('registry adapters selected by the run', () => {
  it('routes the mandatory token-count operation through the selected adapter', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ input_tokens: 42 }));
    const openai = providerOf('openai', { fetch: request });
    const result = await openai.countTokens?.(
      { model: 'gpt-fixture', messages: [] },
      context('openai', { baseUrl: LOCAL_V1_ENDPOINT }),
    );
    expect(result).toEqual({ input_tokens: 42 });
    expect(request.mock.calls[0]?.[0]).toBe(`${LOCAL_V1_ENDPOINT}/responses/input_tokens`);
  });

  it('discovers models with the credential and endpoint selected by the run', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [{ id: 'gpt-fixture', object: 'model', created: 1_700_000_000 }],
      }),
    );
    const openai = providerOf('openai', { fetch: request });
    const models = await openai.listModels(context('openai', { baseUrl: LOCAL_V1_ENDPOINT }));

    expect(models).toEqual([
      expect.objectContaining({ id: 'gpt-fixture', display_name: 'gpt-fixture', type: 'model' }),
    ]);
    expect(request).toHaveBeenCalledWith(
      `${LOCAL_V1_ENDPOINT}/models`,
      expect.objectContaining({
        headers: { authorization: `Bearer ${RESOLVED_CREDENTIAL}` },
      }),
    );
  });
});

describe('an incomplete stored model connection through the router', () => {
  // An Azure row saved before `apiVersion` became required.
  const legacyAzure = context('azure-openai', {
    baseUrl: LOCAL_ENDPOINT,
    deployment: 'selected-deployment',
  });
  const jsonRequest = (path: string) =>
    new Request(`http://gateway.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', max_tokens: 1, messages: [] }),
    });

  it('answers a typed 409 naming the missing field and never calls upstream', async () => {
    const upstream = vi.fn<typeof fetch>();
    const router = createRouter(createProviderRegistry({ fetch: upstream, scripted: null }));
    const requests = [
      jsonRequest('/v1/messages'),
      jsonRequest('/v1/messages/count_tokens'),
      jsonRequest('/v1/responses'),
      jsonRequest('/v1/chat/completions'),
      new Request('http://gateway.test/v1/models'),
    ];
    for (const request of requests) {
      const response = await router.fetch(request, legacyAzure);
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: { type: string; message: string } };
      expect(body).toMatchObject({
        type: 'error',
        error: { type: 'model_connection_incomplete' },
        request_id: 'registry-test',
      });
      expect(body.error.message).toContain('config.apiVersion');
      expect(body.error.message).not.toContain('localhost');
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('answers a typed 501 when the selected provider cannot count tokens', async () => {
    const router = createRouter(createProviderRegistry({ scripted: null }));
    const response = await router.fetch(
      jsonRequest('/v1/messages/count_tokens'),
      context('vertex', { projectId: 'p', location: 'global' }),
    );
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      error: { type: 'provider_operation_not_supported' },
    });
  });

  it('does not turn any other adapter failure into a 409', async () => {
    const broken: ModelProvider = {
      ...providerOf('anthropic', { scripted: null }),
      createMessage: () => Promise.reject(new Error('upstream exploded')),
    };
    await expect(
      createRouter([broken]).fetch(jsonRequest('/v1/messages'), context('anthropic', {})),
    ).rejects.toThrow('upstream exploded');
  });
});
