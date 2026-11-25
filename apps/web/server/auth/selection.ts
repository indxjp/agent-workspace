/**
 * The post-callback workspace-selection state — issue #118.
 *
 * When an identity resolves to more than one CURRENT membership, the callback cannot mint a
 * tenant session yet: it does not know which workspace the caller wants. It mints this instead —
 * a short-lived, signed, HTTP-only cookie naming the user and nothing else — and
 * `POST /api/auth/workspace` re-reads the membership before it ever mints a real session.
 *
 * This is deliberately not `session.ts`'s `SignInSessionClaims`: a selection is not a tenant session (it
 * names no workspace and confers no access), and `verifySignInSessionToken` would in any case reject it
 * — its token-version tag differs on purpose, so a selection token can never be replayed where a
 * tenant session is expected, or the reverse.
 *
 * Sealed and opened by the same signed-token codec as `session.ts` (`./core/signed-token.ts`, Web
 * Crypto, never a comparison of our own), and with the same deliberate absence of a sibling import:
 * docs/adr/W1-CP-06-auth-modules-are-standalone-es-modules.md.
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

/** This token's own key, derived from the secret (part 06 step 5, `./core/key-ring.ts`). */
async function purposeKey(secret: string): Promise<CryptoKey> {
  return importHmacKey(
    crypto.subtle,
    await derivePurposeKey(crypto.subtle, secret, 'workspace-selection'),
  );
}

/** The codec's refusal in this module's words: its own for the token's shape, the codec's for the rest. */
function refusalFor(failure: SignedTokenFailure): { readonly ok: false; readonly reason: string } {
  switch (failure.kind) {
    case 'parts-count':
      return { ok: false, reason: 'malformed selection token' };
    case 'version':
      return { ok: false, reason: 'selection token version tag is not the one this build issues' };
    default:
      return { ok: false, reason: signedTokenRefusal(failure) };
  }
}

/** Mint a selection token for `userId`/`email`. The caller has already resolved both. */
export async function mintSelectionToken(
  userId: string,
  email: string,
  secret: string,
  nowMs: number = systemClock.now().getTime(),
): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const claims: SelectionClaims = { userId, email, iat, exp: iat + SELECTION_TTL_SECONDS };
  return sealSignedToken(crypto.subtle, await purposeKey(secret), TOKEN_VERSION, claims);
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
  nowMs: number = systemClock.now().getTime(),
): Promise<SelectionVerifyResult> {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'no selection cookie on the request' };
  }
  const opened = await openSignedToken(
    crypto.subtle,
    await purposeKey(secret),
    TOKEN_VERSION,
    token,
  );
  if (!opened.ok) return refusalFor(opened.failure);
  const { userId, email, iat, exp } = opened.payload;
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
