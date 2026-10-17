import { describe, expect, it } from 'vitest';

import { resolvePublicVisitorIdentity } from './visitor-identity';

const SECRET = 'a-secure-test-secret-with-at-least-32-characters';

function resolve(forwardedFor: string | undefined, hops: string | null = '1') {
  return resolvePublicVisitorIdentity(
    new Headers(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
    { SESSION_SECRET: SECRET, ...(hops === null ? {} : { AW_TRUSTED_PROXY_HOPS: hops }) },
  );
}

describe('public visitor identity', () => {
  it('fails closed when proxy trust is absent or invalid', () => {
    expect(resolve('192.0.2.1', null)).toMatchObject({
      ok: false,
      code: 'visitor_identity_not_configured',
    });
    expect(resolve('192.0.2.1', '0')).toMatchObject({
      ok: false,
      code: 'visitor_identity_not_configured',
    });
    expect(resolve('192.0.2.1', 'several')).toMatchObject({
      ok: false,
      code: 'visitor_identity_not_configured',
    });
  });

  it('selects from the right edge of the trusted proxy chain', () => {
    const direct = resolve('198.51.100.9');
    const spoofedPrefix = resolve('203.0.113.77, 198.51.100.9');
    expect(direct.ok).toBe(true);
    expect(spoofedPrefix).toEqual(direct);

    const twoHops = resolve('198.51.100.9, 192.0.2.10', '2');
    expect(twoHops).toEqual(direct);
  });

  it('canonicalizes IPv6 before deriving the key', () => {
    expect(resolve('2001:0db8:0:0:0:0:0:1')).toEqual(resolve('2001:db8::1'));
  });

  it('returns an opaque deterministic key rather than the raw address', () => {
    const first = resolve('192.0.2.42');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.visitorKey).toMatch(/^v1_[A-Za-z0-9_-]{43}$/u);
    expect(first.visitorKey).not.toContain('192.0.2.42');
    expect(resolve('192.0.2.42')).toEqual(first);
    expect(resolve('192.0.2.43')).not.toEqual(first);
  });

  it('rejects missing, malformed, insufficient and oversized forwarding data', () => {
    expect(resolve(undefined)).toMatchObject({ ok: false, code: 'invalid_forwarded_for' });
    expect(resolve('unknown')).toMatchObject({ ok: false, code: 'invalid_forwarded_for' });
    expect(resolve('192.0.2.1', '2')).toMatchObject({
      ok: false,
      code: 'invalid_forwarded_for',
    });
    expect(resolve(`192.0.2.1,${' '.repeat(2_048)}`)).toMatchObject({
      ok: false,
      code: 'invalid_forwarded_for',
    });
  });
});
