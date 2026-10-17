import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeConfig, RuntimeRunSpec } from '../driver.js';
import { createVercelSandboxProvider } from '../vercel-sandbox.js';
import { createExternalDriver, type ExternalProvider } from './driver.js';
import { createE2bProvider } from './e2b.js';
import { createSealer } from './stateless.js';

const SECRET = 'stateless-manager-secret-0123456789abcdef';
const OTHER_SECRET = 'a-different-manager-secret-0123456789ab';
const TOKEN = 'vercel_SENTINEL_access_token_0123456789';
const IMAGE = `registry.example.com/agent-runtime@sha256:${'a'.repeat(64)}`;
const IMAGES = new Map([['claude-agent-sdk', IMAGE]]);

type Call = { method: string; url: string; body: unknown };
type Fake = (call: Call) => { status: number; body?: unknown };

function fakeFetch(respond: Fake): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const raw = typeof init?.body === 'string' ? init.body : undefined;
      const call = {
        method: init?.method ?? 'GET',
        url: input instanceof Request ? input.url : String(input),
        body: raw === undefined ? undefined : (JSON.parse(raw) as unknown),
      };
      calls.push(call);
      const answer = respond(call);
      return Promise.resolve(Response.json(answer.body ?? {}, { status: answer.status }));
    },
  };
}

const runSpec: RuntimeRunSpec = {
  runtimeProfileId: 'profile-1',
  driver: 'vercel-sandbox',
  networkPolicy: 'none',
  filesystem: 'read-write',
};

const config: RuntimeConfig = {
  engine: 'claude-agent-sdk',
  sessionId: 'session-1',
  workspacePath: '/ws/session-1',
  runtimeProfileId: 'profile-1',
  runSpec,
};

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

afterEach(() => {
  vi.useRealTimers();
});

function driverOf(provider: ExternalProvider, secret = SECRET) {
  return createExternalDriver<never, never>({
    provider,
    driverId: 'vercel-sandbox',
    images: IMAGES,
    gatewayUrl: 'https://gateway.example.com/v1',
    startAgent: () => {
      throw new Error('not used');
    },
    sealSecret: secret,
  });
}

describe('the stateless seal (ADR-0126)', () => {
  const sealer = createSealer(SECRET, 'vercel-sandbox');
  const sandbox = {
    sandboxId: 'aw-x',
    origin: 'https://runner.vercel.run',
    accessHeaders: { 'x-token': 'traffic' },
    createdAt: 1,
    expiresAt: 2,
    workspacePath: '/ws',
    lookupKey: 'key',
  };

  it('opens what it sealed, and derives the same lookup key and bearer from the same secret', () => {
    const id = sealer.seal(sandbox);
    expect(id).toMatch(/^s[A-Za-z0-9_-]+$/u);
    expect(sealer.open(id)).toEqual(sandbox);
    const again = createSealer(SECRET, 'vercel-sandbox');
    expect(again.lookupKey('p:s')).toBe(sealer.lookupKey('p:s'));
    expect(again.bearer('key')).toBe(sealer.bearer('key'));
    expect(sealer.lookupKey('p:s')).not.toBe(sealer.lookupKey('p:t'));
    expect(sealer.bearer('key')).not.toBe(sealer.lookupKey('key'));
  });

  it('does not open an id that was tampered with, sealed by another secret, or made for another driver', () => {
    const id = sealer.seal(sandbox);
    const flipped = `${id.slice(0, 20)}${id[20] === 'A' ? 'B' : 'A'}${id.slice(21)}`;
    expect(sealer.open(flipped)).toBeUndefined();
    expect(sealer.open(id.slice(0, -4))).toBeUndefined();
    expect(sealer.open('not-sealed')).toBeUndefined();
    expect(sealer.open('')).toBeUndefined();
    expect(createSealer(OTHER_SECRET, 'vercel-sandbox').open(id)).toBeUndefined();
    expect(createSealer(SECRET, 'external').open(id)).toBeUndefined();
  });

  it('refuses a short secret by name', () => {
    expect(() => createSealer('short', 'vercel-sandbox')).toThrow(/at least 32 characters/u);
  });
});

describe('a stateless vercel-sandbox driver', () => {
  const sessionRoutes = {
    routes: [{ port: 8080, url: 'https://runner.vercel.run', subdomain: 'runner' }],
    session: { id: 'sess_1', status: 'running', timeout: 86_400_000 },
  };

  function vercel(fake: Fake) {
    const { fetch, calls } = fakeFetch(fake);
    return {
      calls,
      provider: createVercelSandboxProvider({
        teamId: 'team_1',
        projectId: 'prj_1',
        fetch,
        tier: 'pro',
      }),
    };
  }

  const created: Fake = (call) =>
    call.url.includes('/v4/sandboxes') ? { status: 200, body: sessionRoutes } : { status: 200 };

  it('names the sandbox from the session, derives its bearer, and seals the address into the id', async () => {
    const { provider, calls } = vercel(created);
    const driver = driverOf(provider);
    const handle = await driver.create(config, TOKEN);

    const lookupKey = createSealer(SECRET, 'vercel-sandbox').lookupKey('profile-1:session-1');
    expect(handle.externalId).toBe(`aw-${lookupKey}`);
    expect(handle.id).toMatch(/^s[A-Za-z0-9_-]+$/u);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'POST']);

    const start = calls[2]?.body as { env: Record<string, string> };
    const bearer = start.env['RUNTIME_SANDBOX_BEARER'];
    expect(bearer).toBe(createSealer(SECRET, 'vercel-sandbox').bearer(lookupKey));
    expect(handle.id).not.toContain(String(bearer));
    expect(JSON.stringify([handle, ...calls.slice(0, 2)])).not.toContain(String(bearer));
  });

  it('serves the handle from a second driver that shares the secret and nothing else', async () => {
    const first = vercel(created);
    const handle = await driverOf(first.provider).create(config, TOKEN);
    const bearer = (first.calls[2]?.body as { env: Record<string, string> }).env[
      'RUNTIME_SANDBOX_BEARER'
    ];

    const second = driverOf(vercel(created).provider);
    expect(second.recover?.(handle.id)).toMatchObject({
      id: handle.id,
      externalId: handle.externalId,
      workspacePath: '/ws/session-1',
    });
    expect(second.requestUrl(handle, '/run')).toBe('https://runner.vercel.run/run');
    expect(await second.authHeaders(handle)).toEqual({ authorization: `Bearer ${String(bearer)}` });
    expect(await second.isLive(handle)).toBe(true);

    const stranger = driverOf(vercel(created).provider, OTHER_SECRET);
    expect(stranger.recover?.(handle.id)).toBeUndefined();
    expect(() => stranger.requestUrl(handle, '/run')).toThrow(/no longer live/u);
  });

  it('does not recover an id whose sandbox has expired', async () => {
    const { provider } = vercel(created);
    const driver = driverOf(provider);
    vi.useFakeTimers({ toFake: ['Date'] });
    const handle = await driver.create(
      { ...config, runSpec: { ...runSpec, timeoutSeconds: 1 } },
      TOKEN,
    );
    vi.setSystemTime(Date.now() + 2_000);
    expect(driver.recover?.(handle.id)).toBeUndefined();
    expect(await driver.isLive(handle)).toBe(false);
  });

  it('finds the running sandbox of a session through the provider, and nothing when there is none', async () => {
    const name = `aw-${createSealer(SECRET, 'vercel-sandbox').lookupKey('profile-1:session-1')}`;
    const expiresAt = Date.now() + 600_000;
    const running = vercel((call) => {
      if (call.url.includes(`/v2/sandboxes/${name}`)) {
        return {
          status: 200,
          body: { sandbox: { name, status: 'running', currentSessionId: 'sess_1', expiresAt } },
        };
      }
      return { status: 200, body: sessionRoutes };
    });
    const driver = driverOf(running.provider);
    const found = await driver.find?.(config, TOKEN);
    expect(found).toMatchObject({ externalId: name, driver: 'vercel-sandbox' });
    expect(driver.requestUrl(must(found), '/run')).toBe('https://runner.vercel.run/run');
    expect(running.calls[0]?.url).toContain('projectId=prj_1');

    for (const answer of [
      { status: 404 },
      { status: 200, body: { sandbox: { name, status: 'stopped', currentSessionId: 'sess_1' } } },
    ]) {
      const none = driverOf(vercel(() => answer).provider);
      expect(await none.find?.(config, TOKEN)).toBeUndefined();
    }
  });

  it('needs the provider key for find, and reports a provider failure without its body', async () => {
    const driver = driverOf(vercel(() => ({ status: 500, body: { error: TOKEN } })).provider);
    await expect(driver.find?.(config)).rejects.toMatchObject({
      code: 'provider_credential_required',
    });
    const failure = await driver.find?.(config, TOKEN).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).not.toContain(TOKEN);
  });

  it('refuses a provider that cannot find a sandbox again', () => {
    const base = createE2bProvider();
    const provider: ExternalProvider = {
      id: base.id,
      capabilities: base.capabilities,
      restrictedRefusal: base.restrictedRefusal,
      create: (...args) => base.create(...args),
      destroy: (...args) => base.destroy(...args),
    };
    expect(() => driverOf(provider)).toThrow(/cannot be used statelessly/u);
  });
});

describe('a stateless vercel-sandbox create is idempotent per session', () => {
  const NAME = `aw-${createSealer(SECRET, 'vercel-sandbox').lookupKey('profile-1:session-1')}`;
  const EXPIRES = Date.now() + 600_000;
  const created = {
    routes: [{ port: 8080, url: 'https://runner.vercel.run' }],
    session: { id: 'sess_1', status: 'running', timeout: 86_400_000 },
  };

  /** A provider with one named sandbox; with `race`, the first create's answer waits for a rival's 409. */
  function fakeProvider(
    initialStatus?: string,
    options: { failStart?: boolean; race?: boolean } = {},
  ) {
    let status = initialStatus;
    let release: () => void = () => undefined;
    const rivalLost = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (options.race !== true) release();
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const method = init?.method ?? 'GET';
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      calls.push(`${method} ${path}`);
      if (method === 'GET' && path === `/v2/sandboxes/${NAME}`) {
        return status === undefined
          ? Response.json({}, { status: 404 })
          : Response.json({
              sandbox: { name: NAME, status, currentSessionId: 'sess_1', expiresAt: EXPIRES },
            });
      }
      if (method === 'GET') return Response.json(created);
      if (method === 'DELETE') {
        status = undefined;
        return Response.json({});
      }
      if (path === '/v4/sandboxes') {
        if (status !== undefined) {
          release();
          return Response.json({}, { status: 409 });
        }
        status = 'running';
        await rivalLost;
        return Response.json(created);
      }
      return Response.json({}, { status: options.failStart === true ? 500 : 200 });
    };
    const driver = driverOf(
      createVercelSandboxProvider({
        teamId: 'team_1',
        projectId: 'prj_1',
        fetch,
        tier: 'pro',
        retryDelayMs: 0,
      }),
    );
    const count = (call: string) => calls.filter((entry) => entry === call).length;
    return { driver, calls, count };
  }

  it('lets two concurrent creates of one session share one sandbox and delete nothing', async () => {
    const { driver, calls, count } = fakeProvider(undefined, { race: true });
    const [first, second] = await Promise.all([
      driver.create(config, TOKEN),
      driver.create(config, TOKEN),
    ]);

    expect(first.externalId).toBe(NAME);
    expect(second.externalId).toBe(NAME);
    expect(second.expiresAt?.getTime()).toBe(EXPIRES);
    expect(count('POST /v4/sandboxes')).toBe(2);
    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
    expect(calls.filter((call) => call.endsWith('/cmd'))).toHaveLength(1);
  });

  it('reuses a usable sandbox without creating or deleting', async () => {
    const { driver, calls } = fakeProvider('running');
    const handle = await driver.create(config, TOKEN);
    expect(handle.externalId).toBe(NAME);
    expect(handle.expiresAt?.getTime()).toBe(EXPIRES);
    expect(calls.every((call) => call.startsWith('GET'))).toBe(true);
  });

  it('deletes a sandbox only once the provider confirms it stopped, then creates', async () => {
    const { driver, calls } = fakeProvider('stopped');
    await driver.create(config, TOKEN);
    expect(calls.slice(0, 3)).toEqual([
      `GET /v2/sandboxes/${NAME}`,
      `DELETE /v2/sandboxes/${NAME}`,
      'POST /v4/sandboxes',
    ]);
  });

  it('gives up on a sandbox that never becomes usable, without deleting or creating', async () => {
    const { driver, calls } = fakeProvider('stopping');
    await expect(driver.create(config, TOKEN)).rejects.toThrow(/create failed/u);
    expect(calls.every((call) => call.startsWith('GET'))).toBe(true);
  });

  it('pauses after each lost race and gives up when the rival never becomes readable', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fakeFetch((call) => ({ status: call.method === 'POST' ? 409 : 404 }));
    const driver = driverOf(
      createVercelSandboxProvider({
        teamId: 'team_1',
        projectId: 'prj_1',
        fetch,
        tier: 'pro',
        retryDelayMs: 1_000,
      }),
    );
    const creates = () => calls.filter((call) => call.method === 'POST').length;
    const result = driver.create(config, TOKEN).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(creates()).toBe(1);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/create failed/u);
    expect(creates()).toBe(30);
  });

  it('deletes the sandbox of its own create when the runner fails to start', async () => {
    const { driver, count } = fakeProvider(undefined, { failStart: true });
    await expect(driver.create(config, TOKEN)).rejects.toThrow(/start the runner failed/u);
    expect(count(`DELETE /v2/sandboxes/${NAME}`)).toBe(1);
  });
});

describe('a stateless e2b provider', () => {
  it('records the lookup key as metadata and finds it by list then connect, keeping the deadline', async () => {
    const endAt = new Date(Date.now() + 600_000).toISOString();
    const api = fakeFetch((call) => {
      if (call.method === 'POST' && call.url.endsWith('/v2/sandboxes')) {
        return {
          status: 201,
          body: {
            sandboxID: 'sbx1',
            domain: 'e2b.example.dev',
            trafficAccessToken: 'traffic',
            envdAccessToken: 'envd-token',
          },
        };
      }
      if (call.url.includes('/v2/sandboxes?')) {
        return { status: 200, body: [{ sandboxID: 'sbx1', endAt, state: 'running' }] };
      }
      return {
        status: 200,
        body: { sandboxID: 'sbx1', domain: 'e2b.example.dev', trafficAccessToken: 'traffic' },
      };
    });
    const { calls } = api;
    // envd's process API answers a Connect stream whose first frame is the `start` event.
    const started = new TextEncoder().encode('{"event":{"start":{"pid":1}}}');
    const frame = new Uint8Array(5 + started.length);
    new DataView(frame.buffer).setUint32(1, started.length);
    frame.set(started, 5);
    const fetch: typeof globalThis.fetch = (input, init) =>
      (input instanceof Request ? input.url : String(input)).includes('/process.Process/Start')
        ? Promise.resolve(new Response(frame))
        : api.fetch(input, init);
    const provider = createE2bProvider({ fetch });
    const driver = createExternalDriver<never, never>({
      provider,
      images: new Map([['claude-agent-sdk', 'agent-runtime:0b6f2f0e-5a52-4f6c-9d57-2c1f8d3a7e11']]),
      gatewayUrl: 'https://gateway.example.com/v1',
      startAgent: () => {
        throw new Error('not used');
      },
      sealSecret: SECRET,
    });
    const external = { ...config, runSpec: { ...runSpec, driver: 'external' as const } };
    const lookupKey = createSealer(SECRET, 'external').lookupKey('profile-1:session-1');

    const created = await driver.create(external, 'e2b-key');
    expect(
      (calls[0]?.body as { metadata: Record<string, string> }).metadata['awKey'],
    ).toBeDefined();
    expect(created.id).toMatch(/^s/u);

    calls.length = 0;
    const found = await driver.find?.(external, 'e2b-key');
    expect(found).toMatchObject({ externalId: 'sbx1' });
    expect(calls[0]?.url).toBe(
      `https://api.e2b.app/v2/sandboxes?metadata=awKey%3D${lookupKey}&state=running&limit=2`,
    );
    expect(calls[1]?.url).toBe('https://api.e2b.app/sandboxes/sbx1/connect');
    const { timeout } = calls[1]?.body as { timeout: number };
    expect(timeout).toBeGreaterThan(590);
    expect(timeout).toBeLessThanOrEqual(600);
    expect(await driver.authHeaders(must(found))).toMatchObject({
      'e2b-traffic-access-token': 'traffic',
    });
  });
});
