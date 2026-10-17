import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeRunSpec } from './driver.js';
import { createExternalDriver } from './external/driver.js';
import { ALWAYS_DENIED_RANGES } from './external/e2b.js';
import { RuntimeRefusalError } from './external/errors.js';
import { createVercelSandboxProvider, vercelSandboxRuntimeCapabilities } from './vercel-sandbox.js';

const TOKEN = 'vercel_SENTINEL_access_token_0123456789';
const IMAGE = `registry.example.com/agent-runtime@sha256:${'a'.repeat(64)}`;
const IMAGES = new Map([['claude-agent-sdk', IMAGE]]);

type Recorded = {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
};
type Answer = { status: number; body: unknown };

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const createdOk: Answer = {
  status: 200,
  body: {
    sandbox: { name: 'ignored' },
    session: { id: 'sess_1', timeout: 3_600_000 },
    routes: [
      { port: 3000, url: 'https://other.vercel.run', subdomain: 'other' },
      { port: 8080, url: 'https://runner.vercel.run', subdomain: 'runner' },
    ],
  },
};

const isStrings = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Mirrors `NetworkPolicyRequestValidator` of `@vercel/sandbox@3.6.0` (checked 2026-10-08). */
function networkPolicyProblem(policy: unknown): string | undefined {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    return 'networkPolicy must be an object';
  }
  const record = policy as Record<string, unknown>;
  if ('mode' in record) {
    return record['mode'] === 'allow-all' || record['mode'] === 'deny-all'
      ? undefined
      : 'networkPolicy.mode must be allow-all or deny-all';
  }
  const unknownKey = Object.keys(record).find((key) => key !== 'allow' && key !== 'subnets');
  if (unknownKey !== undefined) return `networkPolicy.${unknownKey} is not a request field`;
  const allow = record['allow'];
  if (allow !== undefined && !isStrings(allow)) return 'networkPolicy.allow must be strings';
  const subnets = record['subnets'];
  if (subnets === undefined) return undefined;
  if (typeof subnets !== 'object' || subnets === null) {
    return 'networkPolicy.subnets must be an object';
  }
  const { allow: subnetAllow, deny } = subnets as Record<string, unknown>;
  if (subnetAllow !== undefined && !isStrings(subnetAllow)) {
    return 'networkPolicy.subnets.allow must be strings';
  }
  if (deny !== undefined && !isStrings(deny)) return 'networkPolicy.subnets.deny must be strings';
  const ipv6 = [subnetAllow, deny]
    .flatMap((list) => (Array.isArray(list) ? (list as string[]) : []))
    .find((cidr) => cidr.includes(':'));
  return ipv6 === undefined ? undefined : `Invalid CIDR "${ipv6}"`;
}

function validateCreate(call: Recorded): Answer | undefined {
  if (call.method !== 'POST' || !call.url.startsWith('/v4/sandboxes')) return undefined;
  const policy = (call.body as { networkPolicy?: unknown }).networkPolicy;
  const problem = policy === undefined ? undefined : networkPolicyProblem(policy);
  return problem === undefined
    ? undefined
    : {
        status: 400,
        body: { error: { code: 'bad_request', message: `Invalid request: ${problem}` } },
      };
}

async function fakeVercel(
  respond: (call: Recorded) => Answer = (call) =>
    call.url.startsWith('/v4/sandboxes') ? createdOk : { status: 200, body: {} },
): Promise<{ apiBase: string; calls: Recorded[] }> {
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
      const answer = validateCreate(call) ?? respond(call);
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { apiBase: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, calls };
}

function driverFor(apiBase: string, tier?: 'hobby' | 'pro') {
  return createExternalDriver<string, string>({
    provider: createVercelSandboxProvider({
      teamId: 'team_1',
      projectId: 'prj_1',
      apiBase,
      ...(tier === undefined ? {} : { tier }),
    }),
    driverId: 'vercel-sandbox',
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
    driver: 'vercel-sandbox',
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

describe('vercel-sandbox driver (ADR-0120)', () => {
  it('LC1/LC3: creates a sandbox, starts the runner, and addresses it by its route URL with a minted bearer', async () => {
    const { apiBase, calls } = await fakeVercel();
    const driver = driverFor(apiBase);
    const handle = await driver.create(config(spec()), TOKEN);

    expect(driver.id).toBe('vercel-sandbox');
    expect(handle.driver).toBe('vercel-sandbox');
    expect(handle.externalId).toMatch(/^aw-[A-Za-z0-9_-]{24}$/u);
    expect(JSON.stringify(handle)).not.toContain(TOKEN);
    expect(driver.requestUrl(handle, '/readyz')).toBe('https://runner.vercel.run/readyz');

    expect(calls.map((call) => `${call.method} ${call.url.split('?')[0] ?? ''}`)).toEqual([
      'POST /v4/sandboxes',
      'POST /v2/sandboxes/sessions/sess_1/cmd',
    ]);
    for (const call of calls) {
      expect(call.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.url).toContain('teamId=team_1');
    }

    const create = calls[0]?.body as Record<string, unknown>;
    expect(create).toMatchObject({
      name: handle.externalId,
      projectId: 'prj_1',
      image: IMAGE,
      ports: [8080],
      timeout: 2_700_000,
      persistent: false,
    });
    expect(JSON.stringify(create)).not.toContain(TOKEN);

    const start = calls[1]?.body as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(start.command).toBe('node');
    expect(start.args).toEqual(['/srv/apps/runner/dist/index.js']);
    const bearer = start.env['RUNTIME_SANDBOX_BEARER'];
    expect(bearer?.length).toBeGreaterThanOrEqual(43);
    expect(JSON.stringify(create)).not.toContain(String(bearer));
    expect(JSON.stringify(start)).not.toContain(TOKEN);
    expect(await driver.authHeaders(handle)).toEqual({ authorization: `Bearer ${String(bearer)}` });
    expect(await driver.isLive(handle)).toBe(true);

    await driver.destroy(handle, TOKEN);
    expect(calls[2]).toMatchObject({ method: 'DELETE', authorization: `Bearer ${TOKEN}` });
    expect(calls[2]?.url).toBe(`/v2/sandboxes/${handle.externalId}?teamId=team_1&projectId=prj_1`);
    expect(await driver.isLive(handle)).toBe(false);
  });

  it('LC4: none allows the gateway host only; open allows 0.0.0.0/0; both deny IPv4 ranges and send no IPv6 CIDR', async () => {
    const { apiBase, calls } = await fakeVercel();
    const driver = driverFor(apiBase);
    await driver.create(config(spec({ networkPolicy: 'none' })), TOKEN);
    await driver.create(config(spec({ networkPolicy: 'open' })), TOKEN);

    const creates = calls.filter((call) => call.url.startsWith('/v4/sandboxes'));
    const deny = [
      '169.254.0.0/16',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '100.64.0.0/10',
      '127.0.0.0/8',
    ];
    expect(creates.map((call) => (call.body as { networkPolicy: unknown }).networkPolicy)).toEqual([
      { allow: ['gateway.example.com'], subnets: { deny } },
      { subnets: { allow: ['0.0.0.0/0'], deny } },
    ]);
    for (const call of creates) {
      const { subnets } = (call.body as { networkPolicy: { subnets: Record<string, string[]> } })
        .networkPolicy;
      expect(Object.values(subnets).flat().join(',')).not.toContain(':');
    }
    expect(ALWAYS_DENIED_RANGES).toEqual(
      expect.arrayContaining(['169.254.0.0/16', 'fe80::/10', 'fc00::/7', '::1/128']),
    );
  });

  it('LC4: the validating fake rejects an IPv6 CIDR as the real API did in run 37771522792', async () => {
    const { apiBase } = await fakeVercel();
    const response = await fetch(`${apiBase}/v4/sandboxes?teamId=team_1`, {
      method: 'POST',
      body: JSON.stringify({ networkPolicy: { subnets: { deny: ['fe80::/10'] } } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'bad_request',
        message: expect.stringContaining('Invalid CIDR "fe80::/10"') as unknown,
      },
    });
  });

  it('LC4: the validating fake rejects the response-only custom shape, so the old body could not pass', async () => {
    const { apiBase } = await fakeVercel();
    const response = await fetch(`${apiBase}/v4/sandboxes?teamId=team_1`, {
      method: 'POST',
      body: JSON.stringify({
        networkPolicy: {
          mode: 'custom',
          allowedDomains: ['gateway.example.com'],
          deniedCIDRs: [...ALWAYS_DENIED_RANGES],
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('surfaces the provider error code and a short reason in the failure', async () => {
    const { apiBase } = await fakeVercel(() => ({
      status: 400,
      body: { error: { code: 'bad_request', message: 'networkPolicy.mode must be\n  allow-all' } },
    }));
    await expect(driverFor(apiBase).create(config(spec()), TOKEN)).rejects.toThrow(
      'vercel-sandbox runtime: provider vercel create failed with status 400 (code bad_request: networkPolicy.mode must be allow-all).',
    );
  });

  it('keeps only the status when the error body is not usable, and drops an unsafe code', async () => {
    const plain = await fakeVercel(() => ({ status: 502, body: 'upstream' }));
    await expect(driverFor(plain.apiBase).create(config(spec()), TOKEN)).rejects.toThrow(
      'vercel-sandbox runtime: provider vercel create failed with status 502.',
    );

    const huge = await fakeVercel(() => ({
      status: 500,
      body: { error: { code: 'x', message: 'y'.repeat(10_000) } },
    }));
    await expect(driverFor(huge.apiBase).create(config(spec()), TOKEN)).rejects.toThrow(
      'vercel-sandbox runtime: provider vercel create failed with status 500.',
    );

    const unsafe = await fakeVercel(() => ({
      status: 403,
      body: { error: { code: 'forbidden: see https://x', message: 'denied' } },
    }));
    await expect(driverFor(unsafe.apiBase).create(config(spec()), TOKEN)).rejects.toThrow(
      'vercel-sandbox runtime: provider vercel create failed with status 403 (denied).',
    );
  });

  it('LC4: refuses restricted by name before any provider call', async () => {
    const { apiBase, calls } = await fakeVercel();
    const error: unknown = await driverFor(apiBase)
      .create(config(spec({ networkPolicy: 'restricted' })), TOKEN)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeRefusalError);
    expect((error as RuntimeRefusalError).code).toBe('network_policy_unsupported');
    expect((error as Error).message).toBe(
      'vercel-sandbox runtime: refuses the restricted network policy until the E7 live lane proves a denied CIDR beats an allowed domain matched by SNI (ADR-0120 LC4).',
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses a run spec that selects the external driver', async () => {
    const { apiBase, calls } = await fakeVercel();
    expect(() =>
      driverFor(apiBase).assertCreatable(config(spec({ driver: 'external' })), TOKEN),
    ).toThrow('vercel-sandbox runtime: run spec selects incompatible driver external.');
    expect(calls).toHaveLength(0);
  });

  it('refuses allowedDomains and persistPaths by name', async () => {
    const { apiBase, calls } = await fakeVercel();
    const driver = driverFor(apiBase);
    for (const over of [{ allowedDomains: ['example.com'] }, { persistPaths: ['/data'] }]) {
      const error: unknown = await driver
        .create(config(spec(over)), TOKEN)
        .catch((caught: unknown) => caught);
      expect((error as RuntimeRefusalError).code).toBe('run_spec_unsupported');
    }
    expect(calls).toHaveLength(0);
  });

  it('LC6: needs the credential on create and destroy, and keeps the sandbox addressable without it', async () => {
    const { apiBase, calls } = await fakeVercel();
    const driver = driverFor(apiBase);
    const missing: unknown = await driver.create(config(spec())).catch((caught: unknown) => caught);
    expect((missing as RuntimeRefusalError).code).toBe('provider_credential_required');
    expect(calls).toHaveLength(0);

    const handle = await driver.create(config(spec()), TOKEN);
    const noToken: unknown = await driver.destroy(handle).catch((caught: unknown) => caught);
    expect((noToken as RuntimeRefusalError).code).toBe('provider_credential_required');
    expect(await driver.isLive(handle)).toBe(true);
  });

  it('LC6: the token never appears in an error, a stack or stderr, even when the provider echoes it', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // A bare base64url secret, like the runner bearer, with no `Bearer` prefix to anchor on.
    const secret = 'Abc_def-GHI0123456789xyz_LONGRUNNERBEARER';
    try {
      const { apiBase } = await fakeVercel((call) => ({
        status: 401,
        body: {
          error: {
            code: 'forbidden',
            message: `bad token ${String(call.authorization)} env ${secret}`,
          },
        },
      }));
      const error: unknown = await driverFor(apiBase)
        .create(config(spec()), TOKEN)
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(
        'vercel-sandbox runtime: provider vercel create failed with status 401 (code forbidden: bad token Bearer [redacted] env [redacted]).',
      );
      for (const leaked of [TOKEN, secret]) {
        expect((error as Error).message).not.toContain(leaked);
        expect(JSON.stringify(error)).not.toContain(leaked);
        expect(String((error as Error).stack)).not.toContain(leaked);
      }

      const unreachable: unknown = await driverFor('http://127.0.0.1:1')
        .create(config(spec()), TOKEN)
        .catch((caught: unknown) => caught);
      expect((unreachable as Error).message).toBe(
        'vercel-sandbox runtime: provider vercel create failed.',
      );
      expect(String((unreachable as Error).stack)).not.toContain(TOKEN);
      expect(JSON.stringify(write.mock.calls)).not.toContain(TOKEN);
      expect(JSON.stringify(write.mock.calls)).not.toContain(secret);
    } finally {
      write.mockRestore();
    }
  });

  it('destroy: an already-deleted sandbox (404) is success, any other failure is an error', async () => {
    const gone = await fakeVercel((call) =>
      call.method === 'DELETE' ? { status: 404, body: {} } : createdOk,
    );
    const driver = driverFor(gone.apiBase);
    const handle = await driver.create(config(spec()), TOKEN);
    await expect(driver.destroy(handle, TOKEN)).resolves.toBeUndefined();

    const broken = await fakeVercel((call) =>
      call.method === 'DELETE' ? { status: 500, body: {} } : createdOk,
    );
    const brokenDriver = driverFor(broken.apiBase);
    const kept = await brokenDriver.create(config(spec()), TOKEN);
    await expect(brokenDriver.destroy(kept, TOKEN)).rejects.toThrow(
      'vercel-sandbox runtime: provider vercel destroy failed with status 500.',
    );
  });

  it('deletes a sandbox whose create response cannot be used, and rejects without the body', async () => {
    const { apiBase, calls } = await fakeVercel((call) =>
      call.method === 'POST'
        ? {
            status: 200,
            body: {
              session: { id: 'sess_9' },
              routes: [{ port: 8080, url: `http://insecure.example.com/${TOKEN}` }],
            },
          }
        : { status: 200, body: {} },
    );
    const error: unknown = await driverFor(apiBase)
      .create(config(spec()), TOKEN)
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('vercel-sandbox runtime: provider vercel create failed.');
    expect(calls.map((call) => call.method)).toEqual(['POST', 'DELETE']);
    expect(calls[1]?.url).toContain('/v2/sandboxes/aw-');
  });

  it('deletes a sandbox whose runner failed to start', async () => {
    const { apiBase, calls } = await fakeVercel((call) => {
      if (call.url.includes('/cmd')) return { status: 500, body: {} };
      return call.url.startsWith('/v4/sandboxes') ? createdOk : { status: 200, body: {} };
    });
    await expect(driverFor(apiBase).create(config(spec()), TOKEN)).rejects.toThrow(
      'vercel-sandbox runtime: provider vercel start the runner failed with status 500.',
    );
    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'DELETE']);
  });

  it('extends the session by the shortfall when the granted timeout is shorter than asked', async () => {
    const { apiBase, calls } = await fakeVercel((call) => {
      if (call.url.startsWith('/v4/sandboxes')) {
        return {
          status: 200,
          body: {
            session: { id: 'sess_1', timeout: 300_000 },
            routes: [{ port: 8080, url: 'https://runner.vercel.run' }],
          },
        };
      }
      return { status: 200, body: {} };
    });
    await driverFor(apiBase).create(config(spec({ timeoutSeconds: 600 })), TOKEN);
    expect(calls.map((call) => call.url.split('?')[0])).toEqual([
      '/v4/sandboxes',
      '/v2/sandboxes/sessions/sess_1/extend-timeout',
      '/v2/sandboxes/sessions/sess_1/cmd',
    ]);
    expect(calls[1]?.body).toEqual({ duration: 300_000 });
  });

  it('clamps the timeout to the plan limit, and Pro raises it', async () => {
    const hobby = await fakeVercel();
    await driverFor(hobby.apiBase).create(config(spec({ timeoutSeconds: 999_999 })), TOKEN);
    expect((hobby.calls[0]?.body as { timeout: number }).timeout).toBe(2_700_000);

    const pro = await fakeVercel();
    await driverFor(pro.apiBase, 'pro').create(config(spec({ timeoutSeconds: 999_999 })), TOKEN);
    expect((pro.calls[0]?.body as { timeout: number }).timeout).toBe(86_400_000);
  });

  it('capabilities omit allowlist and keep the documented shape', () => {
    expect(vercelSandboxRuntimeCapabilities()).toEqual({
      isolation: 'microvm',
      customImage: true,
      persistentFilesystem: false,
      sessionAffinity: true,
      maxSessionSeconds: 2_700,
      networkPolicies: ['none', 'open'],
      execCommands: true,
      gpu: false,
      managedByProvider: true,
      typicalStartMs: null,
    });
    expect(vercelSandboxRuntimeCapabilities('pro').maxSessionSeconds).toBe(86_400);
  });
});
