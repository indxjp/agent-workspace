/**
 * Spec §22's workspace API keys: the wire format, the mint, the parse, and the hash.
 *
 * §22 is two sentences of requirement — *"Show the raw secret only once."* and *"Store only a
 * secure hash."* — and one printed example that fixes the display prefix, `ak_live_`. Everything
 * else here comes from the R-12 research note §1.1–§1.5, which is this
 * repository's research contract on exactly this question and which is followed over instinct.
 *
 * ## The format, and why the parser measures rather than splits
 *
 * ```text
 * ak_live_<key_id>_<secret>
 *          │        └─ 32 random bytes, base64url, 43 characters (256 bits)
 *          └────────── 16 random bytes, base64url, 22 characters — public, stored in clear
 * ```
 *
 * The separator is `_`, and `_` is inside base64url's alphabet. R-12 §1.4 measured what that does
 * to the obvious parser: over 100 000 keys minted in this format, a `split('_')` parser requiring
 * four parts **rejected 63 177 of them**, and the failure is silent — a rejected parse is a 401,
 * indistinguishable from a wrong key. So the parse is an anchored fixed-length match, both halves
 * having a fixed length, which makes the split unique by construction rather than by observation.
 *
 * ## The hash is SHA-256, unsalted, and that is a decision with numbers behind it
 *
 * R-12 §1.2 and §1.3 measured the alternatives rather than reasoning about them. A per-row salt
 * makes the stored value uncomputable until the row is known, so the lookup cannot use an index:
 * `EXPLAIN (ANALYZE)` on PostgreSQL 17 over 100 000 keys reported a sequential scan removing all
 * 100 000 rows by filter at 45 ms with `sha256()` as the per-row function — and the same plan with
 * PBKDF2 in place of it is 100 000 × 62.9 ms ≈ 105 minutes of CPU **per request**. A slow KDF on
 * this path is also a remotely-triggerable resource exhaustion, because verification runs before
 * authentication succeeds and the attacker chooses how often it runs. The entropy is the control
 * here, not the work factor: 256 bits drawn uniformly leaves a KDF's iteration count nothing to
 * buy. A pepper — `HMAC-SHA-256(master_key, secret)` — stays indexable and is cheap, and R-12
 * §1.3 records why it is not Wave 2's: it makes the table unreadable without §23's master key and
 * adds a rotation procedure with no migration path.
 *
 * The digest is stored as lower-case hex because `api_keys.key_hash` is a `text` column
 * (`packages/core/src/db/schema/api-keys.ts`, W2-DB-01's, not this task's). R-12 recommends
 * `bytea`; the column that landed is `text`, and hex is the encoding that survives it without
 * anyone having to remember which one it is. That difference is declared in this task's PR.
 *
 * ## What this module deliberately does not do
 *
 * It never logs, never returns a record, and never touches a store. `POST /api/api-keys` is the
 * only place in the program that puts {@link MintedApiKey.presented} into a response, and
 * `api-keys.test.ts` proves that by scanning every response body the suite produces and asserting
 * the plaintext appears in exactly one of them.
 */

/** §22's printed prefix. Fixed by the specification's own example, not configurable. */
export const API_KEY_PREFIX = 'ak_live_';

/** Bytes of entropy in the public half. 16 → 22 base64url characters. */
const KEY_ID_BYTES = 16;

/** Bytes of entropy in the secret half. 32 → 43 base64url characters, 256 bits (R-12 §1.2). */
const SECRET_BYTES = 32;

/** The public half's length in characters, derived from its byte count rather than written down. */
export const KEY_ID_LENGTH = base64urlLength(KEY_ID_BYTES);

/** The secret half's length in characters, likewise derived. */
export const SECRET_LENGTH = base64urlLength(SECRET_BYTES);

/** Characters per unpadded base64 encoding of `bytes` bytes. */
function base64urlLength(bytes: number): number {
  return Math.ceil((bytes * 8) / 6);
}

/**
 * The anchored, fixed-length parse of R-12 §1.4. Built from the lengths above rather than typed
 * out, so a change to either byte count moves the pattern with it instead of leaving a literal
 * that silently rejects every key.
 */
const PRESENTED_KEY_PATTERN = new RegExp(
  `^${API_KEY_PREFIX}([A-Za-z0-9_-]{${String(KEY_ID_LENGTH)}})_([A-Za-z0-9_-]{${String(SECRET_LENGTH)}})$`,
  'u',
);

/** The two halves of a presented key. Neither is a credential on its own; together they are one. */
export interface PresentedKey {
  /** The public half. Safe to store in clear, to log, and to show in a UI. */
  readonly keyId: string;
  /** The secret half. Hashed immediately and never stored. */
  readonly secret: string;
}

/** Distinguish no credential from a credential attempt that must fail closed. */
export type BearerApiKeyAttempt =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'presented'; readonly key: PresentedKey };

/** What `POST /api/api-keys` returns once, and what it stores. */
export interface MintedApiKey {
  readonly keyId: string;
  /** The whole key, exactly as the operator must copy it. Returned once; never stored. */
  readonly presented: string;
  /** What goes in `api_keys.key_hash`. Lower-case hex of SHA-256 over the secret half. */
  readonly keyHash: string;
  /** What goes in `api_keys.key_prefix` — the displayable head §22's example prints. */
  readonly keyPrefix: string;
}

/** base64url of `bytes`, unpadded. */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** Lower-case hex of `bytes`. */
function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * SHA-256 of the secret half, lower-case hex.
 *
 * Web Crypto, not a hand-rolled primitive and not `node:crypto` — the same choice
 * `apps/web/server/auth/session.ts` made and for the same reason: one cryptographic surface in
 * this application, available in every runtime it runs in.
 */
export async function hashApiKeySecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return hex(new Uint8Array(digest));
}

/**
 * `bytes` bytes of CSPRNG entropy, base64url-encoded.
 *
 * Exported so `apps/web/server/invitations/token.ts` mints its own random secret through the same
 * primitive this file uses for both halves of an API key, rather than a second `crypto.getRandomValues`
 * call site with its own base64url encoder — this file's header states the "one cryptographic
 * surface" reasoning once, for every caller.
 */
export function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Mint a key. The only source of one.
 *
 * `crypto.getRandomValues` is a CSPRNG; `Math.random` is not, and the distance between them is the
 * whole of this credential's strength, because §1.2's argument for an unsalted hash is that the
 * entropy is the control.
 */
export async function mintApiKey(): Promise<MintedApiKey> {
  const keyId = randomToken(KEY_ID_BYTES);
  const secret = randomToken(SECRET_BYTES);
  const presented = `${API_KEY_PREFIX}${keyId}_${secret}`;
  // A key this program mints must be a key this program can read back. Asserting it here costs one
  // regex per creation and turns a format change that breaks the parser into a failure at the
  // point of the change rather than at every authentication afterwards.
  if (parsePresentedKey(presented) === null) {
    throw new Error(
      'a freshly minted API key does not match this module’s own parse; the format and the ' +
        'pattern have drifted apart and no key minted now could ever be authenticated.',
    );
  }
  return {
    keyId,
    presented,
    keyHash: await hashApiKeySecret(secret),
    keyPrefix: `${API_KEY_PREFIX}${keyId}`,
  };
}

/**
 * Read a presented key, or `null`.
 *
 * Total and positive: the string has to *match*, anchored at both ends, at both fixed lengths.
 * Every other input — a wrong prefix, a wrong length, a character outside base64url, a trailing
 * newline, an embedded NUL, a non-string — is `null`, which the caller turns into the same 401 it
 * gives an unknown key (R-12 §1.5: a revoked key, an expired key and a key that never existed must
 * be indistinguishable over HTTP, or the 401 becomes an oracle for enumerating retired keys).
 */
export function parsePresentedKey(value: unknown): PresentedKey | null {
  if (typeof value !== 'string') return null;
  const match = PRESENTED_KEY_PATTERN.exec(value);
  if (match === null) return null;
  const keyId = match[1];
  const secret = match[2];
  if (keyId === undefined || secret === undefined) return null;
  return { keyId, secret };
}

/**
 * Read `Authorization: Bearer <key>`, or `null`.
 *
 * The scheme is compared case-insensitively (RFC 9110 makes it case-insensitive) and the rest is
 * handed to {@link parsePresentedKey} unchanged — this function decides nothing about the key.
 */
export function readBearerApiKey(header: unknown): PresentedKey | null {
  const attempt = readBearerApiKeyAttempt(header);
  return attempt.kind === 'presented' ? attempt.key : null;
}

/**
 * Parse an Authorization header without treating a malformed or non-API-key credential as if no
 * credential was supplied. An identity resolver must return unauthenticated for `invalid`; it may
 * consult a session cookie only for `absent`.
 */
export function readBearerApiKeyAttempt(header: unknown): BearerApiKeyAttempt {
  if (header === null || header === undefined) return { kind: 'absent' };
  if (typeof header !== 'string') return { kind: 'invalid' };
  const match = /^Bearer[ ]([^ ]+)$/iu.exec(header.trim());
  if (match === null) return { kind: 'invalid' };
  const key = parsePresentedKey(match[1]);
  return key === null ? { kind: 'invalid' } : { kind: 'presented', key };
}

/** The wire form of a parsed key. The inverse of {@link parsePresentedKey}, exactly. */
export function presentedKeyText(key: PresentedKey): string {
  return `${API_KEY_PREFIX}${key.keyId}_${key.secret}`;
}

/**
 * Constant-time equality over two hex digests.
 *
 * Both operands here are digests of the same fixed length, so a length difference is already a
 * mismatch and revealing it reveals nothing about the secret. The loop still runs over the whole
 * of the longer string so that the time taken does not depend on where the first differing
 * character is, which is the property that matters.
 */
export function hashesEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    difference |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  }
  return difference === 0;
}
