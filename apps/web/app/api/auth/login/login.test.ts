import { decodeJwt } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const provider = vi.hoisted(() => ({ reachable: false }));

vi.mock('openid-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('openid-client')>();
  return {
    ...original,
    discovery: (...args: Parameters<typeof original.discovery>) =>
      provider.reachable ? Promise.resolve({}) : original.discovery(...args),
    calculatePKCECodeChallenge: () => Promise.resolve('challenge'),
    buildAuthorizationUrl: () => new URL('https://idp.example.test/authorize'),
  };
});

describe('GET /api/auth/login', () => {
  afterEach(() => {
    provider.reachable = false;
    for (const name of [
      'SESSION_SECRET',
      'OIDC_ISSUER_URL',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_REDIRECT_URI',
    ]) {
      delete process.env[name];
    }
  });

  it('answers 503 rather than attempting discovery when OIDC is not configured', async () => {
    const response = await GET(new Request('https://app.example.test/api/auth/login'));
    expect(response.status).toBe(503);
  });

  it('answers 503 when SESSION_SECRET is missing, even with OIDC configured', async () => {
    process.env['OIDC_ISSUER_URL'] = 'https://idp.example.test';
    process.env['OIDC_CLIENT_ID'] = 'client';
    process.env['OIDC_CLIENT_SECRET'] = 'secret';
    process.env['OIDC_REDIRECT_URI'] = 'https://app.example.test/api/auth/callback';
    const response = await GET(new Request('https://app.example.test/api/auth/login'));
    expect(response.status).toBe(503);
  });

  it('answers 502, not a crash, when the identity provider cannot be reached', async () => {
    process.env['SESSION_SECRET'] = 'a'.repeat(32);
    // Port 9 refuses instantly rather than timing out — the same "unreachable but fast" choice
    // `tests/no-route-answers-503.test.ts` makes for its own runner-URL fixture.
    process.env['OIDC_ISSUER_URL'] = 'http://127.0.0.1:9';
    process.env['OIDC_CLIENT_ID'] = 'client';
    process.env['OIDC_CLIENT_SECRET'] = 'secret';
    process.env['OIDC_REDIRECT_URI'] = 'http://127.0.0.1:9/api/auth/callback';
    const response = await GET(new Request('https://app.example.test/api/auth/login'));
    expect(response.status).toBe(502);

    // BREAK-IT CHECK (done by hand while writing this test, reverted before commit): removing the
    // `try`/`catch` around `beginOidcLogin(...)` in route.ts makes this test fail with an
    // unhandled rejection instead of a clean 502 — which is exactly the defect
    // `tests/no-route-answers-503.test.ts`'s "answers no 5xx other than the 503 a named gap
    // accounts for" assertion caught. Restoring the catch makes it pass again.
  });

  it.each([
    ['/oauth/authorize?client_id=c', '/oauth/authorize?client_id=c'],
    ['//evil.example', undefined],
    ['https://evil.example/', undefined],
  ])('carries only a same-origin next (%s) in the signed transaction', async (next, carried) => {
    provider.reachable = true;
    process.env['SESSION_SECRET'] = 'a'.repeat(32);
    process.env['OIDC_ISSUER_URL'] = 'https://idp.example.test';
    process.env['OIDC_CLIENT_ID'] = 'client';
    process.env['OIDC_CLIENT_SECRET'] = 'secret';
    process.env['OIDC_REDIRECT_URI'] = 'https://app.example.test/api/auth/callback';
    const response = await GET(
      new Request(`https://app.example.test/api/auth/login?next=${encodeURIComponent(next)}`),
    );
    expect(response.status).toBe(303);
    const cookie = response.headers.getSetCookie()[0] ?? '';
    const transaction = cookie.split(';')[0]?.split('=')[1] ?? '';
    expect(decodeJwt(decodeURIComponent(transaction))['next']).toBe(carried);
  });
});
