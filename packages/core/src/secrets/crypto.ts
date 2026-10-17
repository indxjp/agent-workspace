/**
 * Envelope encryption's cryptographic primitives — spec §23, §26.
 *
 * "Envelope encryption" means the deployment master key never touches a secret's plaintext
 * directly. Each secret gets its own randomly generated **data key**; the data key encrypts the
 * plaintext, and the master key encrypts (wraps) the data key. Two consequences follow, and both
 * are why this shape and not "just encrypt with the master key":
 *
 *   * Compromising one ciphertext exposes at most one data key, wrapped, which is still useless
 *     without the master key.
 *   * Rotating the master key means re-wrapping every data key, not re-encrypting every value —
 *     `packages/core/src/db/schema/secrets.ts`'s header says the same thing from the schema side.
 *
 * ## Why `node:crypto` and not a hand-rolled construction
 *
 * Spec §40: "do not reimplement security-sensitive standards such as cryptography … use mature
 * libraries there." Node's built-in `crypto` module implements AES-256-GCM in OpenSSL, ships with
 * every supported Node version (no dependency to add or pin), and is what
 * the Wave 2 plan's design notes for this task name directly. There is nothing to
 * hand-roll here: the whole of this file is "call `createCipheriv`/`createDecipheriv` correctly
 * and never let a caller skip the authentication tag."
 *
 * ## What "correctly" means for AES-GCM specifically
 *
 * * A fresh, random 96-bit (12-byte) nonce/IV for every encryption, per NIST SP 800-38D §5.2.1.1 —
 *   reusing a nonce under the same key breaks GCM's authentication guarantee entirely, not just
 *   its confidentiality. `crypto.randomBytes` is used for every nonce and every data key, and
 *   nothing here accepts a caller-supplied nonce.
 * * The 128-bit authentication tag is carried alongside the ciphertext, never dropped, and
 *   decryption calls `setAuthTag` before the final `decipher.final()` — the call that actually
 *   verifies it. Skipping that call does not fail; it silently returns unauthenticated plaintext.
 * * A failed tag check throws out of `decipher.final()`, and this module adds nothing to catch or
 *   soften that: a ciphertext that fails authentication is not a secret this module will produce a
 *   guess about.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** The one algorithm this module implements, and the one value `secrets.algorithm` may hold. */
export const ENVELOPE_ALGORITHM = 'aes-256-gcm' as const;

/** AES-256 key length, in bytes — both the master key and every data key. */
export const KEY_BYTES = 32;
/** GCM's recommended nonce length, in bytes (NIST SP 800-38D §5.2.1.1). */
export const NONCE_BYTES = 12;
/** GCM's full authentication tag length, in bytes. */
export const TAG_BYTES = 16;

/** One AEAD encryption's output: the three parts a caller must keep together to decrypt it. */
export interface SealedBytes {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
}

/** Generate a fresh, random AES-256 key — used for a new secret's data key. */
export function generateDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Encrypt `plaintext` under `key` with AES-256-GCM, using a freshly generated nonce.
 *
 * Throws if `key` is not exactly {@link KEY_BYTES} long — a positive assertion the caller's own
 * type cannot make, since both the master key and a data key arrive here as `Buffer` (ADR-0015).
 */
export function seal(key: Buffer, plaintext: Buffer): SealedBytes {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `an AES-256-GCM key must be ${String(KEY_BYTES)} bytes; received ${String(key.length)}.`,
    );
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ENVELOPE_ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, nonce, tag };
}

/**
 * Decrypt a {@link SealedBytes} under `key`, verifying its authentication tag.
 *
 * Throws — rather than returning `null` or an empty buffer — when `key` is the wrong length, or
 * when the ciphertext, nonce or tag have been altered. There is no partial or "best effort"
 * result: a tag that does not verify means this is not the plaintext that was sealed, and handing
 * back anything would be a fallback to a value that was never authenticated.
 */
export function open(key: Buffer, sealed: SealedBytes): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `an AES-256-GCM key must be ${String(KEY_BYTES)} bytes; received ${String(key.length)}.`,
    );
  }
  if (sealed.nonce.length !== NONCE_BYTES) {
    throw new Error(
      `an AES-256-GCM nonce must be ${String(NONCE_BYTES)} bytes; received ${String(sealed.nonce.length)}.`,
    );
  }
  if (sealed.tag.length !== TAG_BYTES) {
    throw new Error(
      `an AES-256-GCM authentication tag must be ${String(TAG_BYTES)} bytes; received ${String(sealed.tag.length)}.`,
    );
  }
  const decipher = createDecipheriv(ENVELOPE_ALGORITHM, key, sealed.nonce);
  // Set BEFORE `final()`. `final()` is what actually checks the tag; a decipher that never had a
  // tag set throws a different, earlier error rather than silently skipping verification, but
  // calling `setAuthTag` after `update`/before `final` is the documented, correct order.
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}
