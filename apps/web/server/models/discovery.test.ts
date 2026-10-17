import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { EgressRefusedError } from '@agent-workspace/core';
import type { ModelConnectionRecord } from '@agent-workspace/core/db';
import { afterEach, describe, expect, it } from 'vitest';

import { createModelDiscovery, discoveryCacheFingerprint } from './discovery';
import type { ResolvedModelConnection } from './store';

const openServers: Server[] = [];

afterEach(() => {
  while (openServers.length > 0) openServers.pop()?.close();
});

interface Fixture {
  baseUrl: string;
  requests: number;
}

async function fixtureServer(
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
): Promise<Fixture> {
  const fixture: Fixture = { baseUrl: '', requests: 0 };
  const server = createServer((req, res) => {
    fixture.requests += 1;
    handler(req, res);
  });
  openServers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address() as AddressInfo;
  fixture.baseUrl = `http://127.0.0.1:${port}`;
  return fixture;
}

function connection(
  provider: ModelConnectionRecord['provider'],
  config: ModelConnectionRecord['config'],
): ResolvedModelConnection {
  return {
    connection: {
      id: 'conn-fixture',
      workspaceId: 'ws-fixture',
      name: 'Fixture connection',
      provider,
      config,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    credential: 'sk-fixture-secret',
  };
}

function modelsResponse(res: import('node:http').ServerResponse, ids: readonly string[]): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      data: ids.map((id) => ({
        id,
        type: 'model',
        display_name: id,
        created_at: new Date(0).toISOString(),
      })),
    }),
  );
}

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

  it('serves a fresh discovery from cache within the TTL, without a second network call', async () => {
    const server = await fixtureServer((_req, res) => modelsResponse(res, ['m1']));
    let now = 0;
    const discover = createModelDiscovery({ ttlMs: 1_000, now: () => now });
    const target = connection('openai-compatible', { baseUrl: server.baseUrl });

    await discover(target);
    now += 500; // still inside the TTL
    const second = await discover(target);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.stale).toBe(false);
    expect(server.requests).toBe(1);
  });

  // Issue #415: setup's probe-only lookups leave nothing behind.
  it('with the cache off, neither serves nor keeps a list, and a failure is not answered stale', async () => {
    let fail = false;
    const server = await fixtureServer((_req, res) => {
      if (fail) {
        res.writeHead(503);
        res.end();
        return;
      }
      modelsResponse(res, ['m1']);
    });
    const discover = createModelDiscovery({ cache: false, log: () => undefined });
    const target = connection('openai-compatible', { baseUrl: server.baseUrl });

    expect((await discover(target)).ok).toBe(true);
    expect((await discover(target)).ok).toBe(true);
    expect(server.requests).toBe(2);
    fail = true;
    expect((await discover(target)).ok).toBe(false);
  });

  it('re-fetches once the TTL has elapsed', async () => {
    const server = await fixtureServer((_req, res) => modelsResponse(res, ['m1']));
    let now = 0;
    const discover = createModelDiscovery({ ttlMs: 1_000, now: () => now });
    const target = connection('openai-compatible', { baseUrl: server.baseUrl });

    await discover(target);
    now += 1_001; // past the TTL
    await discover(target);
    expect(server.requests).toBe(2);
  });

  it('on a discovery failure, returns the previously known list marked stale', async () => {
    let fail = false;
    const server = await fixtureServer((_req, res) => {
      if (fail) {
        res.writeHead(503);
        res.end();
        return;
      }
      modelsResponse(res, ['m1']);
    });
    let now = 0;
    const discover = createModelDiscovery({ ttlMs: 1_000, now: () => now });
    const target = connection('openai-compatible', { baseUrl: server.baseUrl });

    const first = await discover(target);
    expect(first.ok).toBe(true);

    fail = true;
    now += 1_001; // force a re-fetch, which now fails
    const second = await discover(target);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.stale).toBe(true);
    expect(second.models.map((model) => model.providerModelId)).toEqual(['m1']);
  });

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

  // PR #403 review: a list stored for one fingerprint evicts the connection's other fingerprints.
  it("evicts a rotated-away key's cached list when the new key's list is stored", async () => {
    const server = await fixtureServer((_req, res) => modelsResponse(res, ['m']));
    const discover = createModelDiscovery({ ttlMs: 60_000 });
    const target = connection('openai-compatible', { baseUrl: server.baseUrl });

    await discover(target);
    await discover({ ...target, credential: 'sk-rotated' });
    // Back to the first key: its list was evicted, so it is discovered again.
    await discover(target);
    expect(server.requests).toBe(3);
    // The latest key's list is still cached.
    await discover(target);
    expect(server.requests).toBe(3);
  });

  it('fingerprints the credential with a keyed HMAC, not a bare hash', () => {
    const target = connection('openai-compatible', { baseUrl: 'http://127.0.0.1:1' });
    const bare = createHash('sha256')
      .update(target.credential)
      .update('\u0000')
      .update(JSON.stringify(target.connection.config))
      .digest('hex');
    const one = discoveryCacheFingerprint(target, new Uint8Array(32).fill(1));
    const two = discoveryCacheFingerprint(target, new Uint8Array(32).fill(2));
    expect(one).not.toBe(bare);
    expect(one).not.toBe(two);
    expect(discoveryCacheFingerprint(target)).not.toBe(bare);
    expect(discoveryCacheFingerprint(target)).toBe(discoveryCacheFingerprint(target));
    expect(one).not.toContain(target.credential);
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

  describe('a provider that cannot be connected to (issue #661)', () => {
    const target = connection('openai-compatible', { baseUrl: 'http://127.0.0.1:9' });
    const fetchFailed = (code: string): Error =>
      new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

    it.each(['ECONNREFUSED', 'ENOTFOUND'])(
      'reports %s as connection-failed, never naming the key',
      async (code) => {
        const logged: string[] = [];
        const discover = createModelDiscovery({
          fetch: () => Promise.reject(fetchFailed(code)),
          log: (message, cause) => logged.push(`${message} ${String(cause)}`),
        });
        const result = await discover(target);
        expect(result).toMatchObject({
          ok: false,
          failure: { kind: 'connection-failed' },
          reason: expect.stringContaining('could not be connected to') as unknown,
        });
        expect(JSON.stringify(result)).not.toContain('sk-fixture-secret');
        expect(logged.join('\n')).not.toContain('sk-fixture-secret');
      },
    );

    it('reports an egress refusal for a name that did not resolve as connection-failed, a refusal by rule as unreachable', async () => {
      const refusal = (dnsFailed: boolean) =>
        createModelDiscovery({
          fetch: () => Promise.reject(new EgressRefusedError('Egress policy refused', dnsFailed)),
          log: () => undefined,
        })(target);
      expect(await refusal(true)).toMatchObject({ failure: { kind: 'connection-failed' } });
      expect(await refusal(false)).toMatchObject({ failure: { kind: 'unreachable' } });
    });

    it('treats a temporary resolver failure (EAI_AGAIN) as transient: unreachable, cached list served stale', async () => {
      let failWith: Error | null = null;
      let now = 0;
      const logged: string[] = [];
      const discover = createModelDiscovery({
        ttlMs: 1_000,
        now: () => now,
        log: (message, cause) => logged.push(`${message} ${String(cause)}`),
        fetch: () =>
          failWith === null
            ? Promise.resolve(
                Response.json({ object: 'list', data: [{ id: 'm1', object: 'model' }] }),
              )
            : Promise.reject(failWith),
      });
      expect(await discover(target)).toMatchObject({ ok: true });

      failWith = fetchFailed('EAI_AGAIN');
      now += 1_001;
      expect(await discover(target)).toMatchObject({ ok: true, stale: true });
      expect(logged.join('\n')).not.toContain('sk-fixture-secret');

      const uncached = createModelDiscovery({
        fetch: () => Promise.reject(fetchFailed('EAI_AGAIN')),
        log: () => undefined,
      });
      expect(await uncached(target)).toMatchObject({ ok: false, failure: { kind: 'unreachable' } });
    });

    it('keeps a reset and an unreadable answer as unreachable', async () => {
      const reset = createModelDiscovery({
        fetch: () => Promise.reject(fetchFailed('ECONNRESET')),
        log: () => undefined,
      });
      expect(await reset(target)).toMatchObject({ failure: { kind: 'unreachable' } });
      const unreadable = createModelDiscovery({
        fetch: () => Promise.resolve(new Response('not json', { status: 200 })),
        log: () => undefined,
      });
      expect(await unreadable(target)).toMatchObject({ failure: { kind: 'unreachable' } });
    });

    it('never answers it from the cache, and drops the cached list', async () => {
      let failWith: Error | null = null;
      let now = 0;
      const discover = createModelDiscovery({
        ttlMs: 1_000,
        now: () => now,
        log: () => undefined,
        fetch: () =>
          failWith === null
            ? Promise.resolve(
                Response.json({ object: 'list', data: [{ id: 'm1', object: 'model' }] }),
              )
            : Promise.reject(failWith),
      });
      expect(await discover(target)).toMatchObject({ ok: true });

      failWith = fetchFailed('ECONNREFUSED');
      now += 1_001;
      expect(await discover(target)).toMatchObject({
        ok: false,
        failure: { kind: 'connection-failed' },
      });

      // The list was dropped: a later passing failure has nothing stale to fall back on.
      failWith = fetchFailed('ECONNRESET');
      expect(await discover(target)).toMatchObject({ ok: false, failure: { kind: 'unreachable' } });
    });
  });
});
