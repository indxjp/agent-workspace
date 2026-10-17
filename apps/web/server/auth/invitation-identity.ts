/**
 * A short-lived proof of the OIDC identity that may redeem an invitation.
 *
 * This is deliberately neither a tenant session nor a workspace-selection token. It carries no
 * workspace, role, user id, or grant; it only preserves the identity provider facts the callback
 * already verified until the invitee presents the independently issued invitation token. A
 * distinct version tag makes cross-use with either other signed token fail closed.
 */

const encoder = new TextEncoder();
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

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) return null;
  const padding = (4 - (text.length % 4)) % 4;
  const padded = text.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat(padding);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function mintInvitationIdentityToken(
  input: { readonly email: string; readonly issuer: string; readonly subject: string },
  secret: string,
  nowMs: number = Date.now(),
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
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signed = `${TOKEN_VERSION}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(signed));
  return `${signed}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Verify signature before parsing, then positively validate every claim and the bounded expiry. */
export async function verifyInvitationIdentityToken(
  token: unknown,
  secret: string,
  nowMs: number = Date.now(),
): Promise<InvitationIdentityVerifyResult> {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'no invitation identity cookie on the request' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed invitation identity token' };
  const [version, payloadPart, signaturePart] = parts;
  if (version !== TOKEN_VERSION || payloadPart === undefined || signaturePart === undefined) {
    return { ok: false, reason: 'invitation identity token version is not accepted' };
  }
  const signature = base64UrlDecode(signaturePart);
  if (signature === null) return { ok: false, reason: 'signature segment is not base64url' };
  const signatureValid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    signature,
    encoder.encode(`${version}.${payloadPart}`),
  );
  if (!signatureValid) return { ok: false, reason: 'signature does not verify' };

  const payloadBytes = base64UrlDecode(payloadPart);
  if (payloadBytes === null) return { ok: false, reason: 'payload segment is not base64url' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, reason: 'payload is not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'payload is not a JSON object' };
  }
  const claims = parsed as Record<string, unknown>;
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
