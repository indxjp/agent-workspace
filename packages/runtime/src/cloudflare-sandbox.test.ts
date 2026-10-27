import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CLOUDFLARE_SANDBOX_RESTRICTED_REFUSAL,
  cloudflareSandboxRuntimeCapabilities,
  createCloudflareSandboxDriver,
  createCloudflareSandboxProvider,
} from './cloudflare-sandbox.js';
import type { RuntimeRunSpec } from './driver.js';
import { createExternalDriver } from './external/driver.js';
import { RuntimeRefusalError } from './external/errors.js';

const SECRET = 'bridge_SENTINEL_secret_0123456789';
const IMAGES = new Map([['claude-agent-sdk', 'registry.example.com/agent-runtime@sha256:abc']]);
const ACCESS = 'access-token-0123456789abcdef';

type Recorded = {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
};

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function fakeBridge(
  respond: (call: Recorded) => { status: number; body: unknown } = (call) =>
    call.method === 'POST'
      ? { status: 201, body: { sandboxId: 'n-abc123', accessToken: ACCESS } }
      : { status: 200, body: { ok: true } },
): Promise<{ bridgeUrl: string; calls: Recorded[] }> {
  const calls: Recorded[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const call: Recorded = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body: raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined,
      };
      calls.push(call);
      const answer = respond(call);
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { bridgeUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, calls };
}

function driverFor(bridgeUrl: string) {
  return createCloudflareSandboxDriver<string, string>({
    bridgeUrl,
    images: IMAGES,
    gatewayUrl: 'https://gateway.example.com/v1',
    startAgent: () => {
      throw new Error('not used');
    },
  });
}

// The bridge protocol is exercised through a provider that declares `none`; the shipped provider
// declares no policy (ADR-0131), which the refusal tests below use through `driverFor`.
function protocolDriverFor(bridgeUrl: string) {
  const provider = createCloudflareSandboxProvider({ bridgeUrl });
  return createExternalDriver<string, string>({
    driverId: 'cloudflare-sandbox',
    provider: {
      ...provider,
      capabilities: { ...provider.capabilities, networkPolicies: ['none'] },
    },
    images: IMAGES,
    gatewayUrl: 'https://gateway.example.com/v1',
    startAgent: () => {
      throw new Error('not used');
    },
  });
}

function spec(over: Partial<RuntimeRunSpec> = {}): RuntimeRunSpec {
  return {
    runtimeProfileId: 'profile-1',
    driver: 'cloudflare-sandbox',
    networkPolicy: 'none',
    filesystem: 'read-write',
    ...over,
  };
}

const config = (runSpec?: RuntimeRunSpec) => ({
  engine: 'claude-agent-sdk',
  sessionId: 'session-1',
  workspacePath: '/ws/session-1',
  ...(runSpec === undefined ? {} : { runSpec }),
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to reject');
}

describe('cloudflare-sandbox driver (ADR-0120)', () => {
  it('declares the ADR-0120 capability table', () => {
    expect(cloudflareSandboxRuntimeCapabilities()).toEqual({
      isolation: 'microvm',
      customImage: true,
      persistentFilesystem: false,
      sessionAffinity: true,
      maxSessionSeconds: null,
      networkPolicies: [],
      execCommands: true,
      gpu: false,
      managedByProvider: true,
      typicalStartMs: null,
      fileTransfer: 'push-archive',
    });
    expect(driverFor('http://127.0.0.1:1').capabilities).toEqual(
      cloudflareSandboxRuntimeCapabilities(),
    );
  });

  it('LC1/LC3/LC6: create sends the secret once, the handle and live table never hold it', async () => {
    const { bridgeUrl, calls } = await fakeBridge();
    const driver = protocolDriverFor(bridgeUrl);
    const handle = await driver.create(config(spec()), SECRET);

    expect(handle.driver).toBe('cloudflare-sandbox');
    expect(handle.externalId).toBe('n-abc123');
    expect(JSON.stringify(handle)).not.toContain(SECRET);

    const [create] = calls;
    expect(create).toMatchObject({
      method: 'POST',
      url: '/v1/sandboxes',
      authorization: `Bearer ${SECRET}`,
    });
    const body = create?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      image: 'registry.example.com/agent-runtime@sha256:abc',
      sessionKey: 'session-1',
      networkPolicy: 'none',
      gatewayHost: 'gateway.example.com',
    });
    expect(JSON.stringify(body)).not.toContain(SECRET);

    expect(driver.requestUrl(handle, '/ping')).toBe(
      `${bridgeUrl}/v1/sandboxes/n-abc123/runtime/ping`,
    );
    const headers = await driver.authHeaders(handle);
    expect(headers).toEqual({
      authorization: `Bearer ${String(body['bearer'])}`,
      'x-bridge-access': ACCESS,
    });
    expect(JSON.stringify(headers)).not.toContain(SECRET);
    expect(await driver.isLive(handle)).toBe(true);
  });

  it('reaches readiness through the bridge route', async () => {
    const { bridgeUrl, calls } = await fakeBridge();
    const driver = protocolDriverFor(bridgeUrl);
    const handle = await driver.create(config(spec()), SECRET);
    const response = await fetch(driver.requestUrl(handle, '/ping'), {
      headers: await driver.authHeaders(handle),
    });
    expect(response.status).toBe(200);
    expect(calls.at(-1)?.url).toBe('/v1/sandboxes/n-abc123/runtime/ping');
  });

  it('destroys with the secret and tolerates a missing sandbox', async () => {
    const { bridgeUrl, calls } = await fakeBridge((call) =>
      call.method === 'POST'
        ? { status: 201, body: { sandboxId: 'n-abc123', accessToken: ACCESS } }
        : { status: 404, body: {} },
    );
    const driver = protocolDriverFor(bridgeUrl);
    const handle = await driver.create(config(spec()), SECRET);
    await driver.destroy(handle, SECRET);
    expect(calls[1]).toMatchObject({
      method: 'DELETE',
      url: '/v1/sandboxes/n-abc123',
      authorization: `Bearer ${SECRET}`,
    });
    expect(await driver.isLive(handle)).toBe(false);
  });

  it('ADR-0131: none, also by default, is refused by name before the bridge is called', async () => {
    const { bridgeUrl, calls } = await fakeBridge();
    const driver = driverFor(bridgeUrl);
    const expected =
      'external runtime: provider cloudflare-sandbox refuses the none network policy until its live lane proves the sandbox reaches only the gateway (ADR-0120 LC4, ADR-0131).';
    for (const runSpec of [spec({ networkPolicy: 'none' }), undefined]) {
      const refused = await rejection(driver.create(config(runSpec), SECRET));
      expect(refused).toBeInstanceOf(RuntimeRefusalError);
      expect(refused).toMatchObject({ code: 'network_policy_unsupported' });
      expect(refused.message).toBe(expected);
      expect(refused.message).not.toContain(SECRET);
      expect(() => {
        driver.assertCreatable(config(runSpec), SECRET);
      }).toThrow(expected);
    }
    expect(calls).toHaveLength(0);
  });

  it('LC4: with none declared, the bridge receives none and only the gateway host', async () => {
    const { bridgeUrl, calls } = await fakeBridge();
    const driver = protocolDriverFor(bridgeUrl);
    await driver.create(config(spec({ networkPolicy: 'none' })), SECRET);
    await driver.create(config(), SECRET);
    const sent = calls.map((call) => {
      const { networkPolicy, gatewayHost } = call.body as Record<string, unknown>;
      return { networkPolicy, gatewayHost };
    });
    expect(sent).toEqual([
      { networkPolicy: 'none', gatewayHost: 'gateway.example.com' },
      { networkPolicy: 'none', gatewayHost: 'gateway.example.com' },
    ]);
  });

  it('LC4: open and restricted are refused by name before the bridge is called', async () => {
    const { bridgeUrl, calls } = await fakeBridge();
    const driver = driverFor(bridgeUrl);
    const expected = {
      open: 'external runtime: provider cloudflare-sandbox refuses the open network policy until its live lane proves the always-denied ranges are enforced (ADR-0120 LC4).',
      restricted:
        'external runtime: provider cloudflare-sandbox refuses the restricted network policy until the E4 live lane proves Cloudflare enforces the always-denied ranges (ADR-0120 LC4).',
    } as const;
    expect(CLOUDFLARE_SANDBOX_RESTRICTED_REFUSAL).toBe(expected.restricted);
    for (const networkPolicy of ['open', 'restricted'] as const) {
      const refused = await rejection(driver.create(config(spec({ networkPolicy })), SECRET));
      expect(refused).toBeInstanceOf(RuntimeRefusalError);
      expect(refused).toMatchObject({ code: 'network_policy_unsupported' });
      expect(refused.message).toBe(expected[networkPolicy]);
      expect(() => {
        driver.assertCreatable(config(spec({ networkPolicy })), SECRET);
      }).toThrow(expected[networkPolicy]);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses allowedDomains, persistPaths and another driver id by name', async () => {
    const { bridgeUrl, calls } = await fakeBridge();
    const driver = protocolDriverFor(bridgeUrl);
    await expect(
      driver.create(config(spec({ allowedDomains: ['example.com'] })), SECRET),
    ).rejects.toMatchObject({ code: 'run_spec_unsupported' });
    await expect(
      driver.create(config(spec({ persistPaths: ['/data'] })), SECRET),
    ).rejects.toMatchObject({ code: 'run_spec_unsupported' });
    await expect(driver.create(config(spec({ driver: 'external' })), SECRET)).rejects.toThrow(
      /incompatible driver external/u,
    );
    expect(calls).toHaveLength(0);
  });

  it('LC6: a missing credential is refused, and a hostile bridge cannot put the secret in an error', async () => {
    const { bridgeUrl } = await fakeBridge();
    await expect(protocolDriverFor(bridgeUrl).create(config(spec()))).rejects.toMatchObject({
      code: 'provider_credential_required',
    });

    const echoing = await fakeBridge((call) => ({
      status: 500,
      body: { echoed: call.authorization, secret: SECRET },
    }));
    const failed = await rejection(
      protocolDriverFor(echoing.bridgeUrl).create(config(spec()), SECRET),
    );
    expect(failed.message).toBe(
      'external runtime: provider cloudflare-sandbox create failed with status 500.',
    );
    expect(`${failed.message}${failed.stack ?? ''}`).not.toContain(SECRET);

    const unreachable = await rejection(
      protocolDriverFor('http://127.0.0.1:1').create(config(spec()), SECRET),
    );
    expect(`${unreachable.message}${unreachable.stack ?? ''}`).not.toContain(SECRET);
  });

  it('destroys a sandbox the bridge answered without a usable access token', async () => {
    const { bridgeUrl, calls } = await fakeBridge((call) =>
      call.method === 'POST'
        ? { status: 201, body: { sandboxId: 'n-abc123', accessToken: 'short' } }
        : { status: 200, body: {} },
    );
    await expect(protocolDriverFor(bridgeUrl).create(config(spec()), SECRET)).rejects.toThrow(
      /create failed/u,
    );
    expect(calls.map((call) => call.method)).toEqual(['POST', 'DELETE']);
  });
});
