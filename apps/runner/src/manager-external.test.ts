import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createE2bProvider, createExternalDriver } from '@agent-workspace/runtime/driver/external';

import { createRunnerManagerServer } from './manager.js';

const TOKEN = 'runner-manager-fixture-token-more-than-32-characters';
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

type ApiCall = {
  method: string;
  url: string;
  key: string | undefined;
  body: string;
};

const ENVD_TOKEN = 'envd-access-token';

/** A Connect envelope carrying envd's `start` event. */
function startFrame(): Buffer {
  const payload = Buffer.from('{"event":{"start":{"pid":1}}}');
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

async function fixture(options: { createStatus?: number } = {}) {
  const apiCalls: ApiCall[] = [];
  const sandboxCalls: { path: string; authorization?: string; traffic?: string }[] = [];
  let bearer = '';
  const api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const key =
        typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined;
      apiCalls.push({
        method: req.method ?? '',
        url: req.url ?? '',
        key,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const status = req.method === 'POST' ? (options.createStatus ?? 201) : 204;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        status === 201
          ? JSON.stringify({
              sandboxID: 'sbx123',
              domain: 'e2b.example.dev',
              trafficAccessToken: 'traffic-token',
              envdAccessToken: ENVD_TOKEN,
            })
          : JSON.stringify({ message: `rejected ${String(key)}` }),
      );
    });
  });
  const sandbox = createServer((req, res) => {
    const authorization = req.headers.authorization;
    const traffic = req.headers['e2b-traffic-access-token'];
    sandboxCalls.push({
      path: req.url ?? '',
      ...(authorization === undefined ? {} : { authorization }),
      ...(typeof traffic === 'string' ? { traffic } : {}),
    });
    if (authorization !== `Bearer ${bearer}` || traffic !== 'traffic-token') {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // The runtime image's `/verify/echo` hands the manager's nonce back.
      res.end(
        JSON.stringify(
          req.url === '/verify/echo'
            ? {
                nonce: (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { nonce: string })
                  .nonce,
              }
            : { status: 'ok' },
        ),
      );
    });
  });
  // envd starts the runner and is the only place the bearer is sent to.
  const envd = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.headers['x-access-token'] !== ENVD_TOKEN) {
        res.writeHead(401).end();
        return;
      }
      const frame = JSON.parse(Buffer.concat(chunks).subarray(5).toString('utf8')) as {
        process: { envs: Record<string, string> };
      };
      bearer = frame.process.envs['RUNTIME_SANDBOX_BEARER'] ?? bearer;
      res.writeHead(200, { 'content-type': 'application/connect+json' });
      res.end(startFrame());
    });
  });
  const apiPort = await listen(api);
  const sandboxPort = await listen(sandbox);
  const envdPort = await listen(envd);
  const toEnvd: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname.startsWith('49983-')
      ? fetch(`http://127.0.0.1:${String(envdPort)}${url.pathname}`, init)
      : fetch(input, init);
  };

  const driver = createExternalDriver<never, never>({
    provider: createE2bProvider({
      apiBase: `http://127.0.0.1:${String(apiPort)}`,
      fetch: toEnvd,
    }),
    images: new Map([['claude-agent-sdk', `agent-runtime:${BUILD_ID}`]]),
    gatewayUrl: 'https://gateway.example.com',
    startAgent: () => {
      throw new Error('not used');
    },
  });
  // The sandbox origin is https at E2B's edge; here it is answered by a local fake.
  const toLocal: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe('https://8080-sbx123.e2b.example.dev');
    return fetch(`http://127.0.0.1:${String(sandboxPort)}${url.pathname}${url.search}`, init);
  };
  const manager = createRunnerManagerServer({
    token: TOKEN,
    workspacesRoot: '/srv/runtimes',
    driver,
    expectedDriver: 'external',
    runtimeRequestUrl: (handle, path) => driver.requestUrl(handle, path),
    runtimeAuthHeaders: (handle) => driver.authHeaders(handle),
    toolSandboxRefusal: 'a tool sandbox is not started on the external runtime (ADR-0120 LC5)',
    fetch: toLocal,
  });
  const base = `http://127.0.0.1:${String(await listen(manager))}`;
  const post = (body: unknown, credential: string | null = KEY) =>
    fetch(`${base}/runtimes`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        ...(credential === null ? {} : { 'x-provider-credential': credential }),
      },
      body: JSON.stringify(body),
    });
  const verify = (body: unknown, credential: string | null = KEY) =>
    fetch(`${base}/verify`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        ...(credential === null ? {} : { 'x-provider-credential': credential }),
      },
      body: JSON.stringify(body),
    });
  return { base, apiCalls, sandboxCalls, post, verify, bearer: () => bearer };
}

const allocation = (
  runSpec: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  workspaceId: 'workspace-one',
  sessionId: 'session-one',
  engine: 'claude-agent-sdk',
  runSpec: {
    runtimeProfileId: 'profile-one',
    driver: 'external',
    networkPolicy: 'none',
    filesystem: 'read-write',
    ...runSpec,
  },
  ...extra,
});

/**
 * The body `createRuntimeManagerClient(...).verify` sends for `external`
 * (apps/web/server/compose/runtime-manager-client.ts), which is what setup's runtime test posts.
 */
const setupVerification = (engine = 'claude-agent-sdk') => ({
  workspaceId: 'runtime-verification',
  sessionId: '5d3c1f0e-0f6e-4a43-9a3e-6d6e0f1f2a10',
  engine,
  runSpec: {
    runtimeProfileId: 'external-verification',
    driver: 'external',
    networkPolicy: 'none',
    filesystem: 'read-write',
    timeoutSeconds: 30,
  },
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe('runner manager serving the external driver (ADR-0120)', () => {
  it('LC1/LC3/LC6: allocates at E2B, probes and proxies with the bearer, and never returns a secret', async () => {
    const f = await fixture();
    const response = await f.post(allocation());
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(f.bearer());
    const { runnerUrl } = JSON.parse(text) as { runnerUrl: string };

    expect(f.apiCalls[0]).toMatchObject({ method: 'POST', url: '/v2/sandboxes', key: KEY });
    expect(f.sandboxCalls[0]).toEqual({
      path: '/healthz',
      authorization: `Bearer ${f.bearer()}`,
      traffic: 'traffic-token',
    });

    const proxied = await fetch(`${runnerUrl}/files?path=x`, { headers: auth });
    expect(proxied.status).toBe(200);
    expect(f.sandboxCalls.at(-1)).toMatchObject({
      path: '/files?path=x',
      authorization: `Bearer ${f.bearer()}`,
    });
  });

  it('tags the runtime sandbox with its workspace, so a lane can find and kill only its own', async () => {
    const f = await fixture();
    expect((await f.post(allocation())).status).toBe(201);
    const created = JSON.parse(f.apiCalls[0]?.body ?? '{}') as {
      metadata?: Record<string, string>;
    };
    expect(created.metadata).toMatchObject({ awWorkspace: 'workspace-one' });
    expect(JSON.stringify(created.metadata)).not.toContain(KEY);
  });

  it("verifies setup's real request against E2B: create, readiness, echo, destroy", async () => {
    const f = await fixture();
    const response = await f.verify(setupVerification());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(KEY);
    const verification = JSON.parse(text) as Record<string, string>;
    expect(Object.keys(verification).sort()).toEqual(['expiresAt', 'fingerprint', 'verifiedAt']);
    expect(verification['fingerprint']).toMatch(/^[0-9a-f]{64}$/u);
    // The manager answers before its `finally` destroys the sandbox.
    await vi.waitFor(() => {
      expect(f.apiCalls.map((call) => `${call.method} ${call.url} ${String(call.key)}`)).toEqual([
        `POST /v2/sandboxes ${KEY}`,
        `DELETE /sandboxes/sbx123 ${KEY}`,
      ]);
    });
    expect(f.sandboxCalls.map((call) => call.path)).toContain('/verify/echo');
  });

  it('answers 400 invalid_engine for an empty engine, before any provider call', async () => {
    const f = await fixture();
    const response = await f.verify(setupVerification(''));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_engine',
      message: 'engine must be a safe path segment',
    });
    expect(f.apiCalls).toHaveLength(0);
  });

  it('LC4: refuses restricted with 422 and a stable code, before any provider call', async () => {
    const f = await fixture();
    const response = await f.post(
      allocation({ networkPolicy: 'restricted', allowedDomains: ['example.com'] }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('network_policy_unsupported');
    expect(body.message).toContain('refuses the restricted network policy');
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(f.apiCalls).toHaveLength(0);
  });

  it('LC6: a request with no provider credential is refused with 422 and reaches nothing', async () => {
    const f = await fixture();
    const response = await f.post(allocation(), null);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe(
      'provider_credential_required',
    );
    expect(f.apiCalls).toHaveLength(0);
  });

  it('re-allocating an expired session refuses restricted or a missing credential before destroying the old sandbox', async () => {
    const f = await fixture();
    expect((await f.post(allocation({ timeoutSeconds: 1 }))).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const restricted = await f.post(allocation({ networkPolicy: 'restricted' }));
    expect(restricted.status).toBe(422);
    expect(((await restricted.json()) as { error: string }).error).toBe(
      'network_policy_unsupported',
    );
    const missing = await f.post(allocation(), null);
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as { error: string }).error).toBe(
      'provider_credential_required',
    );
    expect(f.apiCalls.map((call) => call.method)).toEqual(['POST']);

    // The old allocation is still tracked, so a valid request replaces it.
    expect((await f.post(allocation())).status).toBe(201);
    expect(f.apiCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /v2/sandboxes',
      'DELETE /sandboxes/sbx123',
      'POST /v2/sandboxes',
    ]);
  });

  it('LC5: a tool sandbox is refused by name before anything is created', async () => {
    const f = await fixture();
    const response = await f.post(
      allocation(
        {},
        {
          toolSandbox: {
            key: 'tools-1',
            manifest: {
              tools: [
                {
                  name: 'get_order',
                  description: 'Looks up an order.',
                  inputSchema: { type: 'object' },
                  timeoutMs: 5_000,
                  digest: 'a'.repeat(64),
                  bundleBase64: Buffer.from('x').toString('base64'),
                },
              ],
              env: {},
            },
            allowedDomains: ['api.example.com'],
            run: { runId: 'run_1', token: 't'.repeat(32) },
          },
        },
      ),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('tool_sandbox_unavailable');
    expect(body.message).toContain('LC5');
    expect(f.apiCalls).toHaveLength(0);
  });

  it('refuses a run spec that selects another driver', async () => {
    const f = await fixture();
    expect((await f.post(allocation({ driver: 'docker' }))).status).toBe(400);
    expect(f.apiCalls).toHaveLength(0);
  });

  it('LC6: deleting needs the credential, and without it the runtime stays addressable', async () => {
    const f = await fixture();
    const { runnerUrl } = (await (await f.post(allocation())).json()) as { runnerUrl: string };

    const denied = await fetch(runnerUrl, { method: 'DELETE', headers: auth });
    expect(denied.status).toBe(422);
    expect(((await denied.json()) as { error: string }).error).toBe('provider_credential_required');
    expect((await fetch(runnerUrl, { headers: auth })).status).toBe(200);

    const removed = await fetch(runnerUrl, {
      method: 'DELETE',
      headers: { ...auth, 'x-provider-credential': KEY },
    });
    expect(removed.status).toBe(204);
    expect(f.apiCalls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: '/sandboxes/sbx123',
      key: KEY,
    });
    expect((await fetch(runnerUrl, { headers: auth })).status).toBe(404);
  });

  it('LC6: a provider failure that echoes the key is a bare 500, and the key reaches no log', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const f = await fixture({ createStatus: 401 });
    const response = await f.post(allocation());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
    expect(write.mock.calls.map((call) => String(call[0])).join('')).not.toContain(KEY);
  });
});
