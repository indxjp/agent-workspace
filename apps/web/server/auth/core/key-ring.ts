/**
 * One key per purpose (refactoring part 06, step 5). `SESSION_SECRET` used to key six jobs
 * directly: the session, workspace-selection and invitation-identity cookies, the OIDC
 * transaction, CLI device codes and the public-share visitor key. A token signed for one could
 * only be told apart from another by its format. Each job now signs with its own key, derived from
 * the secret with HKDF-SHA-256 (RFC 5869) and a purpose label, so a signature made for one purpose
 * never verifies for another.
 *
 * This module holds the labels, the derivation's parameters and the roll-over rule, and derives a
 * key through the Web Crypto port its caller passes in: it is a `core/`, so it may not touch the
 * `crypto` global (`domain-core-is-pure` and the core globals ban). The signing modules pass
 * `crypto.subtle`; the two synchronous Node readers derive the same bytes with `node:crypto`'s
 * `hkdfSync` from {@link keyDerivation}, and a test holds the two paths equal.
 */

/** Every job the deployment secret keys. A new job adds a label here, never reuses one. */
export const KEY_PURPOSES = [
  'session',
  'workspace-selection',
  'invitation-identity',
  'oidc-transaction',
  'cli-device-code',
  'share-visitor',
] as const;

export type KeyPurpose = (typeof KEY_PURPOSES)[number];

/** Bytes in a derived key: SHA-256's output, the HMAC-SHA-256 key size RFC 2104 recommends. */
export const PURPOSE_KEY_BYTES = 32;

const encoder = new TextEncoder();

/** A fixed, public salt: RFC 5869 §3.1 allows it, and it keeps the keys apart from any other HKDF use. */
const SALT = 'agent-workspace/key-ring';

/** What HKDF is given for `purpose`. The `v1` lets a later step change the derivation without reusing a label. */
export interface KeyDerivation {
  readonly hash: 'SHA-256';
  readonly salt: Uint8Array<ArrayBuffer>;
  readonly info: Uint8Array<ArrayBuffer>;
  readonly lengthBytes: number;
}

export function keyDerivation(purpose: KeyPurpose): KeyDerivation {
  return {
    hash: 'SHA-256',
    salt: encoder.encode(SALT),
    info: encoder.encode(`agent-workspace/${purpose}/v1`),
    lengthBytes: PURPOSE_KEY_BYTES,
  };
}

/** The two Web Crypto calls a derivation needs; `crypto.subtle` satisfies it. */
export type HkdfPort = Pick<SubtleCrypto, 'importKey' | 'deriveBits'>;

/** The key for `purpose`, derived from the deployment secret. */
export async function derivePurposeKey(
  subtle: HkdfPort,
  secret: string,
  purpose: KeyPurpose,
): Promise<Uint8Array<ArrayBuffer>> {
  const derivation = keyDerivation(purpose);
  const material = await subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: derivation.hash, salt: derivation.salt, info: derivation.info },
    material,
    derivation.lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * The roll-over. A token is signed only with its purpose key. A verifier also accepts the key
 * every token was signed with before this change (the raw secret), so a deploy signs nobody out
 * and breaks no sign-in, invitation or `aw login` in flight: a session lives at most twelve hours
 * and the other signed tokens ten minutes, so no token signed the old way is still valid twelve
 * hours after the deploy. Accepting the old key is no weaker than before this change. Removing it
 * is the next step's change (part 06 step 6, the single token codec), after one release.
 *
 * The visitor key is not a token and has no roll-over: its prefix moves to `v2_`, so a key derived
 * the old way can never match a new one (runnable public links are still off, release gate D-06).
 *
 * Callers pass each key as a thunk, so the old key is only made when the purpose key did not
 * verify, and a failure making it can never go unhandled.
 */
export function verificationKeys<K>(purposeKey: K, legacyKey: K): readonly K[] {
  return [purposeKey, legacyKey];
}
