/**
 * Golden values for the session token and cookies (refactoring part 06, step 2): written before
 * the pure rules moved to `./core/`, and unchanged after, so the move cannot change a byte. Step 5
 * changed one thing on purpose, the key the MAC is made with, and pins both MACs below.
 */
import { hkdfSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  clearedSignInSessionCookie,
  mintSignInSessionToken,
  newEmailLinkSignInSessionClaims,
  newSignInSessionClaims,
  SIGN_IN_SESSION_TTL_SECONDS,
  signInSessionCookie,
  verifySignInSessionToken,
} from './session';

const SECRET = 'golden-session-secret-0123456789abcdef';
const NOW_MS = Date.UTC(2026, 10, 9, 3, 0, 0);
const NOW_S = NOW_MS / 1000;

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

async function signed(payload: string): Promise<string> {
  // A token with any payload, signed with the real MAC: what a holder of the secret could mint.
  const valid = await mintSignInSessionToken(
    newSignInSessionClaims('a@b.test', 'default', NOW_MS),
    SECRET,
  );
  const [version] = valid.split('.');
  const head = `${version ?? ''}.${base64Url(payload)}`;
  // The session's purpose key (part 06 step 5), so these refusals do not lean on the roll-over.
  const sessionKey = hkdfSync(
    'sha256',
    SECRET,
    'agent-workspace/key-ring',
    'agent-workspace/session/v1',
    32,
  );
  const key = await crypto.subtle.importKey(
    'raw',
    sessionKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(head));
  return `${head}.${Buffer.from(mac).toString('base64url')}`;
}

describe('session token and cookies, pinned', () => {
  it('builds the same claims and mints the same bytes', async () => {
    const claims = newSignInSessionClaims('admin@example.com', 'default', NOW_MS);
    // Part 06 step 9: the unused role claim is no longer written.
    expect(claims).toEqual({
      sub: 'admin@example.com',
      ws: 'default',
      iat: NOW_S,
      exp: NOW_S + 43_200,
    });
    expect(await mintSignInSessionToken(claims, SECRET)).toBe(
      'aw1.eyJzdWIiOiJhZG1pbkBleGFtcGxlLmNvbSIsIndzIjoiZGVmYXVsdCIsImlhdCI6MTc5NDE5MzIwMCwiZXhwIjoxNzk0MjM2NDAwfQ.HNoTu5QSuu9_hnWSrcQdIRblba0jg6tsjlvumshR3ho',
    );
    // The token 0.6.13 minted (role written, MAC under the session key) still verifies until it
    // expires, so an upgrade signs nobody out.
    const withRole =
      'aw1.eyJzdWIiOiJhZG1pbkBleGFtcGxlLmNvbSIsIndzIjoiZGVmYXVsdCIsInJvbGUiOiJvd25lciIsImlhdCI6MTc5NDE5MzIwMCwiZXhwIjoxNzk0MjM2NDAwfQ.';
    const before = await verifySignInSessionToken(
      `${withRole}2vrJRvITvhRxMkbBTWnmPjygzyz_HijT0mD96Y67BLI`,
      SECRET,
      NOW_MS,
    );
    expect(before.ok && Object.keys(before.claims)).toEqual(['sub', 'ws', 'iat', 'exp']);
    // The token minted before step 5 (raw-secret MAC) is refused: step 6 ended the roll-over.
    const rawSecret = `${withRole}jL-VAltkbyZjbxOKVUvMwSQxukHmr8c06dE_bMuyIRg`;
    expect((await verifySignInSessionToken(rawSecret, SECRET, NOW_MS)).ok).toBe(false);
    expect(SIGN_IN_SESSION_TTL_SECONDS).toBe(43_200);
  });

  it('accepts a session that carries no role, and exposes no role from any session (part 06, step 9)', async () => {
    const withoutRole = await signed(
      `{"sub":"a@b.test","ws":"default","iat":${String(NOW_S)},"exp":${String(NOW_S + 60)}}`,
    );
    const verified = await verifySignInSessionToken(withoutRole, SECRET, NOW_MS);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect({ ...verified.claims }).toEqual({
        sub: 'a@b.test',
        ws: 'default',
        iat: NOW_S,
        exp: NOW_S + 60,
      });
    }
    const minted = await mintSignInSessionToken(
      newSignInSessionClaims('a@b.test', 'default', NOW_MS),
      SECRET,
    );
    const verifiedMinted = await verifySignInSessionToken(minted, SECRET, NOW_MS);
    expect(verifiedMinted.ok && Object.keys(verifiedMinted.claims)).toEqual([
      'sub',
      'ws',
      'iat',
      'exp',
    ]);
  });

  it('marks an email-link session, pinned, and carries the mark through verification (P3)', async () => {
    const claims = newEmailLinkSignInSessionClaims('guest@example.com', 'demo-1', NOW_MS);
    expect(claims).toEqual({
      sub: 'guest@example.com',
      ws: 'demo-1',
      via: 'email_link',
      iat: NOW_S,
      exp: NOW_S + 43_200,
    });
    expect(await mintSignInSessionToken(claims, SECRET)).toBe(
      'aw1.eyJzdWIiOiJndWVzdEBleGFtcGxlLmNvbSIsIndzIjoiZGVtby0xIiwidmlhIjoiZW1haWxfbGluayIsImlhdCI6MTc5NDE5MzIwMCwiZXhwIjoxNzk0MjM2NDAwfQ._WPXQ3rLPOsp704rfK1BmT7pwRvWUm9LuxNXXzr6HTg',
    );
    const verified = await verifySignInSessionToken(
      await mintSignInSessionToken(claims, SECRET),
      SECRET,
      NOW_MS,
    );
    expect(verified.ok && verified.claims.via).toBe('email_link');
  });

  it.each([
    [
      '{"sub":"a","ws":"d","via":"oidc","iat":1,"exp":2}',
      'via "oidc" is not a value this build accepts',
    ],
    [
      '{"sub":"a","ws":"d","via":null,"iat":1,"exp":2}',
      'via null is not a value this build accepts',
    ],
  ])('refuses the mark in %s as malformed', async (payload, reason) => {
    expect(await verifySignInSessionToken(await signed(payload), SECRET, 0)).toEqual({
      ok: false,
      code: 'malformed_session',
      reason,
    });
  });

  it('verifies until the second it expires, and not after', async () => {
    const token = await mintSignInSessionToken(
      newSignInSessionClaims('a@b.test', 'default', NOW_MS),
      SECRET,
    );
    const last = (NOW_S + SIGN_IN_SESSION_TTL_SECONDS) * 1000 - 1;
    expect((await verifySignInSessionToken(token, SECRET, last)).ok).toBe(true);
    expect(await verifySignInSessionToken(token, SECRET, last + 1)).toEqual({
      ok: false,
      code: 'expired_session',
      reason: 'session expired',
    });
  });

  it.each([
    ['{"ws":"d","role":"owner","iat":1,"exp":2}', 'sub is missing or not a non-empty string'],
    ['{"sub":"a","role":"owner","iat":1,"exp":2}', 'ws is missing or not a non-empty string'],
    [
      '{"sub":"a","ws":"d","role":"admin","iat":1,"exp":2}',
      'role "admin" is not a role this build accepts',
    ],
    [
      '{"sub":"a","ws":"d","role":null,"iat":1,"exp":2}',
      'role null is not a role this build accepts',
    ],
    [
      '{"sub":"a","ws":"d","role":"Owner","iat":1,"exp":2}',
      'role "Owner" is not a role this build accepts',
    ],
    ['{"sub":"a","ws":"d","role":"","iat":1,"exp":2}', 'role "" is not a role this build accepts'],
    ['{"sub":"a","ws":"d","role":"owner","exp":2}', 'iat is missing or not a finite number'],
    ['{"sub":"a","ws":"d","role":"owner","iat":1}', 'exp is missing or not a finite number'],
    ['{"sub":"a","ws":"d","role":"owner","iat":2,"exp":2}', 'exp is not after iat'],
    ['[1]', 'payload is not a JSON object'],
    ['not json', 'payload is not JSON'],
  ])('refuses the payload %s as malformed, naming why', async (payload, reason) => {
    expect(await verifySignInSessionToken(await signed(payload), SECRET, 0)).toEqual({
      ok: false,
      code: 'malformed_session',
      reason,
    });
  });

  it('refuses a lifetime longer than it issues, and checks expiry first', async () => {
    const long = `{"sub":"a","ws":"d","role":"owner","iat":${String(NOW_S)},"exp":${String(NOW_S + SIGN_IN_SESSION_TTL_SECONDS + 1)}}`;
    expect(await verifySignInSessionToken(await signed(long), SECRET, NOW_MS)).toEqual({
      ok: false,
      code: 'malformed_session',
      reason: 'session lifetime exceeds the maximum this build issues',
    });
    const expiredAndLong = `{"sub":"a","ws":"d","role":"owner","iat":1,"exp":${String(SIGN_IN_SESSION_TTL_SECONDS + 2)}}`;
    expect((await verifySignInSessionToken(await signed(expiredAndLong), SECRET, NOW_MS)).ok).toBe(
      false,
    );
    expect(
      await verifySignInSessionToken(await signed(expiredAndLong), SECRET, NOW_MS),
    ).toMatchObject({
      code: 'expired_session',
    });
  });

  it('sets and clears the cookie with the same attributes', () => {
    expect(signInSessionCookie('tok', '__Host-aw_session')).toEqual({
      name: '__Host-aw_session',
      value: 'tok',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 43_200,
    });
    expect(signInSessionCookie('tok', '__Host-aw_session_acme', 60)).toMatchObject({ maxAge: 60 });
    expect(clearedSignInSessionCookie('__Host-aw_session')).toEqual({
      name: '__Host-aw_session',
      value: '',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
  });
});
