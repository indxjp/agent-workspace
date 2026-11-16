import { describe, expect, it } from 'vitest';

import { checkRequestOrigin } from './origin';
import {
  storeOriginFor,
  storeOriginOf,
  storePreflightAllowed,
  storePreflightHeaders,
  storeResponseHeaders,
  storeRouteKind,
  type StoreRequestFacts,
} from './store-origin';

const STORE = 'https://store.example.test';
const BASE = `${STORE}/signin`;

const PRE_SESSION = [
  ['POST', '/api/auth/email-link'],
  ['POST', '/api/auth/email-link/verify'],
  ['POST', '/api/store/leads'],
] as const;

const GUEST_SESSION = [
  ['GET', '/api/me'],
  ['GET', '/api/agents'],
  ['POST', '/api/agents/abc/runs'],
  ['GET', '/api/runs'],
  ['GET', '/api/runs/abc'],
  ['GET', '/api/runs/abc/events'],
  ['POST', '/api/runs/abc/approval'],
  ['POST', '/api/runs/abc/interrupt'],
  ['GET', '/api/demo/allowance'],
] as const;

const facts = (over: Partial<StoreRequestFacts>): StoreRequestFacts => ({
  origin: STORE,
  baseUrl: BASE,
  method: 'POST',
  pathname: '/api/store/leads',
  via: null,
  ...over,
});

describe('storeOriginOf', () => {
  it('is the origin of the base URL, whatever path it carries', () => {
    expect(storeOriginOf(BASE)).toBe(STORE);
    expect(storeOriginOf('http://localhost:8445/')).toBe('http://localhost:8445');
  });

  it.each([undefined, '', '   ', 'not a url', 'ftp://store.example.test', 'javascript:alert(1)'])(
    'is null for %j, so nothing is allowed',
    (value) => {
      expect(storeOriginOf(value)).toBeNull();
    },
  );
});

describe('the two route sets', () => {
  it.each(PRE_SESSION)('%s %s is pre-session', (method, pathname) => {
    expect(storeRouteKind(method, pathname)).toBe('pre-session');
  });

  it.each(GUEST_SESSION)('%s %s is guest-session', (method, pathname) => {
    expect(storeRouteKind(method, pathname)).toBe('guest-session');
  });

  it.each([
    ['DELETE', '/api/agents/abc'],
    ['POST', '/api/agents'],
    ['GET', '/api/agents/abc/runs'],
    ['PATCH', '/api/runs/abc'],
    ['POST', '/api/memberships'],
    ['POST', '/api/workspaces'],
    ['GET', '/api/api-keys'],
    ['GET', '/api/store/leads'],
    ['POST', '/api/runs/abc/events'],
    ['GET', '/api/runs/abc/def/events'],
    ['POST', '/api/auth/workspace'],
    ['GET', '/'],
  ])('%s %s is in neither', (method, pathname) => {
    expect(storeRouteKind(method, pathname)).toBeNull();
  });
});

describe('storeOriginFor', () => {
  it.each(PRE_SESSION)('allows the store origin on %s %s with no session', (method, pathname) => {
    expect(storeOriginFor(facts({ method, pathname }))).toBe(STORE);
  });

  it.each(GUEST_SESSION)(
    'allows the store origin on %s %s for an email-link session',
    (method, pathname) => {
      expect(storeOriginFor(facts({ method, pathname, via: 'email_link' }))).toBe(STORE);
    },
  );

  it.each(GUEST_SESSION)(
    'refuses the store origin on %s %s with another or no session',
    (method, pathname) => {
      expect(storeOriginFor(facts({ method, pathname, via: null }))).toBeNull();
    },
  );

  it('refuses any other origin, even on a pre-session route', () => {
    for (const origin of [
      'https://evil.example.test',
      'https://store.example.test.evil.test',
      'http://store.example.test',
      'https://store.example.test:8443',
      'null',
      null,
    ]) {
      expect(storeOriginFor(facts({ origin })), String(origin)).toBeNull();
    }
  });

  it('refuses everything when the base URL is unset', () => {
    expect(storeOriginFor(facts({ baseUrl: undefined }))).toBeNull();
    expect(
      storeOriginFor(
        facts({ baseUrl: undefined, method: 'GET', pathname: '/api/me', via: 'email_link' }),
      ),
    ).toBeNull();
  });

  it('refuses a route outside both sets, whatever the session', () => {
    expect(storeOriginFor(facts({ pathname: '/api/memberships', via: 'email_link' }))).toBeNull();
    expect(
      storeOriginFor(facts({ method: 'DELETE', pathname: '/api/agents/abc', via: 'email_link' })),
    ).toBeNull();
  });
});

describe('the origin check with the store origin allowed', () => {
  const base = {
    method: 'POST',
    requestHost: 'platform.example.test',
    hostHeader: 'platform.example.test',
  };

  it('passes the exact store origin and no other origin', () => {
    expect(checkRequestOrigin({ ...base, origin: STORE, allowedOrigins: [STORE] }).ok).toBe(true);
    for (const origin of [
      'https://evil.example.test',
      'http://store.example.test',
      'https://store.example.test:8443',
    ]) {
      expect(checkRequestOrigin({ ...base, origin, allowedOrigins: [STORE] }).ok, origin).toBe(
        false,
      );
    }
  });

  it('refuses the store origin when it was not allowed for this request', () => {
    expect(checkRequestOrigin({ ...base, origin: STORE }).ok).toBe(false);
    expect(checkRequestOrigin({ ...base, origin: STORE, allowedOrigins: [] }).ok).toBe(false);
  });

  it('still refuses an absent Origin on a write', () => {
    expect(checkRequestOrigin({ ...base, origin: null, allowedOrigins: [STORE] }).ok).toBe(false);
  });
});

describe('the preflight and response headers', () => {
  it('answers a preflight for a route the store may call, from the store only', () => {
    expect(storePreflightAllowed(STORE, BASE, 'POST', '/api/store/leads')).toBe(true);
    expect(storePreflightAllowed(STORE, BASE, 'GET', '/api/me')).toBe(true);
    expect(storePreflightAllowed(STORE, BASE, 'DELETE', '/api/agents/abc')).toBe(false);
    expect(storePreflightAllowed(STORE, BASE, 'GET', '/api/store/leads')).toBe(false);
    expect(
      storePreflightAllowed('https://evil.example.test', BASE, 'POST', '/api/store/leads'),
    ).toBe(false);
    expect(storePreflightAllowed(STORE, undefined, 'POST', '/api/store/leads')).toBe(false);
    expect(storePreflightAllowed(STORE, BASE, null, '/api/store/leads')).toBe(false);
  });

  it('allows credentials, content-type, the contracts header and last-event-id, for exactly one origin', () => {
    expect(storePreflightHeaders(STORE, 'post')).toEqual({
      'cache-control': 'no-store',
      'access-control-allow-origin': STORE,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type, x-agent-workspace-contracts, last-event-id',
      'access-control-max-age': '600',
      vary: 'origin',
    });
    const headers = storeResponseHeaders(STORE);
    expect(headers['access-control-allow-origin']).toBe(STORE);
    expect(headers['access-control-allow-credentials']).toBe('true');
    expect(headers['vary']).toBe('origin');
    expect(headers['access-control-expose-headers']).toContain('retry-after');
  });
});
