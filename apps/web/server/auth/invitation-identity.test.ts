import { describe, expect, it } from 'vitest';

import {
  INVITATION_IDENTITY_COOKIE_BASE_NAME,
  INVITATION_IDENTITY_TTL_SECONDS,
  clearedInvitationIdentityCookie,
  invitationIdentityCookie,
  mintInvitationIdentityToken,
  verifyInvitationIdentityToken,
} from './invitation-identity';

const SECRET = 'invitation-identity-test-secret-long-enough';
const NOW = Date.parse('2026-09-12T00:00:00.000Z');
const INPUT = {
  email: 'Invitee@Example.test',
  issuer: 'https://issuer.example.test',
  subject: 'oidc-subject',
};

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

async function signedToken(version: string, payload: Record<string, unknown>): Promise<string> {
  const encoder = new TextEncoder();
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const signed = `${version}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signed));
  return `${signed}.${base64Url(new Uint8Array(signature))}`;
}

describe('invitation identity token', () => {
  it('round-trips only normalized OIDC identity facts and no tenant grant', async () => {
    const token = await mintInvitationIdentityToken(INPUT, SECRET, NOW);
    const verified = await verifyInvitationIdentityToken(token, SECRET, NOW);
    expect(verified).toMatchObject({
      ok: true,
      claims: {
        email: 'invitee@example.test',
        issuer: INPUT.issuer,
        subject: INPUT.subject,
      },
    });
    expect(JSON.stringify(verified)).not.toMatch(/workspace|role|grant|userId/u);
  });

  it('rejects a validly signed token with another token kind version', async () => {
    const iat = Math.floor(NOW / 1000);
    const token = await signedToken('awsel1', {
      email: 'invitee@example.test',
      issuer: INPUT.issuer,
      subject: INPUT.subject,
      iat,
      exp: iat + INVITATION_IDENTITY_TTL_SECONDS,
    });
    const verified = await verifyInvitationIdentityToken(token, SECRET, NOW);
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error('token with another version unexpectedly verified');
    expect(verified.reason).toContain('version');
  });

  it('rejects expiry and a validly signed lifetime beyond the fixed maximum', async () => {
    const token = await mintInvitationIdentityToken(INPUT, SECRET, NOW);
    const expired = await verifyInvitationIdentityToken(
      token,
      SECRET,
      NOW + INVITATION_IDENTITY_TTL_SECONDS * 1000,
    );
    expect(expired.ok).toBe(false);
    if (expired.ok) throw new Error('expired token unexpectedly verified');
    expect(expired.reason).toContain('expired');

    const iat = Math.floor(NOW / 1000);
    const overlong = await signedToken('awinv1', {
      email: 'invitee@example.test',
      issuer: INPUT.issuer,
      subject: INPUT.subject,
      iat,
      exp: iat + INVITATION_IDENTITY_TTL_SECONDS + 1,
    });
    const tooLong = await verifyInvitationIdentityToken(overlong, SECRET, NOW);
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) throw new Error('overlong token unexpectedly verified');
    expect(tooLong.reason).toContain('lifetime');
  });

  it('rejects unknown claims, fractional timestamps, and materially future issuance', async () => {
    const iat = Math.floor(NOW / 1000);
    const baseClaims = {
      email: 'invitee@example.test',
      issuer: INPUT.issuer,
      subject: INPUT.subject,
      iat,
      exp: iat + INVITATION_IDENTITY_TTL_SECONDS,
    };
    const variants = [
      {
        name: 'workspace claim',
        payload: { ...baseClaims, workspaceId: 'foreign-workspace' },
        reason: 'exact invitation identity claim set',
      },
      {
        name: 'role and grant claims',
        payload: { ...baseClaims, role: 'owner', grant: 'any' },
        reason: 'exact invitation identity claim set',
      },
      {
        name: 'fractional issued-at',
        payload: { ...baseClaims, iat: iat + 0.5 },
        reason: 'integer timestamp',
      },
      {
        name: 'fractional expiry',
        payload: { ...baseClaims, exp: baseClaims.exp + 0.5 },
        reason: 'integer timestamp',
      },
      {
        name: 'future issued-at',
        payload: {
          ...baseClaims,
          iat: iat + 365 * 24 * 60 * 60,
          exp: iat + 365 * 24 * 60 * 60 + INVITATION_IDENTITY_TTL_SECONDS,
        },
        reason: 'future',
      },
    ];

    for (const variant of variants) {
      const verified = await verifyInvitationIdentityToken(
        await signedToken('awinv1', variant.payload),
        SECRET,
        NOW,
      );
      expect(verified.ok, variant.name).toBe(false);
      if (verified.ok) throw new Error(`${variant.name} unexpectedly verified`);
      expect(verified.reason, variant.name).toContain(variant.reason);
    }
  });

  it('allows only the explicitly bounded clock skew', async () => {
    const nowSeconds = Math.floor(NOW / 1000);
    const claims = (iat: number) => ({
      email: 'invitee@example.test',
      issuer: INPUT.issuer,
      subject: INPUT.subject,
      iat,
      exp: iat + INVITATION_IDENTITY_TTL_SECONDS,
    });
    expect(
      await verifyInvitationIdentityToken(
        await signedToken('awinv1', claims(nowSeconds + 60)),
        SECRET,
        NOW,
      ),
    ).toMatchObject({ ok: true });
    const justOutsideSkew = await verifyInvitationIdentityToken(
      await signedToken('awinv1', claims(nowSeconds + 61)),
      SECRET,
      NOW,
    );
    expect(justOutsideSkew.ok).toBe(false);
    if (justOutsideSkew.ok) throw new Error('out-of-bound clock skew unexpectedly verified');
    expect(justOutsideSkew.reason).toContain('future');
  });

  it('uses a distinct secure HttpOnly host cookie and clears it explicitly', () => {
    expect(invitationIdentityCookie('token')).toEqual({
      name: INVITATION_IDENTITY_COOKIE_BASE_NAME,
      value: 'token',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: INVITATION_IDENTITY_TTL_SECONDS,
    });
    expect(clearedInvitationIdentityCookie()).toMatchObject({ value: '', maxAge: 0 });
  });
});
