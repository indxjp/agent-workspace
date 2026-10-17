import { describe, expect, it } from 'vitest';

import { createExternalDriver } from './driver.js';
import { createE2bProvider } from './e2b.js';

const KEY = 'e2b_SENTINEL_provider_key_0123456789';
const ENVD_TOKEN = 'envd-SENTINEL-access-token-0123456789';
const TRAFFIC_TOKEN = 'traffic-SENTINEL-token-0123456789';
const SEAL_SECRET = 'seal-secret-0123456789-0123456789-0123456789';
const IMAGES = new Map([['tool-host', 'aw-tool-host:0b6f2f0e-5a52-4f6c-9d57-2c1f8d3a7e11']]);
const SANDBOX = {
  sandboxID: 'sbxtool',
  domain: 'e2b.example.dev',
  trafficAccessToken: TRAFFIC_TOKEN,
  envdAccessToken: ENVD_TOKEN,
};

type Seen = { method: string; url: URL; headers: Headers; body: Uint8Array };

function envelope(message: unknown): Uint8Array {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** A stand-in for E2B's API and envd: answers by path, records every request. */
function fakeE2b(envdFiles: () => Response = () => Response.json([{ name: 'ok' }])) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input instanceof Request ? input.url : String(input), init);
    const body = new Uint8Array(await request.arrayBuffer());
    const url = new URL(request.url);
    seen.push({ method: request.method, url, headers: request.headers, body });
    if (url.pathname === '/process.Process/Start') {
      return new Response(envelope({ event: { start: { pid: 7 } } }));
    }
    if (url.pathname === '/files') return envdFiles();
    if (url.pathname === '/v2/sandboxes' && request.method === 'POST') {
      return Response.json(SANDBOX, { status: 201 });
    }
    if (url.pathname === '/v2/sandboxes') {
      return Response.json([
        { sandboxID: SANDBOX.sandboxID, endAt: new Date(Date.now() + 600_000).toISOString() },
      ]);
    }
    if (url.pathname.endsWith('/connect')) return Response.json(SANDBOX);
    return new Response(null, { status: 204 });
  };
  return { seen, fetch };
}

function driverFor(fake: ReturnType<typeof fakeE2b>, sealSecret?: string) {
  return createExternalDriver<string, string>({
    provider: createE2bProvider({ fetch: fake.fetch, apiBase: 'https://api.e2b.test' }),
    images: IMAGES,
    gatewayUrl: 'https://gateway.example.dev',
    startAgent: () => {
      throw new Error('unused');
    },
    workload: 'tool-host',
    ...(sealSecret === undefined ? {} : { sealSecret }),
  });
}

const CONFIG = {
  sessionId: 'session-1',
  engine: 'tool-host',
  workspacePath: '/workspaces/w/session-1',
  runSpec: {
    runtimeProfileId: 'tool-sandbox',
    driver: 'external' as const,
    networkPolicy: 'none' as const,
    filesystem: 'read-write' as const,
  },
};

describe('the e2b tool host (ADR-0118, ADR-0120 LC5)', () => {
  it('starts the tool host, not the runner, with no sandbox bearer in its environment', async () => {
    const fake = fakeE2b();
    await driverFor(fake).create(CONFIG, KEY);
    const start = fake.seen.find((call) => call.url.pathname === '/process.Process/Start');
    const spec = JSON.parse(Buffer.from(start?.body.subarray(5) ?? []).toString('utf8')) as {
      process: { cmd: string; args: string[]; cwd: string; envs: Record<string, string> };
    };
    expect(spec.process).toMatchObject({
      cmd: 'node',
      args: ['/app/packages/tool-host/dist/main.js'],
      cwd: '/app',
      envs: { PORT: '8080', TOOL_HOST_DIR: '/tmp/tool-host' },
    });
    expect(spec.process.envs).not.toHaveProperty('RUNTIME_SANDBOX_BEARER');
    expect(start?.headers.get('x-access-token')).toBe(ENVD_TOKEN);
  });

  it('creates the tool host with no egress, not even to the gateway', async () => {
    const fake = fakeE2b();
    await driverFor(fake).create(CONFIG, KEY);
    const create = fake.seen.find(
      (call) => call.url.pathname === '/v2/sandboxes' && call.method === 'POST',
    );
    const { network } = JSON.parse(Buffer.from(create?.body ?? []).toString('utf8')) as {
      network: { allowOut?: string[]; denyOut: string[] };
    };
    expect(network.allowOut).toBeUndefined();
    expect(network.denyOut).toContain('0.0.0.0/0');
  });

  it('writes a file through envd with the envd token, never the provider key', async () => {
    const fake = fakeE2b();
    const driver = driverFor(fake);
    const handle = await driver.create(CONFIG, KEY);
    await driver.writeFile(handle, 'tokens.json', '["run-token"]', KEY);

    const connect = fake.seen.find((call) => call.url.pathname === '/sandboxes/sbxtool/connect');
    const { timeout } = JSON.parse(Buffer.from(connect?.body ?? []).toString('utf8')) as {
      timeout: number;
    };
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(3_600);

    const write = fake.seen.find((call) => call.url.pathname === '/files');
    expect(write?.method).toBe('POST');
    expect(write?.url.host).toBe('49983-sbxtool.e2b.example.dev');
    expect(write?.url.searchParams.get('path')).toBe('/tmp/tool-host/tokens.json');
    expect(write?.url.searchParams.get('username')).toBe('node');
    expect(write?.headers.get('content-type')).toBe('application/octet-stream');
    expect(write?.headers.get('x-access-token')).toBe(ENVD_TOKEN);
    expect(write?.headers.get('e2b-traffic-access-token')).toBe(TRAFFIC_TOKEN);
    expect(write?.headers.get('x-api-key')).toBeNull();
    expect(Buffer.from(write?.body ?? []).toString('utf8')).toBe('["run-token"]');
  });

  it('refuses a file name with a directory part, and a call without the provider key', async () => {
    const fake = fakeE2b();
    const driver = driverFor(fake);
    const handle = await driver.create(CONFIG, KEY);
    await expect(driver.writeFile(handle, '../etc/passwd', 'x', KEY)).rejects.toThrow(
      'not a plain file name',
    );
    await expect(driver.writeFile(handle, 'tokens.json', 'x')).rejects.toMatchObject({
      code: 'provider_credential_required',
    });
    expect(fake.seen.filter((call) => call.url.pathname === '/files')).toHaveLength(0);
  });

  it('names the status of a refused write and carries no token or key in the message', async () => {
    const fake = fakeE2b(() =>
      Response.json(
        { code: 500, message: `disk full for ${ENVD_TOKEN} ${TRAFFIC_TOKEN} ${KEY}` },
        { status: 507 },
      ),
    );
    const driver = driverFor(fake);
    const handle = await driver.create(CONFIG, KEY);
    const failure = await driver
      .writeFile(handle, 'manifest.json', '{}', KEY)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('status 507');
    for (const secret of [ENVD_TOKEN, TRAFFIC_TOKEN, KEY]) expect(message).not.toContain(secret);
  });

  it('is stateless: a sealed tool-host handle is found and written through a second driver', async () => {
    const fake = fakeE2b();
    const first = driverFor(fake, SEAL_SECRET);
    const created = await first.create(CONFIG, KEY);

    const second = driverFor(fake, SEAL_SECRET);
    const found = await second.find?.(CONFIG, KEY);
    expect(found?.externalId).toBe('sbxtool');
    await second.writeFile(created, 'tokens.json', '[]', KEY);
    expect(second.accessHeaders(created)).toEqual({ 'e2b-traffic-access-token': TRAFFIC_TOKEN });
    expect(second.recover?.(created.id)?.externalId).toBe('sbxtool');
  });

  it('seals under its own label: the runner driver does not recognise a tool-host id', async () => {
    const fake = fakeE2b();
    const toolHandle = await driverFor(fake, SEAL_SECRET).create(CONFIG, KEY);
    const runner = createExternalDriver<string, string>({
      provider: createE2bProvider({ fetch: fake.fetch, apiBase: 'https://api.e2b.test' }),
      images: IMAGES,
      gatewayUrl: 'https://gateway.example.dev',
      startAgent: () => {
        throw new Error('unused');
      },
      sealSecret: SEAL_SECRET,
    });
    expect(runner.recover?.(toolHandle.id)).toBeUndefined();
  });
});
