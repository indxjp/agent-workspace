/**
 * Issue #394: two deployments on one host (`localhost:3000` and `localhost:3002`) share a cookie
 * jar, because browsers scope cookies by host and not by port. Under one fixed cookie name each
 * sign-in overwrote the other's session. A deployment with `AW_INSTANCE_ID` names its own cookie,
 * and every reader and writer agrees on that name.
 */
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { proxy } from '../../proxy';
import { sessionCookieValue } from '../composition/identity';
import {
  clearedInvitationIdentityCookie,
  clearedSelectionCookie,
  invitationIdentityCookie,
  invitationIdentityCookieName,
  oidcTransactionCookieName,
  selectionCookie,
  selectionCookieName,
} from '.';
import {
  clearedSessionCookie,
  DEFAULT_SESSION_COOKIE_NAME,
  MIN_SESSION_SECRET_LENGTH,
  mintSessionToken,
  newSessionClaims,
  sessionCookie,
  scopedCookieName,
  sessionCookieName,
} from './session';

const SECRET = 'k'.repeat(MIN_SESSION_SECRET_LENGTH);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the session cookie name', () => {
  it('keeps the existing name when no instance id is configured, so sessions survive an upgrade', () => {
    expect(sessionCookieName({})).toBe('__Host-aw_session');
    expect(sessionCookieName({ AW_INSTANCE_ID: '  ' })).toBe(DEFAULT_SESSION_COOKIE_NAME);
  });

  it('is scoped per deployment, and two projects never share a name', () => {
    expect(sessionCookieName({ AW_INSTANCE_ID: 'acme-ai' })).toBe('__Host-aw_session_acme-ai');
    expect(sessionCookieName({ AW_INSTANCE_ID: 'acme-ai' })).not.toBe(
      sessionCookieName({ AW_INSTANCE_ID: 'other_project' }),
    );
  });

  it.each(['Acme', '-acme', 'acme ai', 'acme;x=1', 'acme=1', 'a'.repeat(64), 'b'.repeat(200)])(
    'derives a safe, distinct name from %j instead of failing every request',
    (instanceId) => {
      const name = sessionCookieName({ AW_INSTANCE_ID: instanceId });
      const suffix = name.slice(`${DEFAULT_SESSION_COOKIE_NAME}_`.length);
      expect(name.startsWith(`${DEFAULT_SESSION_COOKIE_NAME}_`)).toBe(true);
      expect(suffix).toMatch(/^[a-z0-9][a-z0-9_-]{0,62}$/u);
      expect(suffix).toMatch(/[0-9a-f]{8}$/u);
    },
  );

  it('keeps two over-long ids that share a prefix apart', () => {
    const one = sessionCookieName({ AW_INSTANCE_ID: `${'a'.repeat(70)}one` });
    const two = sessionCookieName({ AW_INSTANCE_ID: `${'a'.repeat(70)}two` });
    expect(one).not.toBe(two);
  });

  it('scopes every auth cookie with the same suffix, through one helper', () => {
    const env = { AW_INSTANCE_ID: 'acme-ai' };
    expect(scopedCookieName('__Host-aw_workspace_selection', env)).toBe(
      '__Host-aw_workspace_selection_acme-ai',
    );
    expect(scopedCookieName('aw_oidc_transaction', {})).toBe('aw_oidc_transaction');
    vi.stubEnv('AW_INSTANCE_ID', 'acme-ai');
    expect(selectionCookieName()).toBe('__Host-aw_workspace_selection_acme-ai');
    expect(invitationIdentityCookieName()).toBe('__Host-aw_invitation_identity_acme-ai');
    expect(oidcTransactionCookieName()).toBe('aw_oidc_transaction_acme-ai');
    for (const cookie of [
      selectionCookie('t'),
      clearedSelectionCookie(),
      invitationIdentityCookie('t'),
      clearedInvitationIdentityCookie(),
    ]) {
      expect(cookie.name.endsWith('_acme-ai')).toBe(true);
      expect(cookie.name.startsWith('__Host-')).toBe(true);
      expect(cookie.secure).toBe(true);
      expect(cookie.path).toBe('/');
      expect(cookie).not.toHaveProperty('domain');
    }
  });

  it('sets and clears the scoped cookie under every __Host- rule', () => {
    vi.stubEnv('AW_INSTANCE_ID', 'acme-ai');
    for (const cookie of [sessionCookie('token'), clearedSessionCookie()]) {
      expect(cookie.name).toBe('__Host-aw_session_acme-ai');
      expect(cookie.name.startsWith('__Host-')).toBe(true);
      expect(cookie.secure).toBe(true);
      expect(cookie.path).toBe('/');
      expect(cookie).not.toHaveProperty('domain');
    }
  });

  it("reads this deployment's cookie from a raw Cookie header and ignores another's", () => {
    vi.stubEnv('AW_INSTANCE_ID', 'acme-ai');
    const header =
      '__Host-aw_session_other=theirs; __Host-aw_session=legacy; __Host-aw_session_acme-ai=ours';
    expect(sessionCookieValue(header)).toBe('ours');
    expect(sessionCookieValue('__Host-aw_session_other=theirs')).toBeUndefined();
  });

  it("admits a request on this deployment's cookie, and refuses one carrying only another's", async () => {
    vi.stubEnv('SESSION_SECRET', SECRET);
    vi.stubEnv('AW_INSTANCE_ID', 'acme-ai');
    const token = await mintSessionToken(newSessionClaims('owner@example.test', 'default'), SECRET);
    const request = (cookie: string) =>
      new NextRequest(new URL('/api/me', 'http://localhost:3000'), { headers: { cookie } });

    const own = await proxy(request(`__Host-aw_session_acme-ai=${token}`));
    expect(own.headers.get('x-middleware-next')).toBe('1');

    const another = await proxy(request(`__Host-aw_session_other=${token}`));
    expect(another.status).toBe(401);
  });
});
