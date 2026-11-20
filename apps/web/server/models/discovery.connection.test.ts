import { EgressRefusedError } from '@agent-workspace/core';
import { describe, expect, it } from 'vitest';

import { createModelDiscovery } from './discovery';
import { connection } from './discovery.test-support';

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
