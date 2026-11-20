import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { counterIds } from '../ids';
import { createModelDiscovery, discoveryCacheFingerprint } from './discovery';
import {
  closeFixtureServers,
  connection,
  fixtureServer,
  modelsResponse,
} from './discovery.test-support';

afterEach(closeFixtureServers);

describe('createModelDiscovery — cache', () => {
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

  it('reads the system clock by default, so a list older than the TTL is fetched again', async () => {
    const server = await fixtureServer((_req, res) => modelsResponse(res, ['m1']));
    const discover = createModelDiscovery({ ttlMs: 1 });
    const target = connection('openai-compatible', { baseUrl: server.baseUrl });

    await discover(target);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await discover(target);
    expect(server.requests).toBe(2);
  });

  it('takes one request id per provider call from the id generator, none for a cached answer', async () => {
    const server = await fixtureServer((_req, res) => modelsResponse(res, ['m1']));
    const minted: string[] = [];
    const ids = counterIds();
    const discover = createModelDiscovery({
      ids: { newId: () => minted[minted.push(ids.newId()) - 1] ?? '' },
    });
    const target = connection('openai-compatible', { baseUrl: server.baseUrl });

    await discover(target);
    await discover(target);
    expect(minted).toEqual(['00000000-0000-4000-8000-000000000001']);
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
});
