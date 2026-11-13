import { afterEach, describe, expect, it } from 'vitest';
import { ALWAYS_DENIED_RANGES } from './external/e2b.js';
import { RuntimeRefusalError } from './external/errors.js';
import {
  TOKEN,
  servers,
  fakeVercel,
  driverFor,
  spec,
  config,
} from './vercel-sandbox.test-support.js';

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('vercel network policy', () => {
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
});
