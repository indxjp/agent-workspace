import { describe, expect, it } from 'vitest';

import { AllowlistError, isHostAllowed, normalizeHost, parseAllowlist } from './allowlist.js';

function allows(entries: readonly string[], host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized !== null && isHostAllowed(parseAllowlist(entries), normalized);
}

describe('allowlist matching', () => {
  it('matches an exact host, case-insensitively and ignoring a trailing dot', () => {
    expect(allows(['api.example.com'], 'api.example.com')).toBe(true);
    expect(allows(['API.Example.com'], 'api.example.COM.')).toBe(true);
    expect(allows(['api.example.com'], 'example.com')).toBe(false);
    expect(allows(['api.example.com'], 'v2.api.example.com')).toBe(false);
  });

  it('matches *.suffix against subdomains only, never the apex or a look-alike', () => {
    const entries = ['*.example.com'];
    expect(allows(entries, 'a.example.com')).toBe(true);
    expect(allows(entries, 'a.b.example.com')).toBe(true);
    expect(allows(entries, 'example.com')).toBe(false);
    expect(allows(entries, 'badexample.com')).toBe(false);
    expect(allows(entries, 'example.com.evil.test')).toBe(false);
  });

  it('allows any host for *', () => {
    expect(allows(['*'], 'anything.example')).toBe(true);
  });

  it('never matches an IP literal against a host list', () => {
    expect(allows(['example.com'], '93.184.216.34')).toBe(false);
  });

  it.each([
    ['', 'the allowlist is empty'],
    ['10.0.0.1', 'must be a host name'],
    ['::1', 'must be a host name'],
    ['*.com', 'must be a host name'],
    ['*.', 'must be a host name'],
    ['exa*mple.com', 'must be a host name'],
    ['**.example.com', 'must be a host name'],
    ['example.com:443', 'must be a host name'],
    ['https://example.com', 'must be a host name'],
    ['bücher.example', 'must be a host name'],
  ])('rejects the entry %j', (entry, message) => {
    const entries = entry === '' ? [] : [entry];
    expect(() => parseAllowlist(entries)).toThrow(AllowlistError);
    expect(() => parseAllowlist(entries)).toThrow(message);
  });
});

describe('normalizeHost', () => {
  it('strips IPv6 brackets and keeps IP literals as they are', () => {
    expect(normalizeHost('[::1]')).toBe('::1');
    expect(normalizeHost('169.254.169.254')).toBe('169.254.169.254');
  });

  it.each([
    '',
    '.',
    'a..b',
    '-a.example',
    'a b.example',
    `${'a'.repeat(64)}.example`,
    'ex%41mple.com',
  ])('refuses %j', (host) => {
    expect(normalizeHost(host)).toBeNull();
  });
});
