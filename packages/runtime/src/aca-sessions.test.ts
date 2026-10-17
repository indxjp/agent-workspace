import { describe, expect, it, vi } from 'vitest';

import {
  ACA_SESSIONS_MANAGEMENT_API_VERSION,
  createAcaSessionIdentifier,
  createAcaSessionsCapabilities,
  createAcaSessionsDriver,
  createAcaSessionsRestClient,
  type AcaSession,
  type AcaSessionsClient,
} from './aca-sessions.js';
import type { RuntimeConfig } from './driver.js';

const CONFIG: RuntimeConfig = {
  sessionId: 'conversation-1',
  engine: 'claude-agent-sdk',
  workspacePath: '/workspace/conversation-1',
  runtimeProfileId: 'profile-1',
};

function echoConnection(value: string) {
  return {
    events: (async function* () {
      await Promise.resolve();
      yield value;
    })(),
    sessionId: Promise.resolve('claude-session'),
    interrupt: () => Promise.resolve(),
  };
}

function fakeClient(): {
  client: AcaSessionsClient;
  allocated: string[];
  stopped: string[];
  requests: Array<{ identifier: string; path: string; init?: RequestInit }>;
} {
  const allocated: string[] = [];
  const stopped: string[] = [];
  const requests: Array<{ identifier: string; path: string; init?: RequestInit }> = [];
  const sessions = new Map<string, AcaSession>();
  const client: AcaSessionsClient = {
    requestUrl: (identifier, path) =>
      `https://pool.example${path}${path.includes('?') ? '&' : '?'}identifier=${identifier}`,
    request: (identifier, path, init) => {
      requests.push({ identifier, path, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(new Response('ok'));
    },
    allocate: (identifier) => {
      allocated.push(identifier);
      sessions.set(identifier, {
        identifier,
        createdAt: new Date('2026-09-11T00:00:00.000Z'),
        expiresAt: new Date('2026-09-11T00:10:00.000Z'),
      });
      return Promise.resolve();
    },
    getSession: (identifier) => Promise.resolve(sessions.get(identifier) ?? null),
    stopSession: (identifier) => {
      stopped.push(identifier);
      sessions.delete(identifier);
      return Promise.resolve();
    },
  };
  return { client, allocated, stopped, requests };
}

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

  it('treats missing and expired sessions as an idempotent stop', async () => {
    for (const status of [404, 410]) {
      const client = createAcaSessionsRestClient({
        poolManagementEndpoint: 'https://pool.example',
        getAccessToken: () => Promise.resolve('token'),
        fetch: () => Promise.resolve(new Response('gone', { status })),
      });
      await expect(client.stopSession('aw-test')).resolves.toBeUndefined();
      await expect(client.getSession('aw-test')).resolves.toBeNull();
    }
  });

  it("recognizes Azure's documented structured HTTP 400 session-not-found contract", async () => {
    const client = createAcaSessionsRestClient({
      poolManagementEndpoint: 'https://pool.example',
      getAccessToken: () => Promise.resolve('token'),
      fetch: () =>
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
    });

    await expect(client.getSession('aw-test')).resolves.toBeNull();
    await expect(client.stopSession('aw-test')).resolves.toBeUndefined();
  });

  it('does not mistake other structured HTTP 400 failures for an expired session', async () => {
    const client = createAcaSessionsRestClient({
      poolManagementEndpoint: 'https://pool.example',
      getAccessToken: () => Promise.resolve('token'),
      fetch: () =>
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
    });

    await expect(client.getSession('aw-test')).rejects.toThrow(
      /400 SessionRequestValidationFailed: The api-version query parameter is invalid/u,
    );
    await expect(client.stopSession('aw-test')).rejects.toThrow(
      /400 SessionRequestValidationFailed/u,
    );
  });

  it('does not hide authorization or service errors', async () => {
    const client = createAcaSessionsRestClient({
      poolManagementEndpoint: 'https://pool.example',
      getAccessToken: () => Promise.resolve('token'),
      fetch: () => Promise.resolve(new Response('forbidden', { status: 403 })),
    });
    await expect(client.allocate('aw-test')).rejects.toThrow(/403 forbidden/u);
    await expect(client.getSession('aw-test')).rejects.toThrow(/403 forbidden/u);
    await expect(client.stopSession('aw-test')).rejects.toThrow(/403 forbidden/u);
  });
});

describe('aca-sessions runtime driver', () => {
  it('advertises only the network policy the registered pool can enforce', () => {
    expect(createAcaSessionsCapabilities('EgressDisabled')).toMatchObject({
      isolation: 'microvm',
      persistentFilesystem: false,
      networkPolicies: ['none'],
      gpu: false,
      managedByProvider: true,
    });
    expect(createAcaSessionsCapabilities('EgressEnabled').networkPolicies).toEqual(['open']);
  });

  it('allocates a ready session and binds startAgent to authenticated session access', async () => {
    const { client, allocated } = fakeClient();
    const driver = createAcaSessionsDriver<string, string>({
      engine: 'claude-agent-sdk',
      poolManagementEndpoint: 'https://pool.example',
      networkStatus: 'EgressDisabled',
      identifierSecret: 's'.repeat(32),
      client,
      startAgent: (runtime, request, access) =>
        echoConnection(`${access.requestUrl('/run')}:${runtime.externalId}:${request}`),
    });

    const handle = await driver.create(CONFIG);
    expect(allocated).toEqual([handle.externalId]);
    expect(handle).toMatchObject({
      driver: 'aca-sessions',
      workspacePath: CONFIG.workspacePath,
      createdAt: new Date('2026-09-11T00:00:00.000Z'),
      expiresAt: new Date('2026-09-11T00:10:00.000Z'),
    });
    expect(await driver.isLive(handle)).toBe(true);

    const connection = await driver.startAgent(handle, 'request');
    const events: string[] = [];
    for await (const event of connection.events) events.push(event);
    expect(events).toEqual([
      `https://pool.example/run?identifier=${handle.externalId}:${handle.externalId}:request`,
    ]);
  });

  it('accepts a prederived identifier and keeps destroy idempotent', async () => {
    const { client, stopped } = fakeClient();
    const driver = createAcaSessionsDriver<string, string>({
      engine: 'claude-agent-sdk',
      poolManagementEndpoint: 'https://pool.example',
      networkStatus: 'EgressDisabled',
      identifierForConfig: () => 'manager-derived-id',
      client,
      startAgent: () => echoConnection('unused'),
    });
    const handle = await driver.create(CONFIG);
    expect(handle.externalId).toBe('manager-derived-id');

    await driver.destroy(handle);
    await driver.destroy(handle);
    expect(stopped).toEqual(['manager-derived-id', 'manager-derived-id']);
    expect(await driver.isLive(handle)).toBe(false);
  });

  it('stops an allocated session if post-readiness metadata cannot be retrieved', async () => {
    const { client, stopped } = fakeClient();
    client.getSession = () => Promise.reject(new Error('metadata unavailable'));
    const driver = createAcaSessionsDriver<string, string>({
      engine: 'claude-agent-sdk',
      poolManagementEndpoint: 'https://pool.example',
      networkStatus: 'EgressDisabled',
      identifierSecret: 's'.repeat(32),
      client,
      startAgent: () => echoConnection('unused'),
    });

    await expect(driver.create(CONFIG)).rejects.toThrow(/metadata unavailable/u);
    expect(stopped).toHaveLength(1);
  });

  it.each([
    {
      name: 'a different driver',
      patch: { driver: 'docker' as const },
      message: /incompatible driver docker/u,
    },
    {
      name: 'restricted networking',
      patch: { networkPolicy: 'restricted' as const },
      message: /restricted network policy/u,
    },
    {
      name: 'an allowlist',
      patch: { allowedDomains: ['api.anthropic.com'] },
      message: /allowedDomains cannot be enforced/u,
    },
    {
      name: 'persistent paths',
      patch: { persistPaths: ['/workspace/output'] },
      message: /persistPaths cannot be enforced/u,
    },
    {
      name: 'a read-only filesystem',
      patch: { filesystem: 'read-only' as const },
      message: /read-only filesystem profiles cannot be enforced/u,
    },
    {
      name: 'ephemeral disk sizing',
      patch: { diskMb: 4096 },
      message: /diskMb cannot be configured or verified/u,
    },
    {
      name: 'a hard run timeout',
      patch: { timeoutSeconds: 30 },
      message: /exposes only an idle cooldown/u,
    },
    {
      name: 'unknown fixed CPU sizing',
      patch: { cpu: 1 },
      message: /pool's fixed value is unknown/u,
    },
    {
      name: 'unknown fixed memory sizing',
      patch: { memoryMb: 2048 },
      message: /pool's fixed value is unknown/u,
    },
    {
      name: 'unknown idle cooldown',
      patch: { idleTimeoutSeconds: 600 },
      message: /pool's fixed value is unknown/u,
    },
    {
      name: 'driver-specific per-run settings',
      patch: { driverConfig: { readySessionInstances: 1 } },
      message: /unsupported per-run ACA settings/u,
    },
  ])('rejects $name instead of weakening the profile', async ({ patch, message }) => {
    const { client, allocated } = fakeClient();
    const driver = createAcaSessionsDriver<string, string>({
      engine: 'claude-agent-sdk',
      poolManagementEndpoint: 'https://pool.example',
      networkStatus: 'EgressDisabled',
      identifierSecret: 's'.repeat(32),
      client,
      startAgent: () => echoConnection('unused'),
    });
    await expect(
      driver.create({
        ...CONFIG,
        runSpec: {
          runtimeProfileId: 'profile-1',
          driver: 'aca-sessions',
          networkPolicy: 'none',
          filesystem: 'read-write',
          ...patch,
        },
      }),
    ).rejects.toThrow(message);
    expect(allocated).toHaveLength(0);
  });

  it('accepts resource, cooldown, and connection constraints only when they match the pool', async () => {
    const { client, allocated } = fakeClient();
    const driver = createAcaSessionsDriver<string, string>({
      engine: 'claude-agent-sdk',
      poolManagementEndpoint: 'https://pool.example',
      networkStatus: 'EgressDisabled',
      identifierSecret: 's'.repeat(32),
      poolConfiguration: {
        cpu: 1,
        memoryMb: 2048,
        cooldownPeriodInSeconds: 600,
        runtimeConnectionId: 'aca-preview',
      },
      client,
      startAgent: () => echoConnection('unused'),
    });
    const exactSpec = {
      runtimeProfileId: 'profile-1',
      driver: 'aca-sessions' as const,
      runtimeConnectionId: 'aca-preview',
      cpu: 1,
      memoryMb: 2048,
      networkPolicy: 'none' as const,
      filesystem: 'read-write' as const,
      idleTimeoutSeconds: 600,
    };

    await expect(driver.create({ ...CONFIG, runSpec: exactSpec })).resolves.toMatchObject({
      driver: 'aca-sessions',
    });
    expect(allocated).toHaveLength(1);

    await expect(
      driver.create({ ...CONFIG, runSpec: { ...exactSpec, memoryMb: 1024 } }),
    ).rejects.toThrow(/requested memoryMb 1024 does not match the pool's fixed value 2048/u);
    await expect(
      driver.create({ ...CONFIG, runSpec: { ...exactSpec, idleTimeoutSeconds: 300 } }),
    ).rejects.toThrow(/requested idleTimeoutSeconds 300 does not match/u);
    await expect(
      driver.create({ ...CONFIG, runSpec: { ...exactSpec, runtimeConnectionId: 'other-pool' } }),
    ).rejects.toThrow(/requested runtimeConnectionId "other-pool" does not match/u);
  });

  it('rejects a policy that disagrees with the session pool egress status', async () => {
    const { client } = fakeClient();
    const driver = createAcaSessionsDriver<string, string>({
      engine: 'claude-agent-sdk',
      poolManagementEndpoint: 'https://pool.example',
      networkStatus: 'EgressEnabled',
      identifierSecret: 's'.repeat(32),
      client,
      startAgent: () => echoConnection('unused'),
    });
    await expect(
      driver.create({
        ...CONFIG,
        runSpec: {
          runtimeProfileId: 'profile-1',
          driver: 'aca-sessions',
          networkPolicy: 'none',
          filesystem: 'read-write',
        },
      }),
    ).rejects.toThrow(/pool is EgressEnabled/u);
  });

  it('forwards workspace archive operations through the same identifier route', async () => {
    const { client, requests } = fakeClient();
    const driver = createAcaSessionsDriver<string, string>({
      engine: 'claude-agent-sdk',
      poolManagementEndpoint: 'https://pool.example',
      networkStatus: 'EgressDisabled',
      identifierSecret: 's'.repeat(32),
      client,
      startAgent: () => echoConnection('unused'),
    });
    const handle = await driver.create(CONFIG);
    await driver.putFiles?.(handle, new ReadableStream());
    await driver.getFiles?.(handle, ['reports/today.md', 'output']);

    expect(requests.map(({ identifier, path }) => ({ identifier, path }))).toEqual([
      { identifier: handle.externalId, path: '/files' },
      {
        identifier: handle.externalId,
        path: '/files?path=reports%2Ftoday.md&path=output',
      },
    ]);
  });
});

describe('aca-sessions runtime: one engine per pool (ENG-07, ADR-0073 D6)', () => {
  function poolFor(engine: string, client: AcaSessionsClient) {
    return createAcaSessionsDriver<string, string>({
      engine,
      poolManagementEndpoint: 'https://pool.example',
      networkStatus: 'EgressDisabled',
      identifierSecret: 's'.repeat(32),
      client,
      startAgent: (runtime, request) => echoConnection(`${runtime.externalId}:${request}`),
    });
  }

  it("serves a run for the pool's own engine, for either of two engines", async () => {
    for (const engine of ['claude-agent-sdk', 'pi']) {
      const { client, allocated } = fakeClient();
      await poolFor(engine, client).create({ ...CONFIG, engine });
      expect(allocated).toHaveLength(1);
    }
  });

  it("refuses another engine's run before an allocation is made", async () => {
    const { client, allocated } = fakeClient();
    await expect(poolFor('pi', client).create(CONFIG)).rejects.toThrow(
      /carries engine "pi".*"claude-agent-sdk"/u,
    );
    expect(allocated).toHaveLength(0);
  });
});
