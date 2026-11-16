// Refactoring part 06, step 8: the session, selection and invitation-identity token functions take
// the time as an optional `nowMs` argument. When a caller leaves it out, the time comes from
// `systemClock` (apps/web/server/clock.ts) instead of a direct `Date.now()`. These tests pin that
// an omitted `nowMs` means "now": a token minted without it carries the current time, a fresh token
// verifies without it, and an expired one is refused without it. `vi.setSystemTime` moves the time
// that `systemClock` reads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INVITATION_IDENTITY_TTL_SECONDS,
  mintInvitationIdentityToken,
  verifyInvitationIdentityToken,
} from './invitation-identity.ts';
import { mintSelectionToken, SELECTION_TTL_SECONDS, verifySelectionToken } from './selection.ts';
import {
  mintSessionToken,
  newSessionClaims,
  SESSION_TTL_SECONDS,
  signInWith,
  verifySessionToken,
} from './session.ts';

const SECRET = 'a-secure-test-secret-with-at-least-32-characters';
const NOW_MS = Date.parse('2026-11-11T09:30:00.000Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

/** The `iat` claim of a `v.payload.signature` token. */
function issuedAt(token: string): unknown {
  const payload = token.split('.')[1] ?? '';
  return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iat?: unknown }).iat;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session: an omitted nowMs is the current time', () => {
  it('newSessionClaims issues the claims now', () => {
    const claims = newSessionClaims('admin@example.com', 'default');
    expect(claims.iat).toBe(NOW_SECONDS);
    expect(claims.exp).toBe(NOW_SECONDS + SESSION_TTL_SECONDS);
  });

  it('verifySessionToken accepts a token minted now and refuses one minted a lifetime ago', async () => {
    const fresh = await mintSessionToken(
      newSessionClaims('a@example.com', 'default', NOW_MS),
      SECRET,
    );
    expect((await verifySessionToken(fresh, SECRET)).ok).toBe(true);

    const oldMs = NOW_MS - (SESSION_TTL_SECONDS + 60) * 1000;
    const old = await mintSessionToken(newSessionClaims('a@example.com', 'default', oldMs), SECRET);
    expect((await verifySessionToken(old, SECRET, oldMs)).ok).toBe(true);
    expect(await verifySessionToken(old, SECRET)).toMatchObject({
      ok: false,
      code: 'expired_session',
    });
  });

  it('signInWith mints the session now', async () => {
    const result = await signInWith(
      { email: 'admin@example.com', password: 'correct horse battery staple' },
      {
        secret: { ok: true, secret: SECRET },
        admin: {
          ok: true,
          admin: {
            email: 'admin@example.com',
            password: 'correct horse battery staple',
            workspaceSlug: 'default',
          },
        },
        cookieName: 'aw_session',
      },
    );
    if (!result.ok) throw new Error(result.reason);
    expect(issuedAt(result.token)).toBe(NOW_SECONDS);
  });
});

describe('selection: an omitted nowMs is the current time', () => {
  it('mintSelectionToken issues the token now', async () => {
    expect(issuedAt(await mintSelectionToken('user-1', 'a@example.com', SECRET))).toBe(NOW_SECONDS);
  });

  it('verifySelectionToken accepts a token minted now and refuses one minted a lifetime ago', async () => {
    const fresh = await mintSelectionToken('user-1', 'a@example.com', SECRET, NOW_MS);
    expect((await verifySelectionToken(fresh, SECRET)).ok).toBe(true);

    const oldMs = NOW_MS - (SELECTION_TTL_SECONDS + 60) * 1000;
    const old = await mintSelectionToken('user-1', 'a@example.com', SECRET, oldMs);
    expect((await verifySelectionToken(old, SECRET, oldMs)).ok).toBe(true);
    expect(await verifySelectionToken(old, SECRET)).toEqual({
      ok: false,
      reason: 'selection expired',
    });
  });
});

describe('invitation identity: an omitted nowMs is the current time', () => {
  const identity = { email: 'a@example.com', issuer: 'https://idp.example', subject: 'subject' };

  it('mintInvitationIdentityToken issues the token now', async () => {
    expect(issuedAt(await mintInvitationIdentityToken(identity, SECRET))).toBe(NOW_SECONDS);
  });

  it('verifyInvitationIdentityToken accepts a token minted now and refuses one minted a lifetime ago', async () => {
    const fresh = await mintInvitationIdentityToken(identity, SECRET, NOW_MS);
    expect((await verifyInvitationIdentityToken(fresh, SECRET)).ok).toBe(true);

    const oldMs = NOW_MS - (INVITATION_IDENTITY_TTL_SECONDS + 60) * 1000;
    const old = await mintInvitationIdentityToken(identity, SECRET, oldMs);
    expect((await verifyInvitationIdentityToken(old, SECRET, oldMs)).ok).toBe(true);
    expect(await verifyInvitationIdentityToken(old, SECRET)).toEqual({
      ok: false,
      reason: 'invitation identity expired',
    });
  });
});
