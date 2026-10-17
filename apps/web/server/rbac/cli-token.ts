/**
 * Issue #242 (SDK-10, S-22): the `awu_live_` wire format, mint, and parse for the user token
 * `aw login` holds. ADR-0083.
 *
 * The same anchored fixed-length grammar and the same cryptographic surface as `api-key.ts` and
 * `browser-token.ts`: 16 random bytes of id, 32 of secret, base64url, and only a SHA-256 of the
 * secret half is ever stored.
 */
import { CLI_TOKEN_PREFIX } from '@indx-workspace/contracts/cli-auth';

import { hashApiKeySecret, randomToken } from './api-key.ts';

const TOKEN_ID_BYTES = 16;
const SECRET_BYTES = 32;

const PRESENTED_TOKEN_PATTERN = /^awu_live_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/u;

/** The secret half of a presented user token. Only its digest is ever compared or stored. */
export interface PresentedCliToken {
  readonly secret: string;
}

/** Distinguish no user token from a credential attempt that must fail closed. */
export type BearerCliTokenAttempt =
  { readonly kind: 'absent' } | { readonly kind: 'presented'; readonly token: PresentedCliToken };

export interface MintedCliToken {
  /** The whole token, returned to the CLI once. */
  readonly presented: string;
  /** What goes in `cli_sessions.token_hash`. */
  readonly tokenHash: string;
}

/** Read a presented token, or `null` for anything that is not exactly its shape. */
export function parsePresentedCliToken(value: unknown): PresentedCliToken | null {
  if (typeof value !== 'string') return null;
  const secret = PRESENTED_TOKEN_PATTERN.exec(value)?.[2];
  return secret === undefined ? null : { secret };
}

/** Mint a token. The only source of one. */
export async function mintCliToken(): Promise<MintedCliToken> {
  const secret = randomToken(SECRET_BYTES);
  const presented = `${CLI_TOKEN_PREFIX}${randomToken(TOKEN_ID_BYTES)}_${secret}`;
  if (parsePresentedCliToken(presented) === null) {
    throw new Error('a freshly minted CLI token does not match this module’s own parse.');
  }
  return { presented, tokenHash: await hashApiKeySecret(secret) };
}

/**
 * `presented` for an `Authorization: Bearer awu_live_…` header of exactly the token's shape;
 * `absent` for everything else, which the caller hands on to the other credential readers — an
 * `awu_live_`-prefixed value of the wrong shape reaches `readBearerApiKeyAttempt` and is refused
 * there as an invalid bearer.
 */
export function readBearerCliTokenAttempt(header: unknown): BearerCliTokenAttempt {
  if (typeof header !== 'string') return { kind: 'absent' };
  const match = /^Bearer[ ]([^ ]+)$/iu.exec(header.trim());
  const token = parsePresentedCliToken(match?.[1]);
  return token === null ? { kind: 'absent' } : { kind: 'presented', token };
}

/** SHA-256 of the secret half, lower-case hex. */
export const hashCliTokenSecret = hashApiKeySecret;
