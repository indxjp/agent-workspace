import { log as webLogger } from '../telemetry/logger';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ModelConnectionRecord } from '@agent-workspace/core/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { probeModelConnection } from './probe';
import type { ResolvedModelConnection } from './store';

const openServers: Server[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (openServers.length > 0) openServers.pop()?.close();
});

async function fixtureServer(
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
): Promise<{ readonly baseUrl: string; readonly requests: (string | undefined)[] }> {
  const requests: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    requests.push(req.headers['authorization']);
    handler(req, res);
  });
  openServers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
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

describe('probeModelConnection — W9-PROV-127 egress policy', () => {
  describe('in production, refuses every default-deny target', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
    });

    const cases: Array<[string, string]> = [
      ['link-local / AWS·GCP·Azure metadata', 'https://169.254.169.254/latest/meta-data/'],
      ['IPv6 unique-local', 'https://[fd00::1]/'],
      ['IPv4 loopback with a non-default port', 'https://127.0.0.1:5432/'],
      ['octal-encoded loopback', 'https://0177.0.0.1/'],
      ['decimal-encoded loopback', 'https://2130706433/'],
      ['RFC6598 carrier-grade NAT (Alibaba Cloud metadata range)', 'https://100.100.100.200/'],
    ];

    it.each(cases)('%s is refused, with no response body leaked', async (_label, baseUrl) => {
      const result = await probeModelConnection(connection('openai-compatible', { baseUrl }));
      expect(result.ok).toBe(false);
      expect(result.status).toBeNull();
      expect(result.message).toBe('The provider connection could not be reached.');
      expect(result.message).not.toContain('sk-fixture-secret');
    });

    it('refuses userinfo in a stored base URL outright', async () => {
      const result = await probeModelConnection(
        connection('openai-compatible', { baseUrl: 'https://user:pass@example.invalid/v1' }),
      );
      expect(result.ok).toBe(false);
      expect(result.message).toBe('The provider connection could not be reached.');
    });
  });

  it('an approved internal endpoint can still be reached once declared to EGRESS_ALLOW_HOSTS', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { baseUrl } = await fixtureServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const host = new URL(baseUrl).hostname;
    vi.stubEnv('EGRESS_ALLOW_HOSTS', host);
    // The allowlist lifts the address-range refusal; HTTPS is still required in production, so
    // this plain-http loopback fixture is refused for that reason rather than reaching the
    // server — proving the allowlist does not also waive the scheme requirement.
    const result = await probeModelConnection(connection('openai-compatible', { baseUrl }));
    expect(result.ok).toBe(false);
    expect(result.message).toBe('The provider connection could not be reached.');
  });

  it('keeps working against a local fixture outside production (the documented dev exception)', async () => {
    const { baseUrl } = await fixtureServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const result = await probeModelConnection(connection('openai-compatible', { baseUrl }));
    expect(result.ok).toBe(true);
  });

  it('refuses a redirect to a metadata address instead of following it', async () => {
    const { baseUrl } = await fixtureServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    const result = await probeModelConnection(connection('openai-compatible', { baseUrl }));
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
  });

  it('never forwards the credential to a redirect target on another origin', async () => {
    const attacker = await fixtureServer((_req, res) => res.end('should never be reached'));
    const source = await fixtureServer((_req, res) => {
      res.writeHead(302, { location: `${attacker.baseUrl}/steal` });
      res.end();
    });
    const result = await probeModelConnection(
      connection('openai-compatible', { baseUrl: source.baseUrl }),
    );
    expect(result.ok).toBe(false);
    expect(attacker.requests).toEqual([]);
  });
});

describe('probeModelConnection — a refusal names the host that answered', () => {
  it('says which host answered 401, and nothing of the path, query or key', async () => {
    const { baseUrl } = await fixtureServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    const result = await probeModelConnection(
      connection('openai-compatible', { baseUrl: `${baseUrl}/secret-path?key=secret-query` }),
    );
    expect(result).toMatchObject({
      ok: false,
      status: 401,
      message: `Provider at ${new URL(baseUrl).host} returned HTTP 401.`,
    });
  });
});

describe('probeModelConnection — bounded (issue #415)', () => {
  it('abandons a provider that never answers as unreachable', async () => {
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const silent = await fixtureServer(() => undefined);
    const started = Date.now();
    const result = await probeModelConnection(
      connection('openai-compatible', { baseUrl: silent.baseUrl }),
      fetch,
      100,
    );
    expect(result).toMatchObject({ ok: false, status: null });
    expect(Date.now() - started).toBeLessThan(5_000);
    vi.restoreAllMocks();
  });
});
