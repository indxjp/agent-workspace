import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { egressAllowlist, proxyUrlWithCredential, signEgressCredential } from './egress.js';

const KEY = 'aw-egress-test-key-0123456789abcdef';

describe('signEgressCredential', () => {
  it('matches the shared test vector of the egress proxy', () => {
    expect(
      signEgressCredential(KEY, {
        sid: 'sess-1',
        exp: 2_000_000_000,
        hosts: ['api.example.com', '*.example.org'],
      }),
    ).toBe(
      'eyJzaWQiOiJzZXNzLTEiLCJleHAiOjIwMDAwMDAwMDAsImhvc3RzIjpbImFwaS5leGFtcGxlLmNvbSIsIiouZXhhbXBsZS5vcmciXX0.98sly0lpHkLIwb3VH0M22Gd6QzMhyMXg2XfpmQ2PMew',
    );
  });

  it('signs the payload segment with HMAC-SHA256', () => {
    const [payload, signature] = signEgressCredential(KEY, {
      sid: 's',
      exp: 1,
      hosts: ['*'],
    }).split('.');
    expect(signature).toBe(
      createHmac('sha256', KEY)
        .update(payload ?? '')
        .digest('base64url'),
    );
  });

  it('refuses a key shorter than 32 characters', () => {
    expect(() => signEgressCredential('short', { sid: 's', exp: 1, hosts: ['*'] })).toThrow(
      /at least 32/u,
    );
  });
});

describe('proxyUrlWithCredential', () => {
  it('puts the token in the userinfo of an http proxy URL', () => {
    expect(proxyUrlWithCredential('http://10.10.0.60:3128', 'a.b-c_d')).toBe(
      'http://aw:a.b-c_d@10.10.0.60:3128',
    );
  });

  it('refuses a URL that already has userinfo', () => {
    expect(() => proxyUrlWithCredential('http://u:p@10.10.0.60:3128', 't')).toThrow(/credentials/u);
    expect(() => proxyUrlWithCredential('http://u@10.10.0.60:3128', 't')).toThrow(/credentials/u);
  });

  it('refuses a non-http URL', () => {
    expect(() => proxyUrlWithCredential('https://10.10.0.60:3128', 't')).toThrow(/http:/u);
  });
});

describe('egressAllowlist accepts exactly what the proxy parseAllowlist accepts', () => {
  // Each verdict mirrors packages/egress-proxy parseAllowlist; its own test pins the same entries.
  const entries: readonly (readonly [string, boolean])[] = [
    ['api.example.com', true],
    ['*.example.com', true],
    ['API.Example.COM', true],
    ['10.0.0.1', false],
    ['*.10.0.0.1', false],
    ['*.com', false],
    [`${'a'.repeat(64)}.example.com`, false],
    [`${'a'.repeat(63)}.example.com`, true],
    ['a..b.com', false],
    ['-bad.example.com', false],
  ];
  for (const [entry, accepted] of entries) {
    it(`${accepted ? 'accepts' : 'refuses'} ${entry.slice(0, 40)}`, () => {
      const run = () => egressAllowlist('cloud-run', 'restricted', [entry]);
      if (accepted) expect(run).not.toThrow();
      else expect(run).toThrow(/allowedDomains/u);
    });
  }
});
