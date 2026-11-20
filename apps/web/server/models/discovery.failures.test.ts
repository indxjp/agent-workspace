import { afterEach, describe, expect, it } from 'vitest';

import { createModelDiscovery } from './discovery';
import {
  closeFixtureServers,
  connection,
  fixtureServer,
  modelsResponse,
} from './discovery.test-support';
import type { ModelConnectionRecord } from '@agent-workspace/core/db';
import type { ResolvedModelConnection } from './store';

afterEach(closeFixtureServers);

describe('createModelDiscovery — failures', () => {
  it('fails closed, naming the reason, on a first-ever discovery failure with nothing cached', async () => {
    const server = await fixtureServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const discover = createModelDiscovery();
    const result = await discover(connection('openai-compatible', { baseUrl: server.baseUrl }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('fails closed, by name, for a provider string the registry has no adapter for', async () => {
    const discover = createModelDiscovery();
    const resolved = connection('openai', { baseUrl: 'https://example.invalid' });
    const corrupted: ResolvedModelConnection = {
      ...resolved,
      connection: {
        ...resolved.connection,
        // R-15 §4: a column typed `ModelProvider` at compile time can still hold, at runtime, a
        // value written by an older schema or by hand. This asserts the defensive branch that
        // guards against exactly that, the same way `runs.ts`'s `parseRunStatus` does for status.
        provider: 'made-up-provider' as ModelConnectionRecord['provider'],
      },
    };
    const result = await discover(corrupted);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('made-up-provider');
  });

  // PR #403 review: discovery sits on the run-start path, so a silent provider is bounded.
  it('abandons a provider that never answers as unreachable after the timeout', async () => {
    const hanging: import('node:http').ServerResponse[] = [];
    const server = await fixtureServer((_req, res) => {
      hanging.push(res);
    });
    const discover = createModelDiscovery({ timeoutMs: 50, log: () => undefined });
    const started = Date.now();
    const result = await discover(connection('openai-compatible', { baseUrl: server.baseUrl }));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({ ok: false, failure: { kind: 'unreachable' } });
    for (const res of hanging) res.destroy();
  });

  // Issue #393: the cache is keyed by the credential too, so a rotated key is discovered afresh.
  it("does not serve one key's cached catalogue to a rotated key", async () => {
    const server = await fixtureServer((req, res) => {
      if (req.headers.authorization === 'Bearer sk-rotated') {
        modelsResponse(res, ['after-rotation']);
        return;
      }
      modelsResponse(res, ['before-rotation']);
    });
    const discover = createModelDiscovery({ ttlMs: 60_000 });
    const target = connection('openai-compatible', { baseUrl: server.baseUrl });

    const first = await discover(target);
    const rotated = await discover({ ...target, credential: 'sk-rotated' });
    expect(first.ok && first.models.map((model) => model.providerModelId)).toEqual([
      'before-rotation',
    ]);
    expect(rotated.ok && rotated.models.map((model) => model.providerModelId)).toEqual([
      'after-rotation',
    ]);
    expect(server.requests).toBe(2);
  });

  it('names the HTTP status of a provider failure, without calling it a bad key', async () => {
    const server = await fixtureServer((_req, res) => {
      res.writeHead(429);
      res.end();
    });
    const logged: string[] = [];
    const discover = createModelDiscovery({ log: (message) => logged.push(message) });
    const result = await discover(connection('openai-compatible', { baseUrl: server.baseUrl }));
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: 'provider-error', status: 429 },
      reason: 'Model list unavailable (provider returned HTTP 429).',
    });
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).not.toMatch(/key/iu);
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain('sk-fixture-secret');
  });

  it('says the key was rejected on a 401, and never answers it from the cache', async () => {
    let reject = false;
    const server = await fixtureServer((_req, res) => {
      if (reject) {
        res.writeHead(401);
        res.end();
        return;
      }
      modelsResponse(res, ['m1']);
    });
    let now = 0;
    const discover = createModelDiscovery({ ttlMs: 1_000, now: () => now, log: () => undefined });
    const target = connection('openai-compatible', { baseUrl: server.baseUrl });
    expect((await discover(target)).ok).toBe(true);

    reject = true;
    now += 1_001;
    const result = await discover(target);
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: 'credential-rejected', status: 401 },
    });
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('rejected the API key (HTTP 401)');
  });
});
