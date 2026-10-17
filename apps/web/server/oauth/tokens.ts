/**
 * The wire format, mint and parse of the OAuth server's three credentials (ADR-0134 part 3), and
 * the PKCE `S256` check. Same cryptographic surface as `rbac/browser-token.ts`: a fixed-length
 * `<prefix><22-char id>_<43-char secret>`, only the SHA-256 hex of the secret half stored, and the
 * primitives imported from `rbac/api-key.ts` rather than written a second time.
 */
import { hashApiKeySecret, hashesEqual, randomToken } from '../rbac/api-key';

export type OAuthTokenKind = 'code' | 'access' | 'refresh';

export const OAUTH_TOKEN_PREFIXES = {
  code: 'awc_live_',
  access: 'awo_live_',
  refresh: 'awr_live_',
} as const satisfies Record<OAuthTokenKind, string>;

/** Lifetimes in milliseconds. A code is single use and short; a refresh token rotates. */
export const OAUTH_TOKEN_TTL_MS = {
  code: 60_000,
  access: 3_600_000,
  refresh: 30 * 24 * 3_600_000,
} as const satisfies Record<OAuthTokenKind, number>;

const ID_BYTES = 16;
const SECRET_BYTES = 32;
const ID_LENGTH = Math.ceil((ID_BYTES * 8) / 6);
const SECRET_LENGTH = Math.ceil((SECRET_BYTES * 8) / 6);

const PATTERNS = {
  code: patternFor('code'),
  access: patternFor('access'),
  refresh: patternFor('refresh'),
} as const satisfies Record<OAuthTokenKind, RegExp>;

function patternFor(kind: OAuthTokenKind): RegExp {
  return new RegExp(
    `^${OAUTH_TOKEN_PREFIXES[kind]}([A-Za-z0-9_-]{${String(ID_LENGTH)}})_([A-Za-z0-9_-]{${String(SECRET_LENGTH)}})$`,
    'u',
  );
}

export interface MintedOAuthToken {
  readonly tokenId: string;
  /** The whole token, shown once, in the response that issues it. */
  readonly presented: string;
  /** What goes in `oauth_tokens.token_hash`. */
  readonly tokenHash: string;
}

export async function mintOAuthToken(kind: OAuthTokenKind): Promise<MintedOAuthToken> {
  const tokenId = randomToken(ID_BYTES);
  const secret = randomToken(SECRET_BYTES);
  return {
    tokenId,
    presented: `${OAUTH_TOKEN_PREFIXES[kind]}${tokenId}_${secret}`,
    tokenHash: await hashApiKeySecret(secret),
  };
}

/** The secret half of a well-formed token of `kind`, or `null`. Total and positive. */
export function parseOAuthToken(kind: OAuthTokenKind, value: unknown): { secret: string } | null {
  if (typeof value !== 'string') return null;
  const secret = PATTERNS[kind].exec(value)?.[2];
  return secret === undefined ? null : { secret };
}

/** The digest to look a presented token of `kind` up by, or `null` for a malformed one. */
export async function oauthTokenHash(kind: OAuthTokenKind, value: unknown): Promise<string | null> {
  const parsed = parseOAuthToken(kind, value);
  return parsed === null ? null : hashApiKeySecret(parsed.secret);
}

const CLIENT_SECRET_PREFIX = 'awcs_live_';
const CLIENT_SECRET_PATTERN = new RegExp(
  `^${CLIENT_SECRET_PREFIX}([A-Za-z0-9_-]{${String(SECRET_LENGTH)}})$`,
  'u',
);

/** A confidential client's secret: shown once at rotation, only its SHA-256 hex stored. */
export async function mintClientSecret(): Promise<{ presented: string; secretHash: string }> {
  const secret = randomToken(SECRET_BYTES);
  return {
    presented: `${CLIENT_SECRET_PREFIX}${secret}`,
    secretHash: await hashApiKeySecret(secret),
  };
}

/** The digest of a presented client secret, or `null` for a malformed one. */
export async function clientSecretDigest(value: unknown): Promise<string | null> {
  const secret = typeof value === 'string' ? CLIENT_SECRET_PATTERN.exec(value)?.[1] : undefined;
  return secret === undefined ? null : hashApiKeySecret(secret);
}

/** `Authorization: Bearer awo_live_...`: `absent`, `invalid` (another credential kind) or the hash. */
export type BearerOAuthAccessAttempt =
  | { readonly kind: 'absent' }
  | { readonly kind: 'other' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'presented'; readonly secret: string };

/**
 * Classify an Authorization header. `other` is a bearer that does not claim to be an OAuth access
 * token, so the caller falls through to the next credential kind; `invalid` claims to be one and
 * is malformed, so the caller must fail closed.
 */
export function readBearerOAuthAccessAttempt(header: unknown): BearerOAuthAccessAttempt {
  if (header === null || header === undefined) return { kind: 'absent' };
  if (typeof header !== 'string') return { kind: 'other' };
  const match = /^Bearer[ ]([^ ]+)$/iu.exec(header.trim());
  const bearer = match?.[1];
  if (bearer === undefined || !bearer.startsWith(OAUTH_TOKEN_PREFIXES.access)) {
    return { kind: 'other' };
  }
  const parsed = parseOAuthToken('access', bearer);
  return parsed === null ? { kind: 'invalid' } : { kind: 'presented', secret: parsed.secret };
}

/** RFC 7636 §4.1: 43–128 characters of the unreserved set. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/u;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** The `S256` challenge of a verifier: base64url(SHA-256(verifier)). */
export async function pkceS256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** RFC 7636 §4.6, `S256` only: there is no `plain` branch to be tricked into. */
export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  if (!VERIFIER_PATTERN.test(verifier)) return false;
  return hashesEqual(await pkceS256Challenge(verifier), challenge);
}

/** A well-formed `code_challenge`: a base64url SHA-256 is exactly 43 characters. */
export function isPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9\-_]{43}$/u.test(value);
}
