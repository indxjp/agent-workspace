/**
 * Issue #236 (SDK-04, S-1): the `awt_live_` wire format, mint, and parse for a browser token.
 *
 * The same anchored fixed-length grammar `api-key.ts`'s header measured and fixed for `ak_live_`,
 * with the same reasoning: `_` is inside base64url's alphabet, so the parse cannot split on it and
 * must instead match both halves at their fixed lengths. Rather than re-derive `randomToken` /
 * `hashApiKeySecret` / `hashesEqual` a second time — "one cryptographic surface in this
 * application" — this module imports them from `./api-key.js` and supplies only the prefix, the
 * lengths, and the two positive parses that are specific to this credential's shape.
 */
import { hashApiKeySecret, hashesEqual, randomToken } from './api-key';

/** §3.1's printed prefix. Distinct from `ak_live_` so `apps/web/proxy.ts` can tell them apart by shape. */
export const BROWSER_TOKEN_PREFIX = 'awt_live_';

/** Same byte counts as an API key: 16 bytes / 32 bytes, base64url. */
const TOKEN_ID_BYTES = 16;
const SECRET_BYTES = 32;

function base64urlLength(bytes: number): number {
  return Math.ceil((bytes * 8) / 6);
}

export const BROWSER_TOKEN_ID_LENGTH = base64urlLength(TOKEN_ID_BYTES);
export const BROWSER_TOKEN_SECRET_LENGTH = base64urlLength(SECRET_BYTES);

const PRESENTED_TOKEN_PATTERN = new RegExp(
  `^${BROWSER_TOKEN_PREFIX}([A-Za-z0-9_-]{${String(BROWSER_TOKEN_ID_LENGTH)}})_([A-Za-z0-9_-]{${String(BROWSER_TOKEN_SECRET_LENGTH)}})$`,
  'u',
);

/** The two halves of a presented browser token. Neither is a credential on its own. */
export interface PresentedBrowserToken {
  readonly tokenId: string;
  readonly secret: string;
}

/** Distinguish no credential from a credential attempt that must fail closed. */
export type BearerBrowserTokenAttempt =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'presented'; readonly token: PresentedBrowserToken };

/** What `POST /api/tokens` returns once, and what it stores. */
export interface MintedBrowserToken {
  readonly tokenId: string;
  /** The whole token, exactly as the caller forwards it to its frontend. Returned once. */
  readonly presented: string;
  /** What goes in `browser_tokens.token_hash`. Lower-case hex of SHA-256 over the secret half. */
  readonly tokenHash: string;
}

/** Mint a token. The only source of one. */
export async function mintBrowserToken(): Promise<MintedBrowserToken> {
  const tokenId = randomToken(TOKEN_ID_BYTES);
  const secret = randomToken(SECRET_BYTES);
  const presented = `${BROWSER_TOKEN_PREFIX}${tokenId}_${secret}`;
  // Mirrors `mintApiKey`'s own self-check: a token this program mints must be a token this
  // program can read back, so a format/pattern drift fails at the point of minting rather than at
  // every verification afterward.
  if (parsePresentedBrowserToken(presented) === null) {
    throw new Error(
      'a freshly minted browser token does not match this module’s own parse; the format and ' +
        'the pattern have drifted apart and no token minted now could ever be verified.',
    );
  }
  return { tokenId, presented, tokenHash: await hashApiKeySecret(secret) };
}

/**
 * Read a presented token, or `null`.
 *
 * Total and positive, exactly as `parsePresentedKey` is: every input that is not an exact match of
 * the anchored, fixed-length shape is `null`, which the caller turns into the same `401` an
 * unknown or expired token gets (R-12 §1.5's indistinguishability rule, applied to this credential
 * too).
 */
export function parsePresentedBrowserToken(value: unknown): PresentedBrowserToken | null {
  if (typeof value !== 'string') return null;
  const match = PRESENTED_TOKEN_PATTERN.exec(value);
  if (match === null) return null;
  const tokenId = match[1];
  const secret = match[2];
  if (tokenId === undefined || secret === undefined) return null;
  return { tokenId, secret };
}

/** The wire form of a parsed token. The inverse of {@link parsePresentedBrowserToken}, exactly. */
export function presentedBrowserTokenText(token: PresentedBrowserToken): string {
  return `${BROWSER_TOKEN_PREFIX}${token.tokenId}_${token.secret}`;
}

/**
 * Parse an Authorization header without treating a malformed or non-browser-token credential as if
 * no credential was supplied. A resolver must return unauthenticated for `invalid`; it may fall
 * through to another credential kind only for `absent`.
 */
export function readBearerBrowserTokenAttempt(header: unknown): BearerBrowserTokenAttempt {
  if (header === null || header === undefined) return { kind: 'absent' };
  if (typeof header !== 'string') return { kind: 'invalid' };
  const match = /^Bearer[ ]([^ ]+)$/iu.exec(header.trim());
  if (match === null) return { kind: 'invalid' };
  const token = parsePresentedBrowserToken(match[1]);
  return token === null ? { kind: 'invalid' } : { kind: 'presented', token };
}

/** SHA-256 of the secret half, lower-case hex — the same digest {@link hashApiKeySecret} computes. */
export const hashBrowserTokenSecret = hashApiKeySecret;

/** Constant-time equality over two hex digests. Re-exported so a caller needs one import. */
export const browserTokenHashesEqual = hashesEqual;
