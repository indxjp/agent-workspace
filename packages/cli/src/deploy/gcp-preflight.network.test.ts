import { describe, expect, it } from 'vitest';

import {
  enforcedPolicy,
  failed,
  policyKey,
  restrictedMemberDomainsPolicy,
  setup,
  status,
} from './gcp-preflight.test-support.js';

const WEB_APP_ACCESS_TITLE =
  "the web app's sign-in page and the gateway must be reachable by anyone (the gateway keeps an allUsers invoker binding whatever gcp.iap is). Ask your administrator for an exception for project acme-prod";

const INGRESS_WARNING =
  'run.allowedIngress: the web app stays public (internal-and-cloud-load-balancing, behind the load balancer for agents.example.com) and the runner manager is internal';

describe('runGcpPreflight public access policy', () => {
  const restricted = {
    [policyKey('iam.allowedPolicyMemberDomains')]: restrictedMemberDomainsPolicy(),
  };

  it('fails when the organisation restricts policy member domains', async () => {
    const report = await setup({ overrides: restricted }).run();
    const access = status(report, 'org-policy-public-access');
    expect(access?.status).toBe('fail');
    expect(access?.fix).toBeUndefined();
    expect(access?.title).toContain('administrator');
  });

  it('names who can still reach the web app, and the way out, when access is restricted', async () => {
    const access = status(await setup({ overrides: restricted }).run(), 'org-policy-public-access');
    expect(access?.status).toBe('fail');
    expect(access?.title).toContain(WEB_APP_ACCESS_TITLE);
    expect(access?.title).not.toContain('later release');
    expect(access?.fix).toBeUndefined();
    const withIap = await setup({ overrides: restricted }).run(false, {
      domain: 'agents.example.com',
      iap: true,
    });
    expect(status(withIap, 'org-policy-public-access')?.status).toBe('fail');
    expect(status(withIap, 'org-policy-public-access')?.title).toContain('gateway');
    const domainOnly = await setup({ overrides: restricted }).run(false, {
      domain: 'agents.example.com',
    });
    expect(status(domainOnly, 'org-policy-public-access')?.status).toBe('fail');
  });

  it('warns when an org policy cannot be described', async () => {
    const { run } = setup({
      overrides: { [policyKey('iam.allowedPolicyMemberDomains')]: failed },
    });
    const report = await run();
    expect(status(report, 'org-policy-public-access')?.status).toBe('warn');
  });
});

describe('runGcpPreflight private network policies', () => {
  it('is satisfied by the sql public IP policies', async () => {
    const sql = await setup({
      overrides: {
        [policyKey('sql.restrictPublicIp')]: enforcedPolicy(),
        [policyKey('sql.managed.restrictPublicIp')]: enforcedPolicy(),
      },
    }).run();
    expect(status(sql, 'org-policy-private-network')?.status).toBe('ok');
  });

  it('warns what ingress and egress policies mean', async () => {
    const report = await setup({
      overrides: {
        [policyKey('run.allowedIngress')]: enforcedPolicy(),
        [policyKey('run.allowedVPCEgress')]: enforcedPolicy(),
      },
    }).run(false, { domain: 'agents.example.com' });
    const network = status(report, 'org-policy-private-network');
    expect(network?.status).toBe('warn');
    expect(network?.title).toContain(INGRESS_WARNING);
    expect(network?.title).toContain('run.allowedVPCEgress: the services use private-ranges-only');
    expect(network?.title).not.toContain('later release');
    expect(network?.fix).toBeUndefined();
    expect(report.passed).toBe(true);
  });
});

describe('runGcpPreflight DNS for gcp.domain', () => {
  const dns = (ip: string | null, addresses: string[] | Error) =>
    setup().run(false, {
      domain: 'agents.example.com',
      loadBalancerIp: () => Promise.resolve(ip),
      resolveHost: (host) =>
        addresses instanceof Error || host !== 'agents.example.com'
          ? Promise.reject(addresses instanceof Error ? addresses : new Error(host))
          : Promise.resolve(addresses.map((address) => ({ address, family: 4 }))),
    });

  it('warns that DNS must follow the deploy before the load balancer exists', async () => {
    const row = status(await dns(null, ['203.0.113.7']), 'dns');
    expect(row?.status).toBe('warn');
    expect(row?.fix).toContain('points at the printed address');
  });

  it('is not checked without a domain', async () => {
    const noDomain = await setup().run(false, {
      loadBalancerIp: () => Promise.resolve('203.0.113.7'),
      resolveHost: () => Promise.resolve([]),
    });
    expect(status(noDomain, 'dns')).toBeUndefined();
  });

  it('is ok when the domain resolves to the load balancer', async () => {
    const report = await dns('203.0.113.7', ['198.51.100.1', '203.0.113.7']);
    expect(status(report, 'dns')?.status).toBe('ok');
  });

  it('warns, with the record to create, when the domain does not point there yet', async () => {
    for (const resolved of [['198.51.100.1'], new Error('ENOTFOUND')]) {
      const report = await dns('203.0.113.7', resolved);
      expect(status(report, 'dns')).toMatchObject({
        status: 'warn',
        title:
          'DNS for agents.example.com does not point here yet (203.0.113.7); the certificate is issued once it does',
        fix: 'create this record at your DNS provider: agents.example.com. A 203.0.113.7',
      });
      expect(report.passed).toBe(true);
    }
  });
});
