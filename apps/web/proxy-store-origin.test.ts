/**
 * The Agent Store's origin at the edge (`proxy.ts`): which cross-origin calls from the store's
 * page reach a route, and what the answer carries. Driven through `proxy()` with real session
 * tokens: an email-link session and an ordinary one, from the store origin and from another.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { proxy } from './proxy';
import { PASSED_THROUGH, useSessionSecret } from './proxy.test-support';
import {
  mintSessionToken,
  newEmailLinkSessionClaims,
  newSessionClaims,
  sessionCookieName,
} from './server/auth';
import { MIN_SESSION_SECRET_LENGTH } from './server/auth/session';

const STORE = 'https://store.example.test';
const PLATFORM = 'http://127.0.0.1:3000';
const SECRET = 'k'.repeat(MIN_SESSION_SECRET_LENGTH);

describe('the store origin at the edge', () => {
  useSessionSecret();
  let previousBase: string | undefined;
  let guestCookie = '';
  let memberCookie = '';

  beforeAll(async () => {
    previousBase = process.env['AW_EMAIL_LINK_BASE_URL'];
    guestCookie = await mintSessionToken(newEmailLinkSessionClaims('u', 'w'), SECRET);
    memberCookie = await mintSessionToken(newSessionClaims('u', 'w'), SECRET);
  });
  beforeEach(() => {
    process.env['AW_EMAIL_LINK_BASE_URL'] = `${STORE}/signin`;
  });
  afterAll(() => {
    if (previousBase === undefined) delete process.env['AW_EMAIL_LINK_BASE_URL'];
    else process.env['AW_EMAIL_LINK_BASE_URL'] = previousBase;
  });

  const send = (
    method: string,
    pathname: string,
    options: { origin?: string; cookie?: string; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.origin !== undefined) headers['origin'] = options.origin;
    if (options.cookie !== undefined) {
      headers['cookie'] = `${sessionCookieName()}=${options.cookie}`;
    }
    return proxy(new NextRequest(new URL(pathname, PLATFORM), { method, headers }));
  };

  it('lets the pre-session routes through from the store origin, with credentialed CORS', async () => {
    for (const pathname of [
      '/api/auth/email-link',
      '/api/auth/email-link/verify',
      '/api/store/leads',
    ]) {
      const response = await send('POST', pathname, { origin: STORE });
      expect(response.headers.get(PASSED_THROUGH), pathname).toBe('1');
      expect(response.headers.get('access-control-allow-origin'), pathname).toBe(STORE);
      expect(response.headers.get('access-control-allow-credentials'), pathname).toBe('true');
      expect(response.headers.get('vary'), pathname).toContain('origin');
    }
  });

  it('gives no CORS to another origin on a pre-session route', async () => {
    const response = await send('POST', '/api/store/leads', {
      origin: 'https://evil.example.test',
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('serves the privacy facts with no session', async () => {
    const response = await send('GET', '/api/store/privacy');
    expect(response.headers.get(PASSED_THROUGH)).toBe('1');
  });

  it.each([
    ['GET', '/api/me'],
    ['GET', '/api/agents'],
    ['POST', '/api/agents/a1/runs'],
    ['GET', '/api/runs'],
    ['GET', '/api/runs?limit=50'],
    ['GET', '/api/runs/r1'],
    ['GET', '/api/runs/r1/events'],
    ['POST', '/api/runs/r1/approval'],
    ['POST', '/api/runs/r1/interrupt'],
    ['GET', '/api/demo/allowance'],
  ])('lets an email-link session call %s %s from the store origin', async (method, pathname) => {
    const response = await send(method, pathname, { origin: STORE, cookie: guestCookie });
    expect(response.headers.get(PASSED_THROUGH)).toBe('1');
    expect(response.headers.get('access-control-allow-origin')).toBe(STORE);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it.each([
    ['POST', '/api/agents/a1/runs'],
    ['POST', '/api/runs/r1/approval'],
    ['POST', '/api/runs/r1/interrupt'],
  ])(
    'refuses a session that is not an email-link one writing %s %s from the store origin',
    async (method, pathname) => {
      const response = await send(method, pathname, { origin: STORE, cookie: memberCookie });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'cross_origin',
      );
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    },
  );

  it("lets the store read a signed-out visitor's 401 on a guest-session route", async () => {
    for (const [method, pathname] of [
      ['GET', '/api/demo/allowance'],
      ['GET', '/api/runs'],
      ['POST', '/api/agents/a1/runs'],
    ] as const) {
      for (const cookie of [undefined, 'not-a-session-token']) {
        const response = await send(method, pathname, {
          origin: STORE,
          ...(cookie === undefined ? {} : { cookie }),
        });
        const label = `${method} ${pathname} cookie=${String(cookie)}`;
        expect(response.status, label).toBe(401);
        expect(response.headers.get(PASSED_THROUGH), label).toBeNull();
        expect(response.headers.get('access-control-allow-origin'), label).toBe(STORE);
        expect(response.headers.get('access-control-allow-credentials'), label).toBe('true');
      }
    }
  });

  it('gives no CORS to a signed-out request from another origin, or one carrying a credential', async () => {
    const other = await send('GET', '/api/runs', { origin: 'https://evil.example.test' });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const keyed = await send('GET', '/api/runs', {
      origin: STORE,
      headers: { authorization: 'Bearer ak_live_00000000000000000000000000000000' },
    });
    expect(keyed.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('gives a member session no CORS on a read from the store origin either', async () => {
    for (const pathname of ['/api/me', '/api/runs']) {
      const response = await send('GET', pathname, { origin: STORE, cookie: memberCookie });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it.each([
    ['POST', '/api/agents'],
    ['DELETE', '/api/agents/a1'],
    ['POST', '/api/memberships'],
    ['POST', '/api/workspaces'],
  ])(
    'refuses an email-link session writing %s %s from the store origin',
    async (method, pathname) => {
      const response = await send(method, pathname, { origin: STORE, cookie: guestCookie });
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    },
  );

  it('refuses an email-link session writing from any other origin', async () => {
    const response = await send('POST', '/api/agents/a1/runs', {
      origin: 'https://evil.example.test',
      cookie: guestCookie,
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a preflight for a store route with credentials, content-type and the contracts header', async () => {
    const response = await send('OPTIONS', '/api/runs/r1/approval', {
      origin: STORE,
      headers: { 'access-control-request-method': 'POST' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(STORE);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-methods')).toBe('POST');
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'content-type, x-agent-workspace-contracts, last-event-id',
    );
  });

  it('answers no grant to a preflight from another origin or for a route outside the sets', async () => {
    for (const [origin, pathname, method] of [
      ['https://evil.example.test', '/api/store/leads', 'POST'],
      [STORE, '/api/memberships', 'POST'],
      [STORE, '/api/agents/a1', 'DELETE'],
    ] as const) {
      const response = await send('OPTIONS', pathname, {
        origin,
        headers: { 'access-control-request-method': method },
      });
      expect(
        response.headers.get('access-control-allow-origin'),
        `${origin} ${pathname}`,
      ).toBeNull();
    }
  });

  it('grants nothing at all while the base URL is unset', async () => {
    delete process.env['AW_EMAIL_LINK_BASE_URL'];
    for (const pathname of ['/api/store/leads', '/api/auth/email-link']) {
      const response = await send('POST', pathname, { origin: STORE });
      expect(response.headers.get('access-control-allow-origin'), pathname).toBeNull();
    }
    const preflight = await send('OPTIONS', '/api/store/leads', {
      origin: STORE,
      headers: { 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    const guest = await send('POST', '/api/agents/a1/runs', { origin: STORE, cookie: guestCookie });
    expect(guest.status).toBe(403);
    expect(guest.headers.get('access-control-allow-origin')).toBeNull();
  });
});
