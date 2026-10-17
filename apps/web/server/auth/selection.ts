/**
 * The post-callback workspace-selection state — issue #118.
 *
 * When an identity resolves to more than one CURRENT membership, the callback cannot mint a
 * tenant session yet: it does not know which workspace the caller wants. It mints this instead —
 * a short-lived, signed, HTTP-only cookie naming the user and nothing else — and
 * `POST /api/auth/workspace` re-reads the membership before it ever mints a real session.
 *
 * This is deliberately not `session.ts`'s `SessionClaims`: a selection is not a tenant session (it
 * names no workspace and confers no access), and `verifySessionToken` would in any case reject it
 * — its token-version tag differs on purpose, so a selection token can never be replayed where a
 * tenant session is expected, or the reverse.
 *
 * Same HMAC primitive as `session.ts` (Web Crypto, never a comparison of our own), and the same
 * deliberate absence of a sibling import: docs/adr/W1-CP-06-auth-modules-are-standalone-es-modules.md.
 */

const encoder = new TextEncoder();

/** Distinct from `session.ts`'s `'aw1'`, so the two token kinds can never be confused. */
const TOKEN_VERSION = 'awsel1';

/**
 * The unscoped base name. Never set as-is by a route: `index.ts` (the composition root) scopes it
 * per deployment with `scopedCookieName` from `session.ts` (issue #394), and its `selectionCookie`
 * sets that scoped name.
 */
export const SELECTION_COOKIE_BASE_NAME = '__Host-aw_workspace_selection';

/** Ten minutes: long enough to read a short list and click one, short enough to matter. */
export const SELECTION_TTL_SECONDS = 10 * 60;

export interface SelectionClaims {
  /** `users.id`. Not an email: the callback already resolved the identity by the time this mints. */
  readonly userId: string;
  /** Carried so `POST /api/auth/workspace` can mint a session without a second identity lookup. */
  readonly email: string;
  readonly iat: number;
  readonly exp: number;
}

export type SelectionVerifyResult =
  | { readonly ok: true; readonly claims: SelectionClaims }
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

/** Mint a selection token for `userId`/`email`. The caller has already resolved both. */
export async function mintSelectionToken(
  userId: string,
  email: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const claims: SelectionClaims = { userId, email, iat, exp: iat + SELECTION_TTL_SECONDS };
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signed = `${TOKEN_VERSION}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(signed));
  return `${signed}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify a selection token. Rejects in the same fixed order `session.ts` does — signature before
 * payload, expiry parsed and type-checked before it is compared — for the same reason: no
 * attacker-controlled JSON reaches `JSON.parse` on the strength of a bad MAC, and a missing or
 * non-numeric expiry cannot produce a `NaN < now` that silently reads as "not expired".
 */
export async function verifySelectionToken(
  token: unknown,
  secret: string,
  nowMs: number = Date.now(),
): Promise<SelectionVerifyResult> {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'no selection cookie on the request' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed selection token' };
  const [version, payloadPart, signaturePart] = parts;
  if (version !== TOKEN_VERSION || payloadPart === undefined || signaturePart === undefined) {
    return { ok: false, reason: 'selection token version tag is not the one this build issues' };
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
  const record = parsed as Record<string, unknown>;
  const { userId, email, iat, exp } = record;
  if (typeof userId !== 'string' || userId.length === 0) {
    return { ok: false, reason: 'userId is missing or not a non-empty string' };
  }
  if (typeof email !== 'string' || email.length === 0) {
    return { ok: false, reason: 'email is missing or not a non-empty string' };
  }
  if (typeof iat !== 'number' || !Number.isFinite(iat)) {
    return { ok: false, reason: 'iat is missing or not a finite number' };
  }
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return { ok: false, reason: 'exp is missing or not a finite number' };
  }
  if (exp <= iat) return { ok: false, reason: 'exp is not after iat' };
  if (exp * 1000 <= nowMs) return { ok: false, reason: 'selection expired' };
  if (exp - iat > SELECTION_TTL_SECONDS) {
    return { ok: false, reason: 'selection lifetime exceeds the maximum this build issues' };
  }
  return { ok: true, claims: { userId, email, iat, exp } };
}

/** Cookie attributes for the selection token. `__Host-`, so `secure`/`path`/no `Domain` is fixed. */
export interface SelectionCookie {
  readonly name: string;
  readonly value: string;
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: 'lax';
  readonly path: '/';
  readonly maxAge: number;
}

export function selectionCookie(
  token: string,
  maxAgeSeconds: number = SELECTION_TTL_SECONDS,
): SelectionCookie {
  return {
    name: SELECTION_COOKIE_BASE_NAME,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/** The same cookie with an immediate expiry — clears the selection once it has been used. */
export function clearedSelectionCookie(): SelectionCookie {
  return { ...selectionCookie(''), value: '', maxAge: 0 };
}
