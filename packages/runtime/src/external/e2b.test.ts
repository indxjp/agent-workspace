import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeRunSpec } from '../driver.js';
import { EngineImageConfigurationError } from '../engine-images.js';
import { createExternalDriver } from './driver.js';
import {
  ALWAYS_DENIED_RANGES,
  assertBuildIdPinnedTemplates,
  createE2bProvider,
  e2bRuntimeCapabilities,
} from './e2b.js';
import { RuntimeRefusalError } from './errors.js';

const KEY = 'e2b_SENTINEL_provider_key_0123456789';
const ENVD_TOKEN = 'envd-SENTINEL-access-token-0123456789';
const TRAFFIC_TOKEN = 'traffic-token';
const BUILD_ID = '0b6f2f0e-5a52-4f6c-9d57-2c1f8d3a7e11';
const IMAGES = new Map([['claude-agent-sdk', `agent-runtime:${BUILD_ID}`]]);
const CREATED = {
  sandboxID: 'sbx123',
  domain: 'e2b.example.dev',
  trafficAccessToken: TRAFFIC_TOKEN,
  envdAccessToken: ENVD_TOKEN,
};

type Recorded = { method: string; url: string; key: string | undefined; body: unknown };
type EnvdRecorded = { url: string; headers: IncomingHttpHeaders; frame: unknown };
type Answer = { status: number; body: unknown };
type Fake = Awaited<ReturnType<typeof fakeE2b>>;

/** A Connect envelope: one flag byte, a 4-byte big-endian length, the JSON message. */
function envelope(flags: number, message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

const START_STREAM = envelope(0, { event: { start: { pid: 7 } } });

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function readBody(request: IncomingMessage, then: (raw: Buffer) => void): void {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    then(Buffer.concat(chunks));
  });
}

/** envd answers 401 without the access token, and a `start` frame with it. */
function envdWithToken(call: EnvdRecorded): Answer | Buffer {
  return call.headers['x-access-token'] === ENVD_TOKEN
    ? START_STREAM
    : { status: 401, body: { code: 'unauthenticated', message: 'missing access token' } };
}

async function fakeE2b(
  respond: (call: Recorded) => Answer = () => ({ status: 201, body: CREATED }),
  envd: (call: EnvdRecorded) => Answer | Buffer = envdWithToken,
) {
  const calls: Recorded[] = [];
  const envdCalls: EnvdRecorded[] = [];
  const api = createServer((request, response) => {
    readBody(request, (raw) => {
      const header = request.headers['x-api-key'];
      const call: Recorded = {
        method: request.method ?? '',
        url: request.url ?? '',
        key: typeof header === 'string' ? header : undefined,
        body: raw.length > 0 ? (JSON.parse(raw.toString('utf8')) as unknown) : undefined,
      };
      calls.push(call);
      const answer = respond(call);
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      // A hostile provider that echoes the key back must not get it into an error.
      response.end(JSON.stringify(answer.body));
    });
  });
  const envdServer = createServer((request, response) => {
    readBody(request, (raw) => {
      const call: EnvdRecorded = {
        url: request.url ?? '',
        headers: request.headers,
        frame: JSON.parse(raw.subarray(5).toString('utf8')) as unknown,
      };
      envdCalls.push(call);
      const answer = envd(call);
      if (Buffer.isBuffer(answer)) {
        response.writeHead(200, { 'content-type': 'application/connect+json' });
        response.end(answer);
      } else {
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      }
    });
  });
  const apiPort = await listen(api);
  const envdPort = await listen(envdServer);
  // envd is `https://49983-<id>.<domain>` at E2B's edge; here it is answered by a local fake.
  const fetchEnvd: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname.startsWith('49983-')
      ? fetch(`http://127.0.0.1:${String(envdPort)}${url.pathname}`, init)
      : fetch(input, init);
  };
  return {
    apiBase: `http://127.0.0.1:${String(apiPort)}`,
    calls,
    envdCalls,
    fetch: fetchEnvd,
  };
}

function providerFor(fake: Fake) {
  return createE2bProvider({ apiBase: fake.apiBase, fetch: fake.fetch });
}

function driverFor(fake: Fake) {
  return createExternalDriver<string, string>({
    provider: providerFor(fake),
    images: IMAGES,
    gatewayUrl: 'https://gateway.example.com/v1',
    startAgent: () => {
      throw new Error('not used');
    },
  });
}

const REQUEST = {
  image: 'a:b',
  sessionKey: 's',
  bearer: 'bearer-SENTINEL-0123456789',
  networkPolicy: 'none',
  gatewayHost: 'g.example.com',
  timeoutSeconds: 60,
} as const;

function spec(over: Partial<RuntimeRunSpec> = {}): RuntimeRunSpec {
  return {
    runtimeProfileId: 'profile-1',
    driver: 'external',
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

/** Everything an error could leak: message, serialized form, stack and cause chain. */
function printed(error: unknown): string {
  return `${String(error)}${JSON.stringify(error)}${String((error as Error).stack)}`;
}

describe('external driver with the e2b provider (ADR-0120)', () => {
  it('LC1/LC3: creates a sandbox, addresses it by public URL, and authenticates with a minted bearer', async () => {
    const fake = await fakeE2b();
    const { calls, envdCalls } = fake;
    const driver = driverFor(fake);
    const handle = await driver.create(config(spec()), KEY);

    expect(handle.driver).toBe('external');
    expect(handle.externalId).toBe('sbx123');
    expect(JSON.stringify(handle)).not.toContain(KEY);
    expect(driver.requestUrl(handle, '/readyz')).toBe('https://8080-sbx123.e2b.example.dev/readyz');

    const [create] = calls;
    expect(create?.method).toBe('POST');
    expect(create?.url).toBe('/v2/sandboxes');
    expect(create?.key).toBe(KEY);
    const createBody = create?.body as Record<string, unknown>;
    expect(createBody['templateID']).toBe(`agent-runtime:${BUILD_ID}`);
    expect(createBody['timeout']).toBe(3_600);
    expect(JSON.stringify(createBody)).not.toContain(KEY);
    expect(createBody).not.toHaveProperty('envVars');

    // The bearer reaches the runner only through envd's process environment.
    expect(envdCalls).toHaveLength(1);
    const [start] = envdCalls;
    expect(start?.url).toBe('/process.Process/Start');
    expect(start?.headers['x-access-token']).toBe(ENVD_TOKEN);
    expect(start?.headers['x-api-key']).toBeUndefined();
    expect(start?.headers['content-type']).toBe('application/connect+json');
    expect(start?.headers['authorization']).toBe(
      `Basic ${Buffer.from('node:').toString('base64')}`,
    );
    expect(start?.headers['e2b-traffic-access-token']).toBe(TRAFFIC_TOKEN);
    const process = (start?.frame as { process: Record<string, unknown> }).process;
    expect(process).toMatchObject({
      cmd: 'node',
      args: ['/srv/apps/runner/dist/index.js'],
      cwd: '/workspace',
    });
    const envs = process['envs'] as Record<string, string>;
    const bearer = envs['RUNTIME_SANDBOX_BEARER'];
    expect(bearer?.length).toBeGreaterThanOrEqual(43);
    expect(JSON.stringify(calls)).not.toContain(String(bearer));

    const headers = await driver.authHeaders(handle);
    expect(headers).toEqual({
      authorization: `Bearer ${String(bearer)}`,
      'e2b-traffic-access-token': TRAFFIC_TOKEN,
    });
    expect(await driver.isLive(handle)).toBe(true);

    await driver.destroy(handle, KEY);
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: '/sandboxes/sbx123', key: KEY });
    expect(await driver.isLive(handle)).toBe(false);
  });

  it('LC4: none allows the gateway host only; open denies the always-denied ranges; port stays private', async () => {
    const fake = await fakeE2b();
    const { calls } = fake;
    const driver = driverFor(fake);
    await driver.create(config(spec({ networkPolicy: 'none' })), KEY);
    await driver.create(config(spec({ networkPolicy: 'open' })), KEY);

    expect(calls[0]?.body).toMatchObject({
      allow_internet_access: false,
      network: {
        allowPublicTraffic: false,
        allowOut: ['gateway.example.com'],
        denyOut: ['0.0.0.0/0', ...ALWAYS_DENIED_RANGES],
      },
    });
    const open = calls[1]?.body as {
      allow_internet_access: boolean;
      network: { denyOut: string[] };
    };
    expect(open.allow_internet_access).toBe(true);
    expect(open.network.denyOut).toEqual(
      expect.arrayContaining([
        '169.254.0.0/16',
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
        '100.64.0.0/10',
        '127.0.0.0/8',
        'fc00::/7',
      ]),
    );
  });

  it('LC4: none and open both deny every always-denied range, and neither sends ::/0', async () => {
    const fake = await fakeE2b();
    const { calls } = fake;
    const driver = driverFor(fake);
    await driver.create(config(spec({ networkPolicy: 'none' })), KEY);
    await driver.create(config(spec({ networkPolicy: 'open' })), KEY);

    expect(ALWAYS_DENIED_RANGES).toEqual(
      expect.arrayContaining(['fe80::/10', 'fc00::/7', '::1/128']),
    );
    for (const call of calls) {
      const { denyOut } = (call.body as { network: { denyOut: string[] } }).network;
      for (const range of ALWAYS_DENIED_RANGES) expect(denyOut).toContain(range);
      expect(denyOut).not.toContain('::/0');
    }
    expect(calls).toHaveLength(2);
  });

  it('LC4: a create E2B would answer 400 for ::/0 succeeds under none', async () => {
    const fake = await fakeE2b((call) => {
      const denyOut = (call.body as { network?: { denyOut?: string[] } } | undefined)?.network
        ?.denyOut;
      return denyOut?.includes('::/0') === true
        ? { status: 400, body: { code: 400, message: 'invalid denied CIDR ::/0' } }
        : { status: 201, body: CREATED };
    });
    const handle = await driverFor(fake).create(config(spec({ networkPolicy: 'none' })), KEY);
    expect(handle.externalId).toBe('sbx123');
    expect(fake.calls.map((call) => call.method)).toEqual(['POST']);
  });

  it('LC4: IPv6 egress denial under none is not claimed in the capabilities text', () => {
    // RuntimeCapabilities has no IPv6 field; `none` is listed, not an IPv6 guarantee.
    expect(e2bRuntimeCapabilities().networkPolicies).toEqual(['none', 'open']);
  });

  it('LC4: refuses restricted by name before any provider call', async () => {
    const fake = await fakeE2b();
    const error: unknown = await driverFor(fake)
      .create(config(spec({ networkPolicy: 'restricted' })), KEY)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeRefusalError);
    expect((error as RuntimeRefusalError).code).toBe('network_policy_unsupported');
    expect((error as Error).message).toBe(
      'external runtime: provider e2b refuses the restricted network policy until the E7 live lane proves the always-denied ranges hold; E2B lets an allowed domain beat a denied range (ADR-0120 LC4).',
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses allowedDomains and persistPaths by name', async () => {
    const fake = await fakeE2b();
    const driver = driverFor(fake);
    for (const over of [{ allowedDomains: ['example.com'] }, { persistPaths: ['/data'] }]) {
      const error: unknown = await driver
        .create(config(spec(over)), KEY)
        .catch((caught: unknown) => caught);
      expect((error as RuntimeRefusalError).code).toBe('run_spec_unsupported');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('LC6: needs the credential on create and destroy, and keeps the sandbox addressable without it', async () => {
    const fake = await fakeE2b();
    const driver = driverFor(fake);
    const missing: unknown = await driver.create(config(spec())).catch((caught: unknown) => caught);
    expect((missing as RuntimeRefusalError).code).toBe('provider_credential_required');
    expect(fake.calls).toHaveLength(0);

    const handle = await driver.create(config(spec()), KEY);
    const noKey: unknown = await driver.destroy(handle).catch((caught: unknown) => caught);
    expect((noKey as RuntimeRefusalError).code).toBe('provider_credential_required');
    expect(await driver.isLive(handle)).toBe(true);
  });

  it('LC6: the provider key never appears in an error, even when the provider echoes it', async () => {
    const fake = await fakeE2b((call) => ({
      status: 401,
      body: { message: `bad key ${String(call.key)}` },
    }));
    const error: unknown = await driverFor(fake)
      .create(config(spec()), KEY)
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(
      'external runtime: provider e2b create failed with status 401: bad key [redacted].',
    );
    expect(printed(error)).not.toContain(KEY);

    const refused = createE2bProvider({ apiBase: 'http://127.0.0.1:1' });
    const unreachable: unknown = await refused
      .create(REQUEST, KEY)
      .catch((caught: unknown) => caught);
    expect((error as Error).message + (unreachable as Error).message).not.toContain(KEY);
    expect((unreachable as Error).message).toBe('external runtime: provider e2b create failed.');
  });

  it('kills a sandbox whose response cannot be reached safely, and rejects the response', async () => {
    const fake = await fakeE2b(({ method }) =>
      method === 'POST'
        ? { status: 201, body: { sandboxID: 'sbx9', domain: 'e2b.example.dev' } }
        : { status: 204, body: {} },
    );
    await expect(driverFor(fake).create(config(spec()), KEY)).rejects.toThrow(/create failed/u);
    expect(fake.calls.map((call) => call.method)).toEqual(['POST', 'DELETE']);
    expect(fake.envdCalls).toHaveLength(0);
  });

  it('clamps the timeout to the plan limit, and Pro raises it', async () => {
    const fake = await fakeE2b();
    const driver = driverFor(fake);
    await driver.create(config(spec({ timeoutSeconds: 999_999 })), KEY);
    expect((fake.calls[0]?.body as { timeout: number }).timeout).toBe(3_600);
    expect(e2bRuntimeCapabilities('pro').maxSessionSeconds).toBe(86_400);
  });

  it('capabilities omit allowlist and keep the documented shape', () => {
    expect(e2bRuntimeCapabilities()).toEqual({
      isolation: 'microvm',
      customImage: true,
      persistentFilesystem: false,
      sessionAffinity: true,
      maxSessionSeconds: 3_600,
      networkPolicies: ['none', 'open'],
      execCommands: true,
      gpu: false,
      managedByProvider: true,
      typicalStartMs: null,
      fileTransfer: 'push-archive',
    });
  });

  it('LC2: production pins are <template>:<build_id>, and a refusal names only the keys', () => {
    expect(() => assertBuildIdPinnedTemplates(IMAGES)).not.toThrow();
    const bad = new Map([['pi', 'agent-runtime:latest-SECRETISH']]);
    expect(() => assertBuildIdPinnedTemplates(bad)).toThrow(EngineImageConfigurationError);
    expect(() => assertBuildIdPinnedTemplates(bad)).not.toThrow(/SECRETISH/u);
  });

  it('LC3: a non-https gateway URL is refused at construction', () => {
    expect(() =>
      createExternalDriver<string, string>({
        provider: createE2bProvider(),
        images: IMAGES,
        gatewayUrl: 'http://gateway.example.com',
        startAgent: () => {
          throw new Error('not used');
        },
      }),
    ).toThrow(/https/u);
  });
});

describe('the e2b provider against the live lane findings (run 37752204337)', () => {
  it('a null domain falls back to e2b.app, and the sandbox is neither killed nor refused', async () => {
    const fake = await fakeE2b(() => ({ status: 201, body: { ...CREATED, domain: null } }));
    const sandbox = await providerFor(fake).create({ ...REQUEST, networkPolicy: 'open' }, KEY);
    expect(sandbox.origin).toBe('https://8080-sbx123.e2b.app');
    expect(fake.calls.map((call) => call.method)).toEqual(['POST']);
    expect(fake.envdCalls).toHaveLength(1);
  });

  it('a domain that is not a hostname is still killed and refused', async () => {
    const fake = await fakeE2b(({ method }) =>
      method === 'POST'
        ? { status: 201, body: { ...CREATED, domain: 'bad domain!' } }
        : { status: 204, body: {} },
    );
    await expect(providerFor(fake).create(REQUEST, KEY)).rejects.toThrow(/create failed/u);
    expect(fake.calls.map((call) => call.method)).toEqual(['POST', 'DELETE']);
    expect(fake.envdCalls).toHaveLength(0);
  });

  it('find connects a null-domain sandbox without starting the runner again', async () => {
    const endAt = new Date(Date.now() + 600_000).toISOString();
    const fake = await fakeE2b(({ method, url }) =>
      method === 'GET' && url.startsWith('/v2/sandboxes?')
        ? { status: 200, body: [{ sandboxID: 'sbx123', endAt }] }
        : { status: 200, body: { ...CREATED, domain: null } },
    );
    const found = await providerFor(fake).find?.('lookup-key', KEY);
    expect(found).toMatchObject({
      sandboxId: 'sbx123',
      origin: 'https://8080-sbx123.e2b.app',
      expiresAt: Date.parse(endAt),
    });
    expect(fake.envdCalls).toHaveLength(0);
  });

  it('envd answers 401 without the access token: the sandbox is killed and the status named', async () => {
    const fake = await fakeE2b(({ method }) =>
      method === 'POST'
        ? { status: 201, body: { ...CREATED, envdAccessToken: 'the-wrong-token' } }
        : { status: 204, body: {} },
    );
    const error: unknown = await providerFor(fake)
      .create(REQUEST, KEY)
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(
      'external runtime: provider e2b start the runner failed with status 401: missing access token.',
    );
    expect(fake.calls.map((call) => call.method)).toEqual(['POST', 'DELETE']);
    for (const secret of [KEY, ENVD_TOKEN, 'the-wrong-token', REQUEST.bearer, TRAFFIC_TOKEN]) {
      expect(printed(error)).not.toContain(secret);
    }
  });

  it('a create response without envdAccessToken kills the sandbox and never calls envd', async () => {
    const withoutToken = { ...CREATED, envdAccessToken: undefined };
    const fake = await fakeE2b(({ method }) =>
      method === 'POST' ? { status: 201, body: withoutToken } : { status: 204, body: {} },
    );
    await expect(providerFor(fake).create(REQUEST, KEY)).rejects.toThrow(/create failed/u);
    expect(fake.calls.map((call) => call.method)).toEqual(['POST', 'DELETE']);
    expect(fake.envdCalls).toHaveLength(0);
  });

  it('an end-of-stream error frame is surfaced redacted, and the sandbox is killed', async () => {
    const leaky = `exec failed for ${REQUEST.bearer} with ${ENVD_TOKEN}`;
    const fake = await fakeE2b(
      ({ method }) =>
        method === 'POST' ? { status: 201, body: CREATED } : { status: 204, body: {} },
      () => envelope(2, { error: { code: 'not_found', message: leaky } }),
    );
    const error: unknown = await providerFor(fake)
      .create(REQUEST, KEY)
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(
      'external runtime: provider e2b start the runner failed: exec failed for [redacted] with [redacted].',
    );
    expect(fake.calls.map((call) => call.method)).toEqual(['POST', 'DELETE']);
  });

  it('a stream with no start event, or an exit first, is a failure', async () => {
    for (const stream of [
      Buffer.alloc(0),
      envelope(0, { event: { keepalive: {} } }),
      envelope(0, { event: { end: { exited: true, exitCode: 1 } } }),
    ]) {
      const fake = await fakeE2b(
        ({ method }) =>
          method === 'POST' ? { status: 201, body: CREATED } : { status: 204, body: {} },
        () => stream,
      );
      await expect(providerFor(fake).create(REQUEST, KEY)).rejects.toThrow(
        /start the runner failed\./u,
      );
      expect(fake.calls.map((call) => call.method)).toEqual(['POST', 'DELETE']);
    }
  });

  it('a start event split across chunks is read whole', async () => {
    const half = Math.floor(START_STREAM.length / 2);
    const fake = await fakeE2b(undefined, () => START_STREAM);
    const split: typeof globalThis.fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes('49983-')) return response;
      const bytes = Buffer.from(await response.arrayBuffer());
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes.subarray(0, half)));
            controller.enqueue(new Uint8Array(bytes.subarray(half)));
            controller.close();
          },
        }),
        { status: 200 },
      );
    };
    const sandbox = await createE2bProvider({ apiBase: fake.apiBase, fetch: split }).create(
      REQUEST,
      KEY,
    );
    expect(sandbox.sandboxId).toBe('sbx123');
  });

  it('the stateless bearer given to create is the one envd starts the runner with', async () => {
    const fake = await fakeE2b();
    await providerFor(fake).create({ ...REQUEST, lookupKey: 'k1' }, KEY);
    const frame = fake.envdCalls[0]?.frame as { process: { envs: Record<string, string> } };
    expect(frame.process.envs['RUNTIME_SANDBOX_BEARER']).toBe(REQUEST.bearer);
    expect((fake.calls[0]?.body as { metadata: Record<string, string> }).metadata['awKey']).toBe(
      'k1',
    );
  });
});

describe('the e2b provider surfaces a short redacted reason', () => {
  async function createdWith(answer: Answer): Promise<Error> {
    const fake = await fakeE2b(() => answer);
    return await providerFor(fake)
      .create(REQUEST, KEY)
      .then(
        () => new Error('create did not fail'),
        (caught: unknown) => caught as Error,
      );
  }

  it('a 400 {code, message} body names the reason', async () => {
    const error = await createdWith({
      status: 400,
      body: { code: 400, message: 'invalid denied CIDR ::/0' },
    });
    expect(error.message).toBe(
      'external runtime: provider e2b create failed with status 400: invalid denied CIDR ::/0.',
    );
  });

  it('a non-JSON body adds no reason', async () => {
    const fake = await fakeE2b();
    const html: typeof globalThis.fetch = (input, init) =>
      Promise.resolve(
        (input instanceof Request ? input.url : String(input)).endsWith('/v2/sandboxes')
          ? new Response(`<html>${KEY}</html>`, { status: 500 })
          : fake.fetch(input, init),
      );
    const error = await createE2bProvider({ apiBase: fake.apiBase, fetch: html })
      .create(REQUEST, KEY)
      .then(
        () => new Error('create did not fail'),
        (caught: unknown) => caught as Error,
      );
    expect(error.message).toBe('external runtime: provider e2b create failed with status 500.');
  });

  it('names the concurrency limit when create is answered 429, and does not retry', async () => {
    const fake = await fakeE2b(() => ({
      status: 429,
      body: { message: 'you have reached the maximum number of concurrent E2B sandboxes (20).' },
    }));
    const error = await providerFor(fake)
      .create(REQUEST, KEY)
      .then(
        () => new Error('create did not fail'),
        (caught: unknown) => caught as Error,
      );
    expect(error.message).toBe(
      "external runtime: provider e2b create failed with status 429: the provider's concurrency limit was reached (you have reached the maximum number of concurrent E2B sandboxes (20)).",
    );
    expect(fake.calls).toHaveLength(1);
  });

  it('a long message is capped', async () => {
    const error = await createdWith({ status: 400, body: { message: 'x'.repeat(300) } });
    expect(error.message).toBe(
      `external runtime: provider e2b create failed with status 400: ${'x'.repeat(160)}....`,
    );
  });

  it('keys, the bearer and control characters are sanitized', async () => {
    const error = await createdWith({
      status: 403,
      body: {
        message: `a\u0000b\nc e2b_other_Key123 ${REQUEST.bearer} ${KEY}\u001b[31mred`,
      },
    });
    expect(error.message).toBe(
      'external runtime: provider e2b create failed with status 403: a b c [redacted] [redacted] [redacted] [31mred.',
    );
    expect(printed(error)).not.toContain(KEY);
    expect(printed(error)).not.toContain(REQUEST.bearer);
  });

  it('destroy and find name the reason too', async () => {
    const fake = await fakeE2b(() => ({ status: 403, body: { message: 'team is blocked' } }));
    const provider = providerFor(fake);
    const destroyed: unknown = await provider
      .destroy('sbx1', KEY)
      .catch((caught: unknown) => caught);
    expect((destroyed as Error).message).toBe(
      'external runtime: provider e2b destroy failed with status 403: team is blocked.',
    );
    const found: unknown = await provider.find?.('k', KEY).catch((caught: unknown) => caught);
    expect((found as Error).message).toBe(
      'external runtime: provider e2b find failed with status 403: team is blocked.',
    );
  });
});
