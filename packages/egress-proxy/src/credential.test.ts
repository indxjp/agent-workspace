import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyCredential } from './credential.js';

/** Signs any claims the way the runner manager does; the verifier is the code under test. */
function signPayload(key: Buffer, payload: string): string {
  return `${payload}.${createHmac('sha256', key).update(payload, 'ascii').digest('base64url')}`;
}

function signCredential(key: Buffer, claims: unknown): string {
  return signPayload(key, Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url'));
}

const KEY = Buffer.from('aw-egress-test-key-0123456789abcdef');
const VECTOR =
  'eyJzaWQiOiJzZXNzLTEiLCJleHAiOjIwMDAwMDAwMDAsImhvc3RzIjpbImFwaS5leGFtcGxlLmNvbSIsIiouZXhhbXBsZS5vcmciXX0.98sly0lpHkLIwb3VH0M22Gd6QzMhyMXg2XfpmQ2PMew';
const NOW = 1_900_000_000;
const basic = (token: string, user = 'aw'): string =>
  `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
const claims = { sid: 'sess-1', exp: 2_000_000_000, hosts: ['api.example.com', '*.example.org'] };
const reason = (header: string | undefined, key = KEY): unknown => {
  const verdict = verifyCredential(header, key, NOW);
  return verdict.ok ? 'ok' : verdict.reason;
};

describe('verifyCredential', () => {
  it('signs to the shared test vector and verifies it', () => {
    expect(signCredential(KEY, claims)).toBe(VECTOR);
    const verdict = verifyCredential(basic(VECTOR), KEY, NOW);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.sid).toBe('sess-1');
    expect(verdict.allowlist.exact.has('api.example.com')).toBe(true);
    expect(verdict.allowlist.suffixes).toEqual(['.example.org']);
  });

  it('accepts a credential that expires exactly now and refuses one a second later', () => {
    const token = signCredential(KEY, { ...claims, exp: NOW });
    expect(verifyCredential(basic(token), KEY, NOW).ok).toBe(true);
    expect(verifyCredential(basic(token), KEY, NOW + 1)).toEqual({
      ok: false,
      reason: 'credential_expired',
    });
  });

  it('accepts the open policy', () => {
    const verdict = verifyCredential(
      basic(signCredential(KEY, { ...claims, hosts: ['*'] })),
      KEY,
      NOW,
    );
    expect(verdict.ok && verdict.allowlist.anyHost).toBe(true);
  });

  const [payload = '', signature = ''] = VECTOR.split('.');
  const altered = Buffer.from(JSON.stringify({ ...claims, hosts: ['evil.example'] })).toString(
    'base64url',
  );
  const invalid: readonly [string, string | undefined][] = [
    ['a forged signature', basic(`${payload}.${signature.slice(0, -2)}AA`)],
    ['a payload altered after signing', basic(`${altered}.${signature}`)],
    ['a non-Basic scheme', `Bearer ${VECTOR}`],
    ['a wrong username', basic(VECTOR, 'user')],
    ['a missing signature', basic(payload)],
    ['an extra segment', basic(`${VECTOR}.x`)],
    ['malformed base64 in the header', 'Basic !!!'],
    ['a short signature', basic(`${payload}.AAAA`)],
    ['a non-base64url payload', basic('a b.c')],
  ];
  it.each(invalid)('refuses %s', (_name, header) => {
    expect(reason(header)).toBe('credential_invalid');
  });

  it('refuses a non-canonical signature that differs only in its unused trailing bits', () => {
    const [payload, signature] = VECTOR.split('.');
    const last = signature?.at(-1) ?? '';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    // The last of 43 characters carries 4 data bits; flipping only the low 2 bits keeps the HMAC.
    const sibling = alphabet.charAt(alphabet.indexOf(last) ^ 1);
    expect(reason(basic(VECTOR))).toBe('ok');
    expect(reason(basic(`${payload ?? ''}.${signature?.slice(0, -1) ?? ''}${sibling}`))).toBe(
      'credential_invalid',
    );
  });

  it('refuses a wrong key', () => {
    expect(reason(basic(VECTOR), Buffer.from('another-key-another-key-another-key!'))).toBe(
      'credential_invalid',
    );
  });

  it.each([undefined, ''])('asks for a credential when the header is %j', (header) => {
    expect(reason(header)).toBe('credential_required');
  });

  const bad: readonly [string, unknown][] = [
    ['an empty hosts list', { ...claims, hosts: [] }],
    ['a * mixed with another entry', { ...claims, hosts: ['*', 'a.example'] }],
    ['a * inside an entry', { ...claims, hosts: ['a*.example'] }],
    ['a non-string host', { ...claims, hosts: [1] }],
    ['an IP address host', { ...claims, hosts: ['10.0.0.1'] }],
    ['an empty sid', { ...claims, sid: '' }],
    ['a fractional exp', { ...claims, exp: 1.5 }],
    ['a string exp', { ...claims, exp: '2000000000' }],
    ['a JSON array', []],
    ['a JSON string', 'x'],
  ];
  it.each(bad)('refuses signed claims with %s', (_name, value) => {
    const signed = signCredential(KEY, value);
    expect(reason(basic(signed))).toBe('credential_invalid');
  });

  it('refuses a signed payload that is not JSON', () => {
    const signed = signPayload(KEY, Buffer.from('not json').toString('base64url'));
    expect(reason(basic(signed))).toBe('credential_invalid');
  });
});
