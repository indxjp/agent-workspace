import { describe, expect, it } from 'vitest';
import {
  MIN_SESSION_SECRET_LENGTH,
  sessionCookieName,
  SESSION_TTL_SECONDS,
  clearedSessionCookie,
  mintSessionToken,
  newSessionClaims,
  readSessionSecret,
  sessionCookie,
  verifySessionToken,
} from '../apps/web/server/auth/session.js';

const SECRET = 'a'.repeat(MIN_SESSION_SECRET_LENGTH);

describe('readSessionSecret', () => {
  it('fails closed when the secret is absent, blank or short', () => {
    for (const env of [
      {},
      { SESSION_SECRET: '' },
      { SESSION_SECRET: '   ' },
      { SESSION_SECRET: 'short' },
    ]) {
      const result = readSessionSecret(env);
      expect(result.ok, JSON.stringify(env)).toBe(false);
      if (!result.ok) expect(result.reason).toContain('SESSION_SECRET');
    }
  });

  it('accepts a secret at the minimum length', () => {
    expect(readSessionSecret({ SESSION_SECRET: SECRET })).toEqual({ ok: true, secret: SECRET });
  });
});

describe('verifySessionToken', () => {
  it('round-trips a minted token', async () => {
    const claims = newSessionClaims('admin@example.com', 'default');
    const token = await mintSessionToken(claims, SECRET);
    const result = await verifySessionToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims).toEqual(claims);
  });

  it('rejects an absent cookie by name', async () => {
    for (const absent of [undefined, null, '']) {
      const result = await verifySessionToken(absent, SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('no_session_cookie');
    }
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await mintSessionToken(newSessionClaims('admin@example.com', 'default'), SECRET);
    const result = await verifySessionToken(token, 'b'.repeat(MIN_SESSION_SECRET_LENGTH));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_signature');
  });

  it('rejects a tampered payload', async () => {
    const token = await mintSessionToken(newSessionClaims('admin@example.com', 'default'), SECRET);
    const parts = token.split('.');
    const forged = JSON.stringify({
      sub: 'attacker@example.com',
      ws: 'other-workspace',
      role: 'owner',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const swapped = `${parts[0] ?? ''}.${Buffer.from(forged).toString('base64url')}.${parts[2] ?? ''}`;
    const result = await verifySessionToken(swapped, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_signature');
  });

  it('rejects a token whose version tag is not this build’s', async () => {
    const token = await mintSessionToken(newSessionClaims('admin@example.com', 'default'), SECRET);
    const result = await verifySessionToken(token.replace(/^aw1\./u, 'aw2.'), SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('malformed_session');
  });

  it('rejects a structurally wrong token without throwing', async () => {
    for (const bad of ['x', 'a.b', 'a.b.c.d', 'aw1..', 'aw1.$$$.$$$', 42, {}, []]) {
      const result = await verifySessionToken(bad, SECRET);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects an expired session', async () => {
    const issuedAt = Date.now() - (SESSION_TTL_SECONDS + 60) * 1000;
    const token = await mintSessionToken(
      newSessionClaims('admin@example.com', 'default', issuedAt),
      SECRET,
    );
    const result = await verifySessionToken(token, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('expired_session');
  });

  /**
   * ADR-0015, the exact bug named there: `NaN < Date.now()` is `false`, so a comparison reached
   * with an unparsed expiry reads as "not expired" and the gate fails open. These tokens are
   * correctly signed — the MAC is not what is being tested — so the only thing standing between
   * them and a valid session is that `exp` is parsed and type-checked before it is compared.
   */
  it('rejects a correctly signed token whose exp is missing, non-numeric or NaN', async () => {
    const base = {
      sub: 'admin@example.com',
      ws: 'default',
      role: 'owner',
      iat: Math.floor(Date.now() / 1000),
    };
    const payloads: readonly Record<string, unknown>[] = [
      { ...base },
      { ...base, exp: null },
      { ...base, exp: 'tomorrow' },
      { ...base, exp: Number.NaN },
      { ...base, exp: Number.POSITIVE_INFINITY },
      { ...base, exp: {} },
      { ...base, iat: Number.NaN, exp: base.iat + 60 },
      { ...base, role: 'admin', exp: base.iat + 60 },
      { ...base, sub: '', exp: base.iat + 60 },
      { ...base, ws: 42, exp: base.iat + 60 },
      { ...base, exp: base.iat + SESSION_TTL_SECONDS * 10 },
    ];
    for (const payload of payloads) {
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signed = `aw1.${encoded}`;
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signature = Buffer.from(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed)),
      ).toString('base64url');
      const result = await verifySessionToken(`${signed}.${signature}`, SECRET);
      expect(result.ok, JSON.stringify(payload)).toBe(false);
      if (!result.ok) expect(result.code).toBe('malformed_session');
    }
  });

  it('rejects a payload that is valid JSON but not an object', async () => {
    for (const scalar of ['"hello"', '42', 'null', '[1,2]']) {
      const encoded = Buffer.from(scalar).toString('base64url');
      const signed = `aw1.${encoded}`;
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signature = Buffer.from(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed)),
      ).toString('base64url');
      const result = await verifySessionToken(`${signed}.${signature}`, SECRET);
      expect(result.ok, scalar).toBe(false);
    }
  });
});

describe('the session cookie', () => {
  it('is __Host-, HttpOnly, Secure, SameSite=Lax and Path=/', () => {
    const cookie = sessionCookie('token');
    expect(cookie.name).toBe('__Host-aw_session');
    expect(cookie.name).toBe(sessionCookieName());
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe('lax');
    expect(cookie.path).toBe('/');
    expect(cookie.maxAge).toBe(SESSION_TTL_SECONDS);
  });

  it('clears with the same attributes and a zero lifetime', () => {
    const cleared = clearedSessionCookie();
    expect(cleared.name).toBe(sessionCookieName());
    expect(cleared.value).toBe('');
    expect(cleared.maxAge).toBe(0);
    expect(cleared.secure).toBe(true);
  });
});
