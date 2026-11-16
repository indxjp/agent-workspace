import { describe, expect, it } from 'vitest';
import { POST as REVOKE } from '../../app/oauth/revoke/route';
import { POST as TOKEN } from '../../app/oauth/token/route';
import { clearClientIdentity, installClientIdentity } from '../client-identity';
import { admitOAuthAddress, OAUTH_RATE_LIMITS } from './limits';
import { basic, fixture, PROXY_TEST_SECRET, send, tokenRequest } from './oauth-server.test-support';
import { mintClientSecret } from './tokens';

describe('rate limits on /oauth/*', () => {
  const from = (ip: string, pass: string, path = '/oauth/token') =>
    tokenRequest(
      path === '/oauth/token' ? { grant_type: 'client_credentials' } : { token: 'x' },
      { 'x-forwarded-for': ip, ...basic(fixture.mcp.id, pass) },
      path,
    );
  // Cleared after each test by oauth-server.test-support.ts.
  const behindProxy = (): void => {
    installClientIdentity({ trustedProxyHops: 1, sessionSecret: PROXY_TEST_SECRET });
  };

  it(
    'counts a client only once it authenticated: the 61st authenticated request is 429',
    countsClientOnlyOnceItAuthenticated61stAuthenticated,
  );

  it('does not let failed authentications from one address lock a client out for another', async () => {
    behindProxy();
    const wrong = (await mintClientSecret()).presented;
    for (let i = 0; i <= OAUTH_RATE_LIMITS.perClientPerMinute; i += 1) {
      await send(from('203.0.113.20', wrong), TOKEN);
    }
    const real = await send(from('203.0.113.21', fixture.secret), TOKEN);
    expect(real.response.status).toBe(200);
  });

  it('throttles repeated failed authentications from one address', async () => {
    behindProxy();
    const wrong = (await mintClientSecret()).presented;
    for (let i = 0; i < OAUTH_RATE_LIMITS.failedAuthPerAddressPerMinute; i += 1) {
      const out = await send(from('203.0.113.30', wrong), TOKEN);
      expect(out.response.status).toBe(401);
    }
    // Even the right secret is refused before it is checked, so guessing is bounded.
    const limited = await send(from('203.0.113.30', fixture.secret), TOKEN);
    expect(limited.response.status).toBe(429);
    expect(limited.response.headers.get('retry-after')).not.toBeNull();
    const other = await send(from('203.0.113.31', fixture.secret), TOKEN);
    expect(other.response.status).toBe(200);
  });

  it('applies the same counters to revoke', async () => {
    behindProxy();
    const wrong = (await mintClientSecret()).presented;
    for (let i = 0; i < OAUTH_RATE_LIMITS.failedAuthPerAddressPerMinute; i += 1) {
      await send(from('203.0.113.40', wrong, '/oauth/revoke'), REVOKE);
    }
    const throttled = await send(from('203.0.113.40', fixture.secret, '/oauth/revoke'), REVOKE);
    expect(throttled.response.status).toBe(429);
    const other = await send(from('203.0.113.41', fixture.secret, '/oauth/revoke'), REVOKE);
    expect(other.response.status).toBe(200);
    for (let i = 1; i < OAUTH_RATE_LIMITS.perClientPerMinute; i += 1) {
      await send(from('203.0.113.41', fixture.secret, '/oauth/revoke'), REVOKE);
    }
    const limited = await send(from('203.0.113.41', fixture.secret, '/oauth/revoke'), REVOKE);
    expect(limited.response.status).toBe(429);
  });

  it(
    'limits an address across clients, and another address keeps its own budget',
    limitsAddressAcrossClientsAnotherAddressKeepsOwn,
  );

  it(
    'refuses before anything is looked up when the address is over its limit',
    refusesBeforeAnythingIsLookedUpWhenAddress,
  );
});

async function countsClientOnlyOnceItAuthenticated61stAuthenticated() {
  for (let i = 0; i < OAUTH_RATE_LIMITS.perClientPerMinute; i += 1) {
    const out = await send(
      tokenRequest({ grant_type: 'client_credentials' }, basic(fixture.mcp.id, fixture.secret)),
      TOKEN,
    );
    expect(out.response.status).toBe(200);
  }
  const limited = await send(
    tokenRequest({ grant_type: 'client_credentials' }, basic(fixture.mcp.id, fixture.secret)),
    TOKEN,
  );
  expect(limited.response.status).toBe(429);
  expect(limited.response.headers.get('retry-after')).not.toBeNull();
  expect(limited.json()).toMatchObject({ error: 'temporarily_unavailable' });
  // Another client is not limited by this one's requests.
  const other = await send(
    tokenRequest({ grant_type: 'client_credentials', client_id: fixture.a2a.id }),
    TOKEN,
  );
  expect(other.response.status).toBe(400);
}

function limitsAddressAcrossClientsAnotherAddressKeepsOwn() {
  const at = (ip: string) => new Headers({ 'x-forwarded-for': ip });
  const identity = { trustedProxyHops: 1, sessionSecret: PROXY_TEST_SECRET };
  for (let i = 0; i < OAUTH_RATE_LIMITS.perAddressPerMinute; i += 1) {
    expect(admitOAuthAddress(at('203.0.113.7'), 0, identity).admitted).toBe(true);
  }
  const refused = admitOAuthAddress(at('203.0.113.7'), 0, identity);
  expect(refused.admitted).toBe(false);
  expect(admitOAuthAddress(at('203.0.113.8'), 0, identity).admitted).toBe(true);
}

async function refusesBeforeAnythingIsLookedUpWhenAddress() {
  installClientIdentity({ trustedProxyHops: 1, sessionSecret: PROXY_TEST_SECRET });
  try {
    const headers = { 'x-forwarded-for': '203.0.113.9' };
    for (let i = 0; i < OAUTH_RATE_LIMITS.perAddressPerMinute; i += 1) {
      admitOAuthAddress(new Headers(headers), Date.now());
    }
    const out = await send(
      tokenRequest(
        { grant_type: 'client_credentials' },
        { ...headers, ...basic(fixture.mcp.id, fixture.secret) },
      ),
      TOKEN,
    );
    expect(out.response.status).toBe(429);
    expect(fixture.rows).toEqual([]);
  } finally {
    clearClientIdentity();
  }
}
