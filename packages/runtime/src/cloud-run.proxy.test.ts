import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CLOUD_RUN_PROXIED_RUNTIME_CAPABILITIES,
  type CloudRunResourceClient,
} from './cloud-run.js';
import { NET, cloudRunDriver, fakeClient } from './cloud-run.test-support.js';

const KEY = 'aw-egress-test-key-0123456789abcdef';
const NOW = 1_800_000_000_000;
const PROXY = { url: 'http://10.10.0.60:3128', key: KEY, bypass: ['10.10.0.10'] };

function proxied(client: CloudRunResourceClient, egressProxy = PROXY) {
  return cloudRunDriver(client, { egressProxy, now: () => NOW });
}

function createWith(
  driver: ReturnType<typeof proxied>,
  networkPolicy: 'none' | 'restricted' | 'open',
  allowedDomains?: readonly string[],
  timeoutSeconds?: number,
) {
  return driver.create({
    sessionId: 'sess-9',
    engine: 'claude-agent-sdk',
    workspacePath: '/ws/s',
    runSpec: {
      runtimeProfileId: 'p',
      driver: 'cloud-run-service',
      networkPolicy,
      filesystem: 'read-write',
      ...(allowedDomains === undefined ? {} : { allowedDomains }),
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    },
  });
}

function claimsOf(env: Readonly<Record<string, string>> | undefined) {
  const proxyUrl = new URL(env?.['HTTPS_PROXY'] ?? '');
  const [payload, signature] = proxyUrl.password.split('.');
  expect(signature).toBe(
    createHmac('sha256', KEY)
      .update(payload ?? '')
      .digest('base64url'),
  );
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as unknown;
}

describe('cloud-run-service runtime: sandbox internet through the egress proxy', () => {
  it('claims allowlist and open when a proxy is configured', () => {
    expect(proxied(fakeClient().client).capabilities).toBe(CLOUD_RUN_PROXIED_RUNTIME_CAPABILITIES);
    expect(CLOUD_RUN_PROXIED_RUNTIME_CAPABILITIES.networkPolicies).toEqual([
      'none',
      'allowlist',
      'open',
    ]);
  });

  it('points a restricted sandbox at the proxy with a signed per-session credential', async () => {
    const { client, specs } = fakeClient();
    await createWith(proxied(client), 'restricted', ['api.example.com'], 600);
    const env = specs[0]?.env;
    expect(env?.['HTTPS_PROXY']).toMatch(/^http:\/\/aw:[\w-]+\.[\w-]+@10\.10\.0\.60:3128$/u);
    expect(env?.['HTTP_PROXY']).toBe(env?.['HTTPS_PROXY']);
    expect(env?.['NO_PROXY']).toContain('10.10.0.10');
    expect(env?.['NODE_USE_ENV_PROXY']).toBe('1');
    expect(claimsOf(env)).toEqual({
      sid: 'sess-9',
      exp: NOW / 1000 + 600 + 300,
      hosts: ['api.example.com'],
    });
  });

  it('defaults the credential lifetime to the one hour service timeout', async () => {
    const { client, specs } = fakeClient();
    await createWith(proxied(client), 'restricted', ['api.example.com']);
    expect(claimsOf(specs[0]?.env)).toMatchObject({ exp: NOW / 1000 + 3600 + 300 });
  });

  it('reports a reused runtime not live once its proxy credential has expired', async () => {
    const { client } = fakeClient();
    let clock = NOW;
    const driver = cloudRunDriver(client, { egressProxy: PROXY, now: () => clock });
    const handle = await createWith(driver, 'restricted', ['api.example.com'], 600);
    expect(await driver.isLive(handle)).toBe(true);
    clock = NOW + (600 + 300) * 1_000 - 100_000;
    expect(await driver.isLive(handle)).toBe(false);
  });
});

describe('cloud-run-service runtime: proxy allowlist specs', () => {
  it('gives an open run the allowlist *', async () => {
    const { client, specs } = fakeClient();
    await createWith(proxied(client), 'open');
    expect(claimsOf(specs[0]?.env)).toMatchObject({ hosts: ['*'] });
  });

  it.each([
    ['none', undefined],
    ['restricted', []],
  ] as const)('sends no environment for %s with no domains', async (policy, domains) => {
    const { client, specs } = fakeClient();
    await createWith(proxied(client), policy, domains);
    expect(specs[0]).not.toHaveProperty('env');
  });

  it('refuses * inside allowedDomains and domains on the none policy', async () => {
    const { client, created } = fakeClient();
    await expect(createWith(proxied(client), 'restricted', ['*'])).rejects.toThrow(
      /allowedDomains entries/u,
    );
    await expect(createWith(proxied(client), 'none', ['api.example.com'])).rejects.toThrow(
      /applies only to the restricted/u,
    );
    expect(created).toHaveLength(0);
  });

  it.each([
    [{ ...PROXY, url: 'https://10.10.0.60:3128' }, /http: URL/u],
    [{ ...PROXY, url: ' ' }, /egressProxy\.url/u],
    [{ ...PROXY, key: '' }, /egressProxy\.key/u],
    [{ ...PROXY, bypass: ['bad host'] }, /proxyBypass/u],
  ])('refuses a bad egressProxy %j', (egressProxy, message) => {
    expect(() => proxied(fakeClient().client, egressProxy)).toThrow(message);
  });
});

describe('cloud-run-service runtime: proxy service environment', () => {
  it('maps the service environment into the container, and omits it when empty', async () => {
    const { createCloudRunAdminClient } = await import('./cloud-run.js');
    const bodies: Array<{ template: { containers: Array<Record<string, unknown>> } }> = [];
    const client = createCloudRunAdminClient({
      fetch: (_url, init = {}) => {
        bodies.push(
          JSON.parse(typeof init.body === 'string' ? init.body : '{}') as (typeof bodies)[number],
        );
        return Promise.resolve(new Response(JSON.stringify({ name: 'op' }), { status: 200 }));
      },
      accessToken: () => Promise.resolve('tok'),
    });
    const base = {
      serviceId: 'rt-1',
      image: 'runtime@sha256:abc',
      region: 'r',
      project: 'proj',
      serviceAccount: 'sa@proj.iam.gserviceaccount.com',
      ...NET,
      labels: {},
    };
    await client.createService({ ...base, env: { A: 'b' } });
    await client.createService({ ...base, env: {} });
    expect(bodies[0]?.template.containers[0]?.['env']).toEqual([{ name: 'A', value: 'b' }]);
    expect(bodies[1]?.template.containers[0]).not.toHaveProperty('env');
  });
});
