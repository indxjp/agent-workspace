import { afterEach, describe, expect, it } from 'vitest';

import { createModelDiscovery, discoveryCacheFingerprint } from './discovery';
import {
  closeFixtureServers,
  connection,
  fixtureServer,
  modelsResponse,
} from './discovery.test-support';
import type { ResolvedModelConnection } from './store';

afterEach(closeFixtureServers);

describe('createModelDiscovery', () => {
  it('discovers openai-compatible models through the gateway registry adapter', async () => {
    const server = await fixtureServer((_req, res) => modelsResponse(res, ['llama-3-70b']));
    const discover = createModelDiscovery();
    const result = await discover(connection('openai-compatible', { baseUrl: server.baseUrl }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      connectionId: 'conn-fixture',
      providerModelId: 'llama-3-70b',
      displayName: 'llama-3-70b',
    });
    expect(result.models[0]?.capabilities.streaming).toBe(true);
    expect(result.stale).toBe(false);
  });

  it('treats an anthropic-compatible connection as the anthropic adapter (no dedicated registry row)', async () => {
    const server = await fixtureServer((req, res) => {
      expect(req.url).toBe('/v1/models?limit=1000');
      modelsResponse(res, ['claude-house-blend']);
    });
    const discover = createModelDiscovery();
    const result = await discover(connection('anthropic-compatible', { baseUrl: server.baseUrl }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.models.map((model) => model.providerModelId)).toEqual(['claude-house-blend']);
    // Prompt caching was verified live against the Anthropic API only, not a compatible server.
    expect(result.models[0]?.capabilities.promptCaching).toBe(false);
    expect(result.models[0]?.capabilities.streaming).toBe(true);
  });

  it('declares prompt caching for an Anthropic API connection, as the adapter does', async () => {
    const server = await fixtureServer((_req, res) => modelsResponse(res, ['claude-haiku-5-5']));
    const discover = createModelDiscovery();
    const result = await discover(connection('anthropic', { baseUrl: server.baseUrl }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.models[0]?.capabilities.promptCaching).toBe(true);
  });

  it('lists the scripted models the composition root passes, beside the upstream ones', async () => {
    const server = await fixtureServer((_req, res) => modelsResponse(res, ['claude-house-blend']));
    const discover = createModelDiscovery({
      scripted: {
        isScripted: (model) => model.startsWith('scripted:'),
        listModels: () =>
          Promise.resolve([
            {
              id: 'scripted:fixture',
              type: 'model' as const,
              display_name: 'Scripted: fixture',
              created_at: '2026-01-01T00:00:00Z',
            },
          ]),
        createMessage: () => Promise.resolve(Response.json({})),
        countTokens: () => Promise.resolve({ input_tokens: 1 }),
      },
    });
    const result = await discover(connection('anthropic-compatible', { baseUrl: server.baseUrl }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.models.map((model) => model.providerModelId)).toEqual([
      'claude-house-blend',
      'scripted:fixture',
    ]);
  });

  it("treats Azure's configured deployment as the connection's single model, with no network call", async () => {
    const server = await fixtureServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const discover = createModelDiscovery();
    const result = await discover(
      connection('azure-openai', {
        baseUrl: server.baseUrl,
        apiVersion: '2024-10-01',
        deployment: 'my-gpt-deployment',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      connectionId: 'conn-fixture',
      providerModelId: 'my-gpt-deployment',
      displayName: 'my-gpt-deployment',
    });
    // The 500-returning fixture above is never actually reached: Azure's own `listModels()`
    // never calls fetch at all when a deployment is configured.
    expect(server.requests).toBe(0);
  });
});

describe('createModelDiscovery — vertex', () => {
  it('lists the static Claude models for a keyless connection without a credential or a fetch', async () => {
    const resolved: ResolvedModelConnection = {
      ...connection('vertex', { projectId: 'my-project-123' }),
      credential: '',
    };
    const calls: unknown[] = [];
    const discover = createModelDiscovery({
      fetch: (...args) => {
        calls.push(args);
        return Promise.reject(new Error('vertex discovery must not fetch'));
      },
    });
    const result = await discover(resolved);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models.map((model) => model.providerModelId)).toContain('claude-sonnet-5-5');
    }
    expect(calls).toHaveLength(0);
    expect(discoveryCacheFingerprint(resolved, new Uint8Array(32))).toMatch(/^[0-9a-f]{64}$/u);
  });
});
