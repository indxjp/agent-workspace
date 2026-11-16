import { describe, expect, it, vi } from 'vitest';

import {
  ACA_SESSIONS_MANAGEMENT_API_VERSION,
  createAcaSessionIdentifier,
  createAcaSessionsRestClient,
} from './aca-sessions.js';
import { CONFIG, restClientWith } from './aca-sessions.test-support.js';

describe('ACA dynamic sessions identifiers', () => {
  it('derives an opaque, deterministic Azure-safe identifier with HMAC', () => {
    const secret = 'a'.repeat(32);
    const first = createAcaSessionIdentifier(secret, CONFIG);
    const second = createAcaSessionIdentifier(secret, { ...CONFIG });
    const otherSession = createAcaSessionIdentifier(secret, {
      ...CONFIG,
      sessionId: 'conversation-2',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^aw-[a-f0-9]{64}$/u);
    expect(first).not.toContain(CONFIG.sessionId);
    expect(first).not.toBe(otherSession);
  });

  it('requires a manager secret with at least 256 bits of material', () => {
    expect(() => createAcaSessionIdentifier('short', CONFIG)).toThrow(/at least 32 bytes/u);
  });
});

describe('ACA dynamic sessions REST client', () => {
  it('routes allocation, get, and stop through the endpoint with identifier and bearer token', async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const doFetch = vi.fn<typeof fetch>((input, init = {}) => {
      const url = new URL(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      );
      calls.push({ url, init });
      if (url.pathname.endsWith('/getSession')) {
        return Promise.resolve(
          Response.json({
            identifier: 'aw-test',
            etag: 'etag-1',
            expiresAt: '2026-09-11T01:00:00.000Z',
          }),
        );
      }
      return Promise.resolve(new Response('ok'));
    });
    const client = createAcaSessionsRestClient({
      poolManagementEndpoint: 'https://pool.example/base',
      getAccessToken: () => Promise.resolve('token'),
      fetch: doFetch,
    });

    await client.allocate('aw-test');
    await expect(client.getSession('aw-test')).resolves.toMatchObject({
      identifier: 'aw-test',
      etag: 'etag-1',
    });
    await client.stopSession('aw-test');

    expect(calls.map(({ url }) => url.pathname)).toEqual([
      '/base/ping',
      '/base/.management/getSession',
      '/base/.management/stopSession',
    ]);
    for (const { url, init } of calls) {
      expect(url.searchParams.get('identifier')).toBe('aw-test');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer token');
      expect(init.redirect).toBe('error');
    }
    expect(calls[0]?.url.searchParams.has('api-version')).toBe(false);
    expect(calls[1]?.url.searchParams.get('api-version')).toBe(ACA_SESSIONS_MANAGEMENT_API_VERSION);
    expect(calls[2]?.url.searchParams.get('api-version')).toBe(ACA_SESSIONS_MANAGEMENT_API_VERSION);
  });

  it('adds the identifier to arbitrary runtime paths without discarding their query', () => {
    const client = createAcaSessionsRestClient({
      poolManagementEndpoint: 'https://pool.example',
      getAccessToken: () => Promise.resolve('unused'),
      fetch: vi.fn(),
    });
    const url = new URL(client.requestUrl('aw-test', '/files?path=reports%2Ftoday.md'));
    expect(url.pathname).toBe('/files');
    expect(url.searchParams.get('path')).toBe('reports/today.md');
    expect(url.searchParams.get('identifier')).toBe('aw-test');
  });

  it('rejects absolute routes and invalid identifiers before making a request', () => {
    const client = createAcaSessionsRestClient({
      poolManagementEndpoint: 'https://pool.example',
      getAccessToken: () => Promise.resolve('unused'),
      fetch: vi.fn(),
    });
    expect(() => client.requestUrl('abc', '/ping')).toThrow(/identifier must be/u);
    expect(() => client.requestUrl('aw-test', '//attacker.example/run')).toThrow(
      /must start with one slash/u,
    );
  });
});

describe('ACA dynamic sessions REST client failures', () => {
  it('treats missing and expired sessions as an idempotent stop', async () => {
    for (const status of [404, 410]) {
      const client = restClientWith(() => Promise.resolve(new Response('gone', { status })));
      await expect(client.stopSession('aw-test')).resolves.toBeUndefined();
      await expect(client.getSession('aw-test')).resolves.toBeNull();
    }
  });

  it("recognizes Azure's documented structured HTTP 400 session-not-found contract", async () => {
    const client = restClientWith(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              code: 'SessionWithIdentifierNotFound',
              message: "The session identifier doesn't exist in this session pool",
              traceId: 'trace-1',
            },
          },
          { status: 400 },
        ),
      ),
    );

    await expect(client.getSession('aw-test')).resolves.toBeNull();
    await expect(client.stopSession('aw-test')).resolves.toBeUndefined();
  });

  it('does not mistake other structured HTTP 400 failures for an expired session', async () => {
    const client = restClientWith(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              code: 'SessionRequestValidationFailed',
              message: 'The api-version query parameter is invalid',
            },
          },
          { status: 400 },
        ),
      ),
    );

    await expect(client.getSession('aw-test')).rejects.toThrow(
      /400 SessionRequestValidationFailed: The api-version query parameter is invalid/u,
    );
    await expect(client.stopSession('aw-test')).rejects.toThrow(
      /400 SessionRequestValidationFailed/u,
    );
  });

  it('does not hide authorization or service errors', async () => {
    const client = restClientWith(() =>
      Promise.resolve(new Response('forbidden', { status: 403 })),
    );
    await expect(client.allocate('aw-test')).rejects.toThrow(/403 forbidden/u);
    await expect(client.getSession('aw-test')).rejects.toThrow(/403 forbidden/u);
    await expect(client.stopSession('aw-test')).rejects.toThrow(/403 forbidden/u);
  });
});
