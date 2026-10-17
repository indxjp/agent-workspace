import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkEgress,
  checkHostEgress,
  EGRESS_ALLOW_HOSTS_ENV,
  EgressRefusedError,
  guardedFetch,
  loadEgressPolicyFromEnv,
  type EgressPolicyConfig,
  type EgressResolvedAddress,
  type EgressResolver,
} from './egress-policy.js';

const production: EgressPolicyConfig = { production: true, allowHosts: [] };
const development: EgressPolicyConfig = { production: false, allowHosts: [] };

function resolverFor(addresses: readonly EgressResolvedAddress[]): EgressResolver {
  return () => Promise.resolve(addresses);
}

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
): Promise<{ readonly baseUrl: string; readonly requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.headers.host ?? '');
    handler(req, res);
  });
  openServers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

describe('loadEgressPolicyFromEnv', () => {
  it('reads NODE_ENV and a comma-separated allowlist', () => {
    const policy = loadEgressPolicyFromEnv({
      NODE_ENV: 'production',
      [EGRESS_ALLOW_HOSTS_ENV]: 'internal.example, other.example ,,',
    });
    expect(policy).toEqual({ production: true, allowHosts: ['internal.example', 'other.example'] });
  });

  it('defaults to a non-production policy with an empty allowlist', () => {
    expect(loadEgressPolicyFromEnv({})).toEqual({ production: false, allowHosts: [] });
  });

  it('reads the production posture from AW_DEPLOYMENT_POSTURE over NODE_ENV (contract C2)', () => {
    expect(
      loadEgressPolicyFromEnv({
        NODE_ENV: 'production',
        AW_DEPLOYMENT_POSTURE: 'local',
        HOST: '127.0.0.1',
      }).production,
    ).toBe(false);
    expect(
      loadEgressPolicyFromEnv({ NODE_ENV: 'development', AW_DEPLOYMENT_POSTURE: 'production' })
        .production,
    ).toBe(true);
  });

  it('lets a local-posture production build reach a loopback HTTP fixture', async () => {
    const { baseUrl } = await fixtureServer((_req, res) => res.end('ok'));
    const policy = loadEgressPolicyFromEnv({
      NODE_ENV: 'production',
      AW_DEPLOYMENT_POSTURE: 'local',
      HOST: '127.0.0.1',
    });
    const decision = await checkEgress(baseUrl, policy);
    expect(decision.ok).toBe(true);
  });

  it('refuses a local posture on a non-loopback HOST', () => {
    expect(() =>
      loadEgressPolicyFromEnv({
        NODE_ENV: 'production',
        AW_DEPLOYMENT_POSTURE: 'local',
        HOST: '0.0.0.0',
      }),
    ).toThrow('local posture needs a loopback HOST');
  });

  // The gateway and the runner bind an unset HOST to 0.0.0.0 and Node binds an empty one to every
  // interface, so a local posture without a named loopback HOST must not relax the policy there.
  it.each([undefined, '', '   '])('refuses a local posture when HOST is %j', (host) => {
    expect(() =>
      loadEgressPolicyFromEnv({
        NODE_ENV: 'production',
        AW_DEPLOYMENT_POSTURE: 'local',
        HOST: host,
      }),
    ).toThrow('local posture needs a loopback HOST');
  });

  it('keeps refusing loopback HTTP under production when no posture is set', async () => {
    const { baseUrl } = await fixtureServer((_req, res) => res.end('ok'));
    const policy = loadEgressPolicyFromEnv({ NODE_ENV: 'production', HOST: '127.0.0.1' });
    expect(policy.production).toBe(true);
    const decision = await checkEgress(baseUrl, policy);
    expect(decision.ok).toBe(false);
  });
});

describe('checkEgress — default-deny address families', () => {
  const cases: Array<[string, EgressResolvedAddress]> = [
    ['IPv4 this-network 0/8', { address: '0.0.0.1', family: 4 }],
    ['loopback IPv4', { address: '127.0.0.1', family: 4 }],
    ['RFC1918 10/8', { address: '10.1.2.3', family: 4 }],
    ['RFC1918 172.16/12', { address: '172.20.0.5', family: 4 }],
    ['RFC1918 192.168/16', { address: '192.168.1.1', family: 4 }],
    ['RFC6598 carrier-grade NAT', { address: '100.100.100.200', family: 4 }],
    ['link-local / cloud metadata', { address: '169.254.169.254', family: 4 }],
    ['IPv6 loopback ::1', { address: '::1', family: 6 }],
    ['IPv6 unspecified ::', { address: '::', family: 6 }],
    ['IPv6 unique-local fc00::/7', { address: 'fd00::1', family: 6 }],
    ['IPv6 link-local fe80::/10', { address: 'fe80::1', family: 6 }],
    ['IPv4-mapped IPv6 loopback', { address: '::ffff:127.0.0.1', family: 6 }],
    ['IPv4-mapped IPv6 unspecified', { address: '::ffff:0.0.0.0', family: 6 }],
    ['IPv4-mapped IPv6 RFC1918', { address: '::ffff:10.0.0.1', family: 6 }],
    ['IPv4-compatible IPv6 metadata', { address: '::169.254.169.254', family: 6 }],
    ['NAT64 IPv6 metadata', { address: '64:ff9b::a9fe:a9fe', family: 6 }],
    ['6to4 IPv6 RFC1918', { address: '2002:a00:1::1', family: 6 }],
  ];

  it.each(cases)('refuses a resolved %s address in production', async (_label, address) => {
    const decision = await checkEgress(
      'https://example.invalid/v1/models',
      production,
      resolverFor([address]),
    );
    expect(decision.ok).toBe(false);
  });

  it('refuses when only one of several resolved addresses is unsafe', async () => {
    const decision = await checkEgress(
      'https://example.invalid/v1/models',
      production,
      resolverFor([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]),
    );
    expect(decision.ok).toBe(false);
  });

  it('allows a public address', async () => {
    const decision = await checkEgress(
      'https://example.invalid/v1/models',
      production,
      resolverFor([{ address: '93.184.216.34', family: 4 }]),
    );
    expect(decision.ok).toBe(true);
  });

  it.each([
    ['dotted IPv4 unspecified', 'https://0.0.0.0/v1'],
    ['bare-zero IPv4 unspecified', 'https://0/v1'],
    ['IPv4 this-network', 'https://0.0.0.1/v1'],
    ['IPv6 unspecified', 'https://[::]/v1'],
    ['IPv4-mapped IPv6 unspecified', 'https://[::ffff:0.0.0.0]/v1'],
  ])('refuses a literal %s address as unspecified', async (_label, url) => {
    const decision = await checkEgress(url, production, resolverFor([]));
    expect(decision).toMatchObject({
      ok: false,
      reason: 'Target resolves to an unspecified address, refused by policy.',
    });
  });

  it('does not apply the development loopback exception to an unspecified address', async () => {
    const decision = await checkEgress('https://0.0.0.0/v1', development, resolverFor([]));
    expect(decision.ok).toBe(false);
  });

  it('shortcuts DNS entirely for a literal-IP host', async () => {
    const resolve = vi.fn<EgressResolver>();
    const decision = await checkEgress('https://93.184.216.34/v1/models', production, resolve);
    expect(decision.ok).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('recognises a bracketed literal IPv6 host without resolving', async () => {
    const resolve = vi.fn<EgressResolver>();
    const decision = await checkEgress('https://[fe80::1]/v1/models', production, resolve);
    expect(decision.ok).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses encoded IPv4 forms of a blocked address the same as the dotted form', async () => {
    const octal = await checkEgress('https://0177.0.0.1/', production, resolverFor([]));
    const decimal = await checkEgress('https://2130706433/', production, resolverFor([]));
    expect(octal.ok).toBe(false);
    expect(decimal.ok).toBe(false);
  });
});

describe('checkEgress — userinfo, HTTPS, and the allowlist', () => {
  it('refuses userinfo in the URL outright, even for an otherwise-safe target', async () => {
    const decision = await checkEgress(
      'https://user:pass@example.invalid/v1',
      production,
      resolverFor([{ address: '93.184.216.34', family: 4 }]),
    );
    expect(decision.ok).toBe(false);
  });

  it('requires HTTPS for a non-loopback target regardless of environment', async () => {
    const decision = await checkEgress(
      'http://example.invalid/v1/models',
      development,
      resolverFor([{ address: '93.184.216.34', family: 4 }]),
    );
    expect(decision.ok).toBe(false);
  });

  it('refuses plain HTTP to loopback in production', async () => {
    const decision = await checkEgress(
      'http://127.0.0.1:9999/v1/models',
      production,
      resolverFor([{ address: '127.0.0.1', family: 4 }]),
    );
    expect(decision.ok).toBe(false);
  });

  it('allows plain HTTP to loopback outside production, for local fixtures', async () => {
    const decision = await checkEgress(
      'http://127.0.0.1:9999/v1/models',
      development,
      resolverFor([{ address: '127.0.0.1', family: 4 }]),
    );
    expect(decision.ok).toBe(true);
  });

  it('lets an explicitly allowed host through the range check but still requires HTTPS', async () => {
    const allowlisted: EgressPolicyConfig = { production: true, allowHosts: ['internal.example'] };
    const allowed = await checkEgress(
      'https://internal.example/v1/models',
      allowlisted,
      resolverFor([{ address: '10.0.0.5', family: 4 }]),
    );
    expect(allowed.ok).toBe(true);
    const stillHttp = await checkEgress(
      'http://internal.example/v1/models',
      allowlisted,
      resolverFor([{ address: '10.0.0.5', family: 4 }]),
    );
    expect(stillHttp.ok).toBe(false);
  });

  it('never puts the query string or userinfo into a refusal reason', async () => {
    const decision = await checkEgress(
      'https://user:s3cr3t@example.invalid/v1?token=abc123',
      production,
      resolverFor([{ address: '93.184.216.34', family: 4 }]),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).not.toContain('s3cr3t');
      expect(decision.reason).not.toContain('abc123');
      expect(decision.host).not.toContain('s3cr3t');
    }
  });

  it('refuses a failed DNS lookup rather than throwing', async () => {
    const decision = await checkEgress('https://nowhere.invalid/v1', production, () =>
      Promise.reject(new Error('ENOTFOUND')),
    );
    expect(decision.ok).toBe(false);
  });
});

describe('guardedFetch', () => {
  it('refuses an unspecified target before invoking its transport', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(
      guardedFetch('https://0.0.0.0/admin/secrets', {}, production, transport),
    ).rejects.toThrow(/unspecified address, refused by policy/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('never contacts the server for a refused target', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(
      guardedFetch(
        'https://169.254.169.254/latest/meta-data/',
        {},
        production,
        transport,
        resolverFor([{ address: '169.254.169.254', family: 4 }]),
      ),
    ).rejects.toThrow(/refused/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses a redirect rather than following it', async () => {
    // The redirect target is a second *real, reachable* loopback fixture that would answer 200 if
    // guardedFetch ever followed it. That is deliberate: pointing the redirect at a nonexistent
    // domain would make this test pass for the wrong reason, because following a broken redirect
    // also rejects (with a DNS failure) even when the `redirect: 'error'` refusal is missing
    // entirely. Only a redirect target that *would* succeed if followed can tell the two apart.
    const target = await fixtureServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('should-never-be-reached');
    });
    const { baseUrl } = await fixtureServer((_req, res) => {
      res.writeHead(302, { location: `${target.baseUrl}/` });
      res.end();
    });
    let caught: unknown;
    try {
      await guardedFetch(`${baseUrl}/`, {}, development);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const cause = (caught as Error).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(/redirect/i);
    expect(target.requests).toEqual([]);
  });

  it('passes a caller-supplied transport the exact URL unchanged (no address rewrite)', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    const response = await guardedFetch(
      'http://localhost:9500/v1/models',
      { headers: { 'x-api-key': 'k' } },
      development,
      transport,
      resolverFor([{ address: '127.0.0.1', family: 4 }]),
    );
    expect(response.status).toBe(200);
    expect(transport.mock.calls[0]?.[0]).toBe('http://localhost:9500/v1/models');
    expect((transport.mock.calls[0]?.[1] as RequestInit).redirect).toBe('error');
  });

  it('connects to the checked address on the real transport, closing the DNS-rebinding window', async () => {
    const { baseUrl, requests } = await fixtureServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('safe-origin');
    });
    const port = new URL(baseUrl).port;
    let calls = 0;
    // Simulates a rebinding DNS server: a safe answer on the check, a loopback-blocked answer on
    // any lookup after it. Because guardedFetch pins to the address it already checked, the
    // resolver is asked exactly once and the second (attacker) answer is never used.
    const rebindingResolver: EgressResolver = () => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? [{ address: '127.0.0.1', family: 4 }]
          : [{ address: '10.13.13.13', family: 4 }],
      );
    };
    const response = await guardedFetch(
      `http://rebinding-target.invalid:${port}/`,
      {},
      development,
      fetch,
      rebindingResolver,
    );
    expect(await response.text()).toBe('safe-origin');
    expect(calls).toBe(1);
    expect(requests).toEqual([`127.0.0.1:${port}`]);
  });

  it('still refuses an HTTPS target whose address is unsafe (the range check applies to both schemes)', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(
      guardedFetch(
        'https://internal-service.invalid/v1/models',
        {},
        production,
        transport,
        resolverFor([{ address: '10.0.0.9', family: 4 }]),
      ),
    ).rejects.toThrow(/refused/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('marks a refusal for a name that did not resolve, and only that one, as a DNS failure', async () => {
    const transport = vi.fn<typeof fetch>();
    const dns = await guardedFetch(
      'https://api.example.test/v1/models',
      {},
      production,
      transport,
      () => Promise.reject(new Error('ENOTFOUND')),
    ).catch((error: unknown) => error);
    expect(dns).toBeInstanceOf(EgressRefusedError);
    expect(dns).toMatchObject({
      dnsFailed: true,
      message: 'Egress policy refused a request to api.example.test: DNS resolution failed.',
    });

    const byRule = await guardedFetch(
      'https://internal-service.invalid/v1/models',
      {},
      production,
      transport,
      resolverFor([{ address: '10.0.0.9', family: 4 }]),
    ).catch((error: unknown) => error);
    expect(byRule).toBeInstanceOf(EgressRefusedError);
    expect(byRule).toMatchObject({ dnsFailed: false });
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not mark a temporary resolver failure (EAI_AGAIN) as a DNS failure (issue #661)', async () => {
    const transient = await guardedFetch(
      'https://api.example.test/v1/models',
      {},
      production,
      vi.fn<typeof fetch>(),
      () =>
        Promise.reject(Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' })),
    ).catch((error: unknown) => error);
    expect(transient).toBeInstanceOf(EgressRefusedError);
    expect(transient).toMatchObject({
      dnsFailed: false,
      message:
        'Egress policy refused a request to api.example.test: DNS resolution temporarily failed.',
    });
  });
});

describe('checkHostEgress — the TCP form of the policy', () => {
  it('refuses a host that resolves to a private address', async () => {
    const decision = await checkHostEgress(
      'db.example.test',
      development,
      resolverFor([{ address: '10.0.0.5', family: 4 }]),
    );
    expect(decision).toMatchObject({ ok: false, host: 'db.example.test' });
  });

  it('refuses a mixed answer that hides the metadata address behind a public one', async () => {
    const decision = await checkHostEgress(
      'db.example.test',
      production,
      resolverFor([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]),
    );
    expect(decision.ok).toBe(false);
  });

  it('tolerates plaintext to loopback only under a local posture', async () => {
    const loopback = resolverFor([{ address: '127.0.0.1', family: 4 }]);
    expect(await checkHostEgress('localhost', development, loopback)).toEqual({
      ok: true,
      host: 'localhost',
      addresses: [{ address: '127.0.0.1', family: 4 }],
      plaintextAllowed: true,
    });
    expect((await checkHostEgress('localhost', production, loopback)).ok).toBe(false);
  });

  it('lets an allowHosts entry past the range check without allowing plaintext', async () => {
    const decision = await checkHostEgress(
      'DB.internal.test',
      { production: true, allowHosts: ['db.internal.test'] },
      resolverFor([{ address: '10.0.0.5', family: 4 }]),
    );
    expect(decision).toMatchObject({ ok: true, plaintextAllowed: false });
  });

  it('does not resolve a literal address, bracketed or not', async () => {
    const resolve = vi.fn<EgressResolver>(() => Promise.reject(new Error('must not resolve')));
    expect(await checkHostEgress('93.184.216.34', production, resolve)).toMatchObject({
      ok: true,
      addresses: [{ address: '93.184.216.34', family: 4 }],
      plaintextAllowed: false,
    });
    expect(await checkHostEgress('[::1]', production, resolve)).toMatchObject({ ok: false });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('answers a resolver failure with a refusal instead of throwing', async () => {
    const decision = await checkHostEgress('db.example.test', production, () =>
      Promise.reject(new Error('ENOTFOUND')),
    );
    expect(decision).toEqual({
      ok: false,
      host: 'db.example.test',
      reason: 'DNS resolution failed.',
    });
  });
});
