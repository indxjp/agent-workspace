/**
 * A short-lived proof of the OIDC identity that may redeem an invitation.
 *
 * This is deliberately neither a tenant session nor a workspace-selection token. It carries no
 * workspace, role, user id, or grant; it only preserves the identity provider facts the callback
 * already verified until the invitee presents the independently issued invitation token. A
 * distinct version tag makes cross-use with either other signed token fail closed. The format is
 * the one signed-token codec's (`./core/signed-token.ts`); the claims are checked here.
 */

import { systemClock } from '../clock.ts';
import { derivePurposeKey } from './core/key-ring.ts';
import {
  importHmacKey,
  openSignedToken,
  sealSignedToken,
  signedTokenRefusal,
  type SignedTokenFailure,
} from './core/signed-token.ts';

const TOKEN_VERSION = 'awinv1';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CLAIM_NAMES = ['email', 'issuer', 'subject', 'iat', 'exp'] as const;
const MAX_CLOCK_SKEW_SECONDS = 60;

/**
 * The unscoped base name. Never set as-is by a route: `index.ts` (the composition root) scopes it
 * per deployment with `scopedCookieName` from `session.ts` (issue #394), and its
 * `invitationIdentityCookie` sets that scoped name.
 */
export const INVITATION_IDENTITY_COOKIE_BASE_NAME = '__Host-aw_invitation_identity';
export const INVITATION_IDENTITY_TTL_SECONDS = 10 * 60;

export interface InvitationIdentityClaims {
  readonly email: string;
  readonly issuer: string;
  readonly subject: string;
  readonly iat: number;
  readonly exp: number;
}

export type InvitationIdentityVerifyResult =
  | { readonly ok: true; readonly claims: InvitationIdentityClaims }
  | { readonly ok: false; readonly reason: string };

/** This token's own key, derived from the secret (part 06 step 5, `./core/key-ring.ts`). */
async function purposeKey(secret: string): Promise<CryptoKey> {
  return importHmacKey(
    crypto.subtle,
    await derivePurposeKey(crypto.subtle, secret, 'invitation-identity'),
  );
}

/** The codec's refusal in this module's words: its own for the token's shape, the codec's for the rest. */
function refusalFor(failure: SignedTokenFailure): { readonly ok: false; readonly reason: string } {
  switch (failure.kind) {
    case 'parts-count':
      return { ok: false, reason: 'malformed invitation identity token' };
    case 'version':
      return { ok: false, reason: 'invitation identity token version is not accepted' };
    default:
      return { ok: false, reason: signedTokenRefusal(failure) };
  }
}

export async function mintInvitationIdentityToken(
  input: { readonly email: string; readonly issuer: string; readonly subject: string },
  secret: string,
  nowMs: number = systemClock.now().getTime(),
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email) || input.issuer.trim() === '' || input.subject.trim() === '') {
    throw new Error('cannot mint an invitation identity token from an incomplete OIDC identity');
  }
  const iat = Math.floor(nowMs / 1000);
  const claims: InvitationIdentityClaims = {
    email,
    issuer: input.issuer,
    subject: input.subject,
    iat,
    exp: iat + INVITATION_IDENTITY_TTL_SECONDS,
  };
  return sealSignedToken(crypto.subtle, await purposeKey(secret), TOKEN_VERSION, claims);
}

/** Verify signature before parsing, then positively validate every claim and the bounded expiry. */
export async function verifyInvitationIdentityToken(
  token: unknown,
  secret: string,
  nowMs: number = systemClock.now().getTime(),
): Promise<InvitationIdentityVerifyResult> {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'no invitation identity cookie on the request' };
  }
  const opened = await openSignedToken(
    crypto.subtle,
    await purposeKey(secret),
    TOKEN_VERSION,
    token,
  );
  if (!opened.ok) return refusalFor(opened.failure);
  const claims = opened.payload;
  if (
    Object.keys(claims).length !== CLAIM_NAMES.length ||
    CLAIM_NAMES.some((name) => !Object.hasOwn(claims, name))
  ) {
    return { ok: false, reason: 'payload does not have the exact invitation identity claim set' };
  }
  const { email, issuer, subject, iat, exp } = claims;
  if (
    typeof email !== 'string' ||
    email !== email.trim().toLowerCase() ||
    !EMAIL_SHAPE.test(email)
  ) {
    return { ok: false, reason: 'email is missing or not normalized' };
  }
  if (typeof issuer !== 'string' || issuer.trim() === '') {
    return { ok: false, reason: 'issuer is missing or blank' };
  }
  if (typeof subject !== 'string' || subject.trim() === '') {
    return { ok: false, reason: 'subject is missing or blank' };
  }
  if (typeof iat !== 'number' || !Number.isSafeInteger(iat)) {
    return { ok: false, reason: 'iat is missing or not an integer timestamp' };
  }
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) {
    return { ok: false, reason: 'exp is missing or not an integer timestamp' };
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'iat is materially in the future' };
  }
  if (exp <= iat) return { ok: false, reason: 'exp is not after iat' };
  if (exp - iat > INVITATION_IDENTITY_TTL_SECONDS) {
    return { ok: false, reason: 'invitation identity lifetime exceeds the maximum' };
  }
  if (exp * 1000 <= nowMs) return { ok: false, reason: 'invitation identity expired' };
  return { ok: true, claims: { email, issuer, subject, iat, exp } };
}

export interface InvitationIdentityCookie {
  readonly name: string;
  readonly value: string;
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: 'lax';
  readonly path: '/';
  readonly maxAge: number;
}

export function invitationIdentityCookie(
  token: string,
  maxAgeSeconds: number = INVITATION_IDENTITY_TTL_SECONDS,
): InvitationIdentityCookie {
  return {
    name: INVITATION_IDENTITY_COOKIE_BASE_NAME,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export function clearedInvitationIdentityCookie(): InvitationIdentityCookie {
  return { ...invitationIdentityCookie(''), value: '', maxAge: 0 };
}
