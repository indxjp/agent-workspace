import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCloudflareSandboxProvider, createExternalDriver } from '@agent-workspace/runtime';

import { createRunnerManagerServer, createShutdownGate } from './manager.js';

const TOKEN = 'runner-manager-fixture-token-more-than-32-characters';
const SECRET = 'bridge_SENTINEL_secret_0123456789';
const ACCESS = 'access-token-0123456789abcdef';
const SANDBOX_ID = 'n-0123456789abcdef0123456789abcdef';

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

type BridgeCall = { method: string; url: string; authorization?: string; access?: string };

async function fixture(declaringNone = false) {
  const calls: BridgeCall[] = [];
  let bearer = '';
  const bridge = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const access = req.headers['x-bridge-access'];
      calls.push({
        method: req.method ?? '',
        url: req.url ?? '',
        ...(req.headers.authorization === undefined
          ? {}
          : { authorization: req.headers.authorization }),
        ...(typeof access === 'string' ? { access } : {}),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'POST') {
        bearer = (JSON.parse(raw) as { bearer: string }).bearer;
        res.end(JSON.stringify({ sandboxId: SANDBOX_ID, accessToken: ACCESS }));
        return;
      }
      res.end(JSON.stringify({ status: 'ok' }));
    });
  });
  const bridgePort = await listen(bridge);
  const bridgeUrl = `http://127.0.0.1:${String(bridgePort)}`;
  const shipped = createCloudflareSandboxProvider({ bridgeUrl });
  const driver = createExternalDriver<never, never>({
    driverId: 'cloudflare-sandbox',
    // The shipped provider declares no network policy (ADR-0131); `declaringNone` exercises the
    // bridge protocol, the shipped one the refusal.
    provider: declaringNone
      ? { ...shipped, capabilities: { ...shipped.capabilities, networkPolicies: ['none'] } }
      : shipped,
    images: new Map([['claude-agent-sdk', 'registry.example.com/agent-runtime@sha256:abc']]),
    gatewayUrl: 'https://gateway.example.com',
    startAgent: () => {
      throw new Error('not used');
    },
  });
  const manager = createRunnerManagerServer({
    token: TOKEN,
    workspacesRoot: '/srv/runtimes',
    // Through the shutdown gate, as `startRunnerManager` serves it.
    driver: createShutdownGate(driver).driver,
    expectedDriver: 'cloudflare-sandbox',
    runtimeRequestUrl: (handle, path) => driver.requestUrl(handle, path),
    runtimeAuthHeaders: (handle) => driver.authHeaders(handle),
    toolSandboxRefusal: 'a tool sandbox is not started on the cloudflare-sandbox runtime yet',
  });
  const base = `http://127.0.0.1:${String(await listen(manager))}`;
  const post = (body: unknown, credential: string | null = SECRET) =>
    fetch(`${base}/runtimes`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        ...(credential === null ? {} : { 'x-provider-credential': credential }),
      },
      body: JSON.stringify(body),
    });
  const verify = (body: unknown) =>
    fetch(`${base}/verify`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-provider-credential': SECRET,
      },
      body: JSON.stringify(body),
    });
  return { calls, post, verify, bearer: () => bearer };
}

const allocation = (runSpec: Record<string, unknown> = {}) => ({
  workspaceId: 'workspace-one',
  sessionId: 'session-one',
  engine: 'claude-agent-sdk',
  runSpec: {
    runtimeProfileId: 'profile-one',
    driver: 'cloudflare-sandbox',
    networkPolicy: 'none',
    filesystem: 'read-write',
    ...runSpec,
  },
});

describe('runner manager serving the cloudflare-sandbox driver (ADR-0120)', () => {
  it('LC1/LC3/LC6: allocates through the bridge, forwards with bearer and access token, never returns the secret', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const f = await fixture(true);
    const response = await f.post(allocation());
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(f.bearer());
    const { runnerUrl } = JSON.parse(text) as { runnerUrl: string };

    expect(f.calls[0]).toMatchObject({
      method: 'POST',
      url: '/v1/sandboxes',
      authorization: `Bearer ${SECRET}`,
    });
    expect(f.calls[1]).toEqual({
      method: 'GET',
      url: `/v1/sandboxes/${SANDBOX_ID}/runtime/healthz`,
      authorization: `Bearer ${f.bearer()}`,
      access: ACCESS,
    });

    const proxied = await fetch(`${runnerUrl}/files?path=x`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(proxied.status).toBe(200);
    expect(await proxied.text()).not.toContain(SECRET);
    expect(f.calls.at(-1)).toEqual({
      method: 'GET',
      url: `/v1/sandboxes/${SANDBOX_ID}/runtime/files?path=x`,
      authorization: `Bearer ${f.bearer()}`,
      access: ACCESS,
    });
    expect(write.mock.calls.map((call) => String(call[0])).join('')).not.toContain(SECRET);
  });

  it('LC4: refuses restricted with 422 and the stable code, before the bridge is called', async () => {
    const f = await fixture();
    const response = await f.post(
      allocation({ networkPolicy: 'restricted', allowedDomains: ['example.com'] }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('network_policy_unsupported');
    expect(body.message).toContain('provider cloudflare-sandbox refuses the restricted');
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(f.calls).toHaveLength(0);
  });

  it('ADR-0131: refuses none with 422 and the stable code, before the bridge is called', async () => {
    const f = await fixture();
    const response = await f.post(allocation());
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('network_policy_unsupported');
    expect(body.message).toContain('provider cloudflare-sandbox refuses the none');
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(f.calls).toHaveLength(0);
  });

  it('ADR-0131: verify refuses with 422 network_policy_unsupported before validating the body or calling the bridge', async () => {
    const f = await fixture();
    // Setup's probe body; an empty engine (no installed engine on the control plane) used to be
    // refused by body validation with a bare 400 before the driver could refuse the policy.
    for (const engine of ['', 'claude-agent-sdk']) {
      const response = await f.verify({
        ...allocation({ runtimeProfileId: 'cloudflare-sandbox-verification', timeoutSeconds: 30 }),
        workspaceId: 'runtime-verification',
        engine,
      });
      expect(response.status).toBe(422);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe('network_policy_unsupported');
      expect(body.message).toContain('cloudflare-sandbox runtime refuses every network policy');
      expect(JSON.stringify(body)).not.toContain(SECRET);
    }
    expect(f.calls).toHaveLength(0);
  });

  it('LC6: no provider credential is refused with 422 and reaches nothing', async () => {
    const f = await fixture(true);
    const response = await f.post(allocation(), null);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe(
      'provider_credential_required',
    );
    expect(f.calls).toHaveLength(0);
  });
});
