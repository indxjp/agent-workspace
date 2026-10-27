import { createCloudflareSandboxProvider } from '@agent-workspace/runtime/driver/cloudflare-sandbox';
import { createExternalDriver } from '@agent-workspace/runtime/driver/external';
import { describe, expect, it } from 'vitest';

import {
  accessTokenFor,
  containerSettings,
  handleBridgeRequest,
  secretsMatch,
} from '../infra/cloudflare/sandbox-bridge/src/bridge.js';
import type {
  BridgeEnv,
  NetworkPolicy,
  SandboxStub,
} from '../infra/cloudflare/sandbox-bridge/src/bridge.js';

const SECRET = 'bridge_SENTINEL_secret_0123456789';
const IMAGE = 'registry.example.com/agent-runtime@sha256:abc';
const BEARER = 'b'.repeat(43);

type Calls = {
  started: { policy: NetworkPolicy; id: string; bearer: string; timeoutSeconds: number }[];
  forwarded: { policy: NetworkPolicy; id: string; request: Request }[];
  destroyed: { policy: NetworkPolicy; id: string }[];
};

function fakeEnv(): { env: BridgeEnv; calls: Calls } {
  const calls: Calls = { started: [], forwarded: [], destroyed: [] };
  const env: BridgeEnv = {
    bridgeSecret: SECRET,
    runtimeImage: IMAGE,
    gatewayHost: 'gateway.example.com',
    sandbox(policy, id): SandboxStub {
      return {
        start: (settings) => {
          calls.started.push({ policy, id, ...settings });
          return Promise.resolve();
        },
        forward: (request) => {
          calls.forwarded.push({ policy, id, request });
          return Promise.resolve(new Response('pong', { status: 200 }));
        },
        destroy: () => {
          calls.destroyed.push({ policy, id });
          return Promise.resolve();
        },
      };
    },
  };
  return { env, calls };
}

const call = (path: string, init: RequestInit = {}) =>
  new Request(`https://bridge.example.workers.dev${path}`, init);

const createBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    image: IMAGE,
    sessionKey: 'session-1',
    bearer: BEARER,
    networkPolicy: 'none',
    gatewayHost: 'gateway.example.com',
    timeoutSeconds: 3600,
    ...over,
  });

const asManager = (secret = SECRET) => ({ authorization: `Bearer ${secret}` });

async function create(env: BridgeEnv, over: Record<string, unknown> = {}) {
  const response = await handleBridgeRequest(
    call('/v1/sandboxes', { method: 'POST', headers: asManager(), body: createBody(over) }),
    env,
  );
  return { response, body: (await response.clone().json()) as Record<string, string> };
}

describe('cloudflare sandbox bridge (ADR-0120 LC3, LC6)', () => {
  it('refuses unauthenticated, wrong and wrong-length secrets without touching a sandbox', async () => {
    const { env, calls } = fakeEnv();
    const attempts: Request[] = [
      call('/v1/sandboxes', { method: 'POST', body: createBody() }),
      call('/v1/sandboxes', { method: 'POST', headers: asManager('wrong'), body: createBody() }),
      call('/v1/sandboxes', {
        method: 'POST',
        headers: asManager(`${SECRET}x`),
        body: createBody(),
      }),
      call('/v1/sandboxes', {
        method: 'POST',
        headers: { authorization: SECRET },
        body: createBody(),
      }),
      call(`/v1/sandboxes/n-${'a'.repeat(32)}`, { method: 'DELETE' }),
      call(`/v1/sandboxes/n-${'a'.repeat(32)}`, { method: 'DELETE', headers: asManager('wrong') }),
      call(`/v1/sandboxes/n-${'a'.repeat(32)}/runtime/ping`),
      call(`/v1/sandboxes/n-${'a'.repeat(32)}/runtime/ping`, {
        headers: { 'x-bridge-access': 'f'.repeat(64), ...asManager() },
      }),
    ];
    for (const attempt of attempts) {
      const response = await handleBridgeRequest(attempt, env);
      const text = await response.text();
      expect(response.status).toBe(401);
      expect(text).toBe('{"error":"unauthorized"}');
      expect(text).not.toContain('wrong');
      expect(text).not.toContain(SECRET);
    }
    expect(calls).toEqual({ started: [], forwarded: [], destroyed: [] });
  });

  it('authenticates before it routes: unknown ids, paths and methods are 401, never 404 or 405', async () => {
    const { env, calls } = fakeEnv();
    const known = `n-${'a'.repeat(32)}`;
    const access = await accessTokenFor(SECRET, known);
    const attempts: Request[] = [
      call('/v1/sandboxes/providers-live-unknown', { method: 'DELETE' }),
      call('/v1/sandboxes/providers-live-unknown/runtime/ping'),
      call(`/v1/sandboxes/${known}/runtime/ping`),
      call(`/v1/sandboxes/${known}/runtime/ping`, { headers: asManager(BEARER) }),
      call(`/v1/sandboxes/${known}/runtime/ping`, { headers: { 'x-bridge-access': access } }),
      call('/v1/sandboxes/providers-live-unknown/runtime/ping', {
        headers: { 'x-bridge-access': access, authorization: `Bearer ${BEARER}` },
      }),
      call(`/v1/sandboxes/${known}`),
      call('/v1/sandboxes'),
      call('/v1/sandboxes/x/y'),
      call('/other'),
    ];
    for (const attempt of attempts) {
      const response = await handleBridgeRequest(attempt, env);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('{"error":"unauthorized"}');
    }
    expect(calls).toEqual({ started: [], forwarded: [], destroyed: [] });
  });

  it('answers 404 only to a caller that is authenticated, for an id it cannot map', async () => {
    const { env, calls } = fakeEnv();
    const unknown = 'providers-live-unknown';
    const authed = {
      'x-bridge-access': await accessTokenFor(SECRET, unknown),
      authorization: `Bearer ${BEARER}`,
    };
    const forward = await handleBridgeRequest(
      call(`/v1/sandboxes/${unknown}/runtime/ping`, { headers: authed }),
      env,
    );
    const destroy = await handleBridgeRequest(
      call(`/v1/sandboxes/${unknown}`, { method: 'DELETE', headers: asManager() }),
      env,
    );
    const method = await handleBridgeRequest(
      call(`/v1/sandboxes/${unknown}`, { headers: asManager() }),
      env,
    );
    expect([forward.status, destroy.status, method.status]).toEqual([404, 404, 405]);
    expect(calls).toEqual({ started: [], forwarded: [], destroyed: [] });
  });

  it('serves nothing while BRIDGE_SECRET is unset or short, even for an empty credential', async () => {
    const { env, calls } = fakeEnv();
    for (const bridgeSecret of [undefined, '', 'short']) {
      const unconfigured = { ...env, bridgeSecret } as unknown as BridgeEnv;
      for (const headers of [undefined, { authorization: 'Bearer ' }]) {
        const response = await handleBridgeRequest(
          call('/v1/sandboxes', {
            method: 'POST',
            ...(headers === undefined ? {} : { headers }),
            body: createBody(),
          }),
          unconfigured,
        );
        expect(response.status).toBe(503);
        expect(await response.text()).toBe('{"error":"not_configured"}');
      }
    }
    expect(calls).toEqual({ started: [], forwarded: [], destroyed: [] });
  });

  it('compares secrets by value, whatever their length', async () => {
    expect(await secretsMatch(SECRET, SECRET)).toBe(true);
    expect(await secretsMatch(`${SECRET}x`, SECRET)).toBe(false);
    expect(await secretsMatch('', SECRET)).toBe(false);
    expect(await secretsMatch('x'.repeat(10_000), SECRET)).toBe(false);
  });

  it('creates a sandbox and returns an access token bound to its id', async () => {
    const { env, calls } = fakeEnv();
    const { response, body } = await create(env);
    expect(response.status).toBe(201);
    expect(body['sandboxId']).toMatch(/^n-[0-9a-f]{32}$/u);
    expect(body['accessToken']).toBe(await accessTokenFor(SECRET, body['sandboxId'] ?? ''));
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(calls.started).toEqual([
      { policy: 'none', id: body['sandboxId'], bearer: BEARER, timeoutSeconds: 3600 },
    ]);
  });

  it('destroys a sandbox whose start fails and answers a stable 502 without the cause', async () => {
    const { env, calls } = fakeEnv();
    const failing: BridgeEnv = {
      ...env,
      sandbox(policy, id) {
        const stub = env.sandbox(policy, id);
        return {
          ...stub,
          start: () => Promise.reject(new Error(`provider_SENTINEL ${SECRET}`)),
          destroy: async () => {
            await stub.destroy();
            throw new Error('destroy failed too');
          },
        };
      },
    };
    const { response } = await create(failing);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('{"error":"start_failed"}');
    expect(calls.destroyed).toHaveLength(1);
    expect(calls.destroyed[0]?.id).toMatch(/^n-[0-9a-f]{32}$/u);
  });

  it('rejects unknown keys, bad values, and a deployment mismatch', async () => {
    const { env, calls } = fakeEnv();
    for (const over of [
      { extra: 1 },
      { networkPolicy: 'allowlist' },
      { bearer: 'short' },
      { timeoutSeconds: 0 },
      { timeoutSeconds: 1.5 },
      { sessionKey: '' },
    ]) {
      expect((await create(env, over)).response.status).toBe(400);
    }
    expect((await create(env, { image: 'other' })).response.status).toBe(409);
    expect((await create(env, { gatewayHost: 'other.example.com' })).response.status).toBe(409);
    const notJson = await handleBridgeRequest(
      call('/v1/sandboxes', { method: 'POST', headers: asManager(), body: '{' }),
      env,
    );
    expect(notJson.status).toBe(400);
    expect(calls.started).toEqual([]);
  });

  it('forwards with the access token, dropping it and keeping the runner bearer', async () => {
    const { env, calls } = fakeEnv();
    const { body } = await create(env);
    const id = body['sandboxId'] ?? '';
    const response = await handleBridgeRequest(
      call(`/v1/sandboxes/${id}/runtime/run?x=1`, {
        method: 'POST',
        headers: {
          'x-bridge-access': body['accessToken'] ?? '',
          authorization: `Bearer ${BEARER}`,
        },
        body: '{"a":1}',
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('pong');
    const forwarded = calls.forwarded[0];
    expect(forwarded?.policy).toBe('none');
    const url = new URL(forwarded?.request.url ?? '');
    expect(url.pathname + url.search).toBe('/run?x=1');
    expect(forwarded?.request.headers.get('x-bridge-access')).toBeNull();
    expect(forwarded?.request.headers.get('authorization')).toBe(`Bearer ${BEARER}`);
    expect(await forwarded?.request.text()).toBe('{"a":1}');
  });

  it("refuses another sandbox's access token", async () => {
    const { env, calls } = fakeEnv();
    const first = (await create(env)).body;
    const second = (await create(env)).body;
    const response = await handleBridgeRequest(
      call(`/v1/sandboxes/${second['sandboxId'] ?? ''}/runtime/ping`, {
        headers: { 'x-bridge-access': first['accessToken'] ?? '' },
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(calls.forwarded).toEqual([]);
  });

  it('destroys with the secret, and unknown routes are 404', async () => {
    const { env, calls } = fakeEnv();
    const id = (await create(env)).body['sandboxId'] ?? '';
    const response = await handleBridgeRequest(
      call(`/v1/sandboxes/${id}`, { method: 'DELETE', headers: asManager() }),
      env,
    );
    expect(response.status).toBe(204);
    expect(calls.destroyed).toEqual([{ policy: 'none', id }]);
    expect((await handleBridgeRequest(call('/other', { headers: asManager() }), env)).status).toBe(
      404,
    );
    expect(
      (
        await handleBridgeRequest(
          call('/v1/sandboxes/not-an-id', { method: 'DELETE', headers: asManager() }),
          env,
        )
      ).status,
    ).toBe(404);
  });

  it('LC4: refuses open and restricted by name and starts only none, for the gateway host', async () => {
    const { env, calls } = fakeEnv();
    for (const networkPolicy of ['open', 'restricted']) {
      const { response } = await create(env, { networkPolicy });
      expect(response.status).toBe(422);
      expect(await response.text()).toBe('{"error":"network_policy_unsupported"}');
    }
    expect(calls).toEqual({ started: [], forwarded: [], destroyed: [] });

    expect((await create(env, { gatewayHost: 'other.example.com' })).response.status).toBe(409);
    const { response, body } = await create(env);
    expect(response.status).toBe(201);
    expect(body['sandboxId']).toMatch(/^n-[0-9a-f]{32}$/u);
    expect(calls.started.map((started) => started.policy)).toEqual(['none']);
  });
});

describe('container settings per network policy (ADR-0131)', () => {
  it('none starts without outbound internet and allows only the gateway host', () => {
    expect(containerSettings('none', 'gateway.example.com')).toEqual({
      enableInternet: false,
      allowedHosts: ['gateway.example.com'],
    });
  });

  it('open starts with outbound internet and no host list', () => {
    expect(containerSettings('open', 'gateway.example.com')).toEqual({ enableInternet: true });
  });
});

describe('driver and bridge path contract (ADR-0120 LC1, LC3)', () => {
  // The real driver over the real handler: a path drifting on either side fails here, not live.
  // The shipped provider declares no network policy (ADR-0131); the path contract needs `none`.
  const driverOver = (env: BridgeEnv) => {
    const provider = createCloudflareSandboxProvider({
      bridgeUrl: 'https://bridge.example.workers.dev/',
      fetch: (url, init) => handleBridgeRequest(new Request(url, init), env),
    });
    return createExternalDriver<string, string>({
      driverId: 'cloudflare-sandbox',
      provider: {
        ...provider,
        capabilities: { ...provider.capabilities, networkPolicies: ['none'] },
      },
      images: new Map([['claude-agent-sdk', IMAGE]]),
      gatewayUrl: 'https://gateway.example.com',
      startAgent: () => {
        throw new Error('not used');
      },
    });
  };
  const config = {
    engine: 'claude-agent-sdk',
    sessionId: 'session-1',
    workspacePath: '/ws/session-1',
    runSpec: {
      runtimeProfileId: 'profile-1',
      driver: 'cloudflare-sandbox',
      networkPolicy: 'none',
      filesystem: 'read-write',
    },
  } as const;

  it('creates, forwards and destroys through the routes the bridge serves', async () => {
    const { env, calls } = fakeEnv();
    const driver = driverOver(env);
    const handle = await driver.create(config, SECRET);
    expect(calls.started).toHaveLength(1);
    const id = calls.started[0]?.id ?? '';
    expect(handle.externalId).toBe(id);

    const url = driver.requestUrl(handle, '/ping');
    expect(new URL(url).pathname).toBe(`/v1/sandboxes/${id}/runtime/ping`);
    const response = await handleBridgeRequest(
      new Request(url, { headers: await driver.authHeaders(handle) }),
      env,
    );
    expect(response.status).toBe(200);
    const forwarded = calls.forwarded[0]?.request;
    expect(new URL(forwarded?.url ?? '').pathname).toBe('/ping');
    expect(forwarded?.headers.get('x-bridge-access')).toBeNull();
    expect(forwarded?.headers.get('authorization')).toMatch(/^Bearer /u);

    await driver.destroy(handle, SECRET);
    expect(calls.destroyed).toEqual([{ policy: 'none', id }]);
  });

  it('answers an unauthenticated create with the bridge-owned 401 the lane waits for', async () => {
    const { env, calls } = fakeEnv();
    const response = await handleBridgeRequest(
      call('/v1/sandboxes', { method: 'POST', body: '{}' }),
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"error":"unauthorized"}');
    expect(calls.started).toEqual([]);
  });
});
