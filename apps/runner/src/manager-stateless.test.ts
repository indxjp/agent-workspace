import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createE2bProvider, createExternalDriver } from '@agent-workspace/runtime/driver/external';

import { createRunnerManagerFunction } from './manager-function.js';
import { createRunnerManagerServer } from './manager.js';
import { managerDriverOptions } from './manager-start.js';

const TOKEN = 'runner-manager-fixture-token-more-than-32-characters';
const OTHER_TOKEN = 'another-manager-fixture-token-more-than-32-characters';
const KEY = 'e2b_SENTINEL_provider_key_0123456789';
const BUILD_ID = '0b6f2f0e-5a52-4f6c-9d57-2c1f8d3a7e11';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  vi.restoreAllMocks();
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

type FakeSandbox = { id: string; metadata: Record<string, string>; endAt: number };

/** An E2B API that remembers its sandboxes, and one sandbox server that checks the bearer. */
async function provider() {
  const sandboxes = new Map<string, FakeSandbox>();
  const calls: string[] = [];
  const bearers: string[] = [];
  const bearerSeen: (string | undefined)[] = [];
  let counter = 0;
  const api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const url = new URL(req.url ?? '/', 'http://fake');
      calls.push(`${req.method ?? ''} ${url.pathname}`);
      const reply = (status: number, value?: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(value === undefined ? undefined : JSON.stringify(value));
      };
      const domain = {
        domain: 'e2b.example.dev',
        trafficAccessToken: 'traffic-token',
        envdAccessToken: 'envd-token',
      };
      if (req.method === 'POST' && url.pathname === '/v2/sandboxes') {
        counter += 1;
        const id = `sbx${String(counter)}`;
        sandboxes.set(id, {
          id,
          metadata: body['metadata'] as Record<string, string>,
          endAt: Date.now() + Number(body['timeout']) * 1000,
        });
        reply(201, { sandboxID: id, ...domain });
      } else if (req.method === 'GET' && url.pathname === '/v2/sandboxes') {
        const wanted = url.searchParams.get('metadata') ?? '';
        const [name = '', value = ''] = wanted.split('=');
        reply(
          200,
          [...sandboxes.values()]
            .filter((sandbox) => sandbox.metadata[name] === value)
            .map((sandbox) => ({
              sandboxID: sandbox.id,
              state: 'running',
              endAt: new Date(sandbox.endAt).toISOString(),
            })),
        );
      } else if (req.method === 'POST' && url.pathname.endsWith('/connect')) {
        reply(200, { sandboxID: url.pathname.split('/')[2], ...domain });
      } else if (req.method === 'DELETE') {
        sandboxes.delete(url.pathname.split('/')[2] ?? '');
        reply(204);
      } else {
        reply(404, { message: 'unexpected' });
      }
    });
  });
  const sandbox = createServer((req, res) => {
    bearerSeen.push(req.headers.authorization);
    const ok = bearers.some((bearer) => req.headers.authorization === `Bearer ${bearer}`);
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  // envd starts the runner: the bearer reaches the sandbox only in this call's process environment.
  const envd = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const frame = JSON.parse(Buffer.concat(chunks).subarray(5).toString('utf8')) as {
        process: { envs: Record<string, string> };
      };
      bearers.push(frame.process.envs['RUNTIME_SANDBOX_BEARER'] ?? '');
      const payload = Buffer.from('{"event":{"start":{"pid":1}}}');
      const header = Buffer.alloc(5);
      header.writeUInt32BE(payload.length, 1);
      res.writeHead(200, { 'content-type': 'application/connect+json' });
      res.end(Buffer.concat([header, payload]));
    });
  });
  const apiPort = await listen(api);
  const sandboxPort = await listen(sandbox);
  const envdPort = await listen(envd);
  return { apiPort, sandboxPort, envdPort, sandboxes, calls, bearers, bearerSeen };
}

type Provider = Awaited<ReturnType<typeof provider>>;

/** A manager instance with no table of its own: all it holds is the shared secret. */
async function instance(upstream: Provider, secret = TOKEN, token = TOKEN) {
  const driver = createExternalDriver<never, never>({
    provider: createE2bProvider({
      apiBase: `http://127.0.0.1:${String(upstream.apiPort)}`,
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return url.hostname.startsWith('49983-')
          ? fetch(`http://127.0.0.1:${String(upstream.envdPort)}${url.pathname}`, init)
          : fetch(input, init);
      },
    }),
    images: new Map([['claude-agent-sdk', `agent-runtime:${BUILD_ID}`]]),
    gatewayUrl: 'https://gateway.example.com',
    startAgent: () => {
      throw new Error('not used');
    },
    sealSecret: secret,
  });
  const server = createRunnerManagerServer({
    token,
    workspacesRoot: '/srv/runtimes',
    driver,
    expectedDriver: 'external',
    runtimeRequestUrl: (handle, path) => driver.requestUrl(handle, path),
    runtimeAuthHeaders: (handle) => driver.authHeaders(handle),
    toolSandboxRefusal: 'a tool sandbox is not started on the external runtime (ADR-0120 LC5)',
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return fetch(
        `http://127.0.0.1:${String(upstream.sandboxPort)}${url.pathname}${url.search}`,
        init,
      );
    },
  });
  const base = `http://127.0.0.1:${String(await listen(server))}`;
  const post = (body: unknown) =>
    fetch(`${base}/runtimes`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-provider-credential': KEY,
      },
      body: JSON.stringify(body),
    });
  return { base, post, token };
}

const allocation = (sessionId = 'session-one') => ({
  workspaceId: 'workspace-one',
  sessionId,
  engine: 'claude-agent-sdk',
  runSpec: {
    runtimeProfileId: 'profile-one',
    driver: 'external',
    networkPolicy: 'none',
    filesystem: 'read-write',
  },
});

describe('a stateless runner manager (ADR-0126)', () => {
  it('serves a runtime that another instance allocated, with nothing shared but the secret', async () => {
    const upstream = await provider();
    const first = await instance(upstream);
    const second = await instance(upstream);

    const created = await first.post(allocation());
    expect(created.status).toBe(201);
    const text = await created.text();
    const { runnerUrl } = JSON.parse(text) as { runnerUrl: string };
    for (const bearer of upstream.bearers) expect(text).not.toContain(bearer);
    expect(text).not.toContain(KEY);

    const id = runnerUrl.slice(runnerUrl.lastIndexOf('/') + 1);
    const served = await fetch(`${second.base}/runtimes/${id}/files?path=x`, {
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(served.status).toBe(200);
    expect(upstream.bearerSeen.at(-1)).toBe(`Bearer ${upstream.bearers[0] ?? ''}`);
  });

  it('answers a later allocation for the same session from the provider instead of creating again', async () => {
    const upstream = await provider();
    const first = await instance(upstream);
    const second = await instance(upstream);

    expect((await first.post(allocation())).status).toBe(201);
    const again = await second.post(allocation());

    expect(again.status).toBe(200);
    expect(upstream.calls.filter((call) => call === 'POST /v2/sandboxes')).toHaveLength(1);
    expect(upstream.sandboxes.size).toBe(1);
    expect(upstream.calls).toContain('GET /v2/sandboxes');
    expect(upstream.calls.some((call) => call.endsWith('/connect'))).toBe(true);
    // A different session is a different sandbox.
    expect((await second.post(allocation('session-two'))).status).toBe(201);
    expect(upstream.sandboxes.size).toBe(2);
  });

  it.each([
    [
      'a tampered id',
      (id: string) => `${id.slice(0, 12)}${id[12] === 'A' ? 'B' : 'A'}${id.slice(13)}`,
    ],
    ['an id the manager never sealed', () => 'sbx1'],
    ['a truncated id', (id: string) => id.slice(0, 20)],
  ])('answers 404 for %s', async (_name, change) => {
    const upstream = await provider();
    const manager = await instance(upstream);
    const { runnerUrl } = (await (await manager.post(allocation())).json()) as {
      runnerUrl: string;
    };
    const id = runnerUrl.slice(runnerUrl.lastIndexOf('/') + 1);

    const response = await fetch(`${manager.base}/runtimes/${change(id)}/files?path=x`, {
      headers: { authorization: `Bearer ${manager.token}` },
    });
    expect(response.status).toBe(404);
  });

  it('answers live:false, not 404, for an expired or an unknown handle, and keeps 404 for run', async () => {
    const upstream = await provider();
    const manager = await instance(upstream);
    const headers = { authorization: `Bearer ${manager.token}` };
    const { runnerUrl } = (await (await manager.post(allocation())).json()) as {
      runnerUrl: string;
    };
    const id = runnerUrl.slice(runnerUrl.lastIndexOf('/') + 1);

    const live = await fetch(`${manager.base}/runtimes/${id}`, { headers });
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ live: true });

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 48 * 3_600_000);
      const expired = await fetch(`${manager.base}/runtimes/${id}`, { headers });
      expect(expired.status).toBe(200);
      expect(await expired.json()).toEqual({ live: false });
    } finally {
      vi.useRealTimers();
    }

    const unknown = await fetch(`${manager.base}/runtimes/sbx1`, { headers });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ live: false });

    const run = await fetch(`${manager.base}/runtimes/sbx1/run`, { method: 'POST', headers });
    expect(run.status).toBe(404);
    const removed = await fetch(`${manager.base}/runtimes/sbx1`, { method: 'DELETE', headers });
    expect(removed.status).toBe(404);
  });

  it('answers 404 to an instance holding a different secret', async () => {
    const upstream = await provider();
    const first = await instance(upstream);
    const stranger = await instance(upstream, OTHER_TOKEN, OTHER_TOKEN);
    const { runnerUrl } = (await (await first.post(allocation())).json()) as { runnerUrl: string };
    const id = runnerUrl.slice(runnerUrl.lastIndexOf('/') + 1);

    const response = await fetch(`${stranger.base}/runtimes/${id}/files?path=x`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(response.status).toBe(404);
  });
});

describe('RUNNER_MANAGER_STATELESS composition (ADR-0126)', () => {
  const vercel = {
    RUNTIME_DRIVER: 'vercel-sandbox',
    VERCEL_TEAM_ID: 'team_abc123',
    VERCEL_PROJECT_ID: 'prj_abc123',
    GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
    AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: `registry.example.com/agent-runtime@sha256:${'a'.repeat(64)}`,
    RUNNER_MANAGER_TOKEN: TOKEN,
  };

  it('builds a stateless vercel-sandbox or external driver, and only those', () => {
    const options = managerDriverOptions({ ...vercel, RUNNER_MANAGER_STATELESS: 'true' });
    expect(typeof options.driver.recover).toBe('function');
    expect(typeof options.driver.find).toBe('function');
    expect(typeof managerDriverOptions(vercel).driver.recover).toBe('undefined');

    expect(() =>
      managerDriverOptions({ RUNTIME_DRIVER: 'docker', RUNNER_MANAGER_STATELESS: 'true' }),
    ).toThrow(/external and vercel-sandbox drivers only/u);
    expect(() => managerDriverOptions({ ...vercel, RUNNER_MANAGER_STATELESS: 'yes' })).toThrow(
      /must be true/u,
    );
    expect(() =>
      managerDriverOptions({
        ...vercel,
        RUNNER_MANAGER_STATELESS: 'true',
        RUNNER_MANAGER_TOKEN: 'short',
      }),
    ).toThrow(/at least 32 characters/u);
  });

  it('the Vercel Function answers 500 without the cause when its configuration is wrong, then recovers', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const env: Record<string, string | undefined> = { ...vercel, VERCEL_TEAM_ID: undefined };
    const handler = createRunnerManagerFunction(env);
    const serve = createServer((req, res) => {
      handler(req, res);
    });
    const base = `http://127.0.0.1:${String(await listen(serve))}`;

    const failed = await fetch(`${base}/healthz`);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'runner_manager_unavailable' });
    expect(write.mock.calls.map((call) => String(call[0])).join('')).toContain('VERCEL_TEAM_ID');

    env['VERCEL_TEAM_ID'] = 'team_abc123';
    const healthy = await fetch(`${base}/healthz`);
    expect(healthy.status).toBe(200);
    // Never a table: the function forces the stateless mode on whatever the environment says.
    expect(
      (
        await fetch(`${base}/runtimes/unknown/files?path=x`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(404);
  });
});
