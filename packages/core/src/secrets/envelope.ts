/**
 * Sealing and opening one secret's envelope — the layer between {@link ../secrets/crypto.js}'s raw
 * AEAD primitives and `packages/core/src/db/schema/secrets.ts`'s row shape.
 *
 * A sealed envelope carries exactly the seven parts the schema's CHECK constraints require: the
 * algorithm, which master key wrapped the data key, the wrapped data key and its nonce and tag,
 * and the ciphertext and its own nonce and tag. Two independent AEAD encryptions happen here —
 * wrapping the data key under the master key, and encrypting the plaintext under the data key —
 * and each gets its own nonce, because they are two different keys and reusing a nonce would only
 * be a coincidence away from reusing one under the same key.
 */
import { ENVELOPE_ALGORITHM, generateDataKey, open, seal } from './crypto.js';
import type { MasterKey } from './master-key.js';

/** One secret's envelope, in exactly the shape `secrets` (the table) stores it. */
export interface SecretEnvelope {
  readonly algorithm: typeof ENVELOPE_ALGORITHM;
  readonly masterKeyId: string;
  readonly wrappedDataKey: Buffer;
  readonly wrappedDataKeyNonce: Buffer;
  readonly wrappedDataKeyTag: Buffer;
  readonly ciphertext: Buffer;
  readonly ciphertextNonce: Buffer;
  readonly ciphertextTag: Buffer;
}

/**
 * Seal `plaintext` into a fresh envelope: generate a data key, encrypt the plaintext under it,
 * wrap the data key under `masterKey`.
 */
export function sealSecret(masterKey: MasterKey, plaintext: Buffer): SecretEnvelope {
  const dataKey = generateDataKey();
  const value = seal(dataKey, plaintext);
  const wrapped = seal(masterKey.key, dataKey);
  return {
    algorithm: ENVELOPE_ALGORITHM,
    masterKeyId: masterKey.id,
    wrappedDataKey: wrapped.ciphertext,
    wrappedDataKeyNonce: wrapped.nonce,
    wrappedDataKeyTag: wrapped.tag,
    ciphertext: value.ciphertext,
    ciphertextNonce: value.nonce,
    ciphertextTag: value.tag,
  };
}

/**
 * Thrown when an envelope names a master key id that is not the one this process has loaded.
 *
 * Checked and named **before** any AES-GCM call is attempted. Attempting to unwrap under the
 * wrong key would also fail — GCM's tag check would reject it — but it would fail with an opaque
 * "unsupported state or unable to authenticate data" from OpenSSL. Naming the mismatch here gives
 * an operator the actual, actionable fact: which key this row expects and which key is configured.
 */
export class MasterKeyMismatchError extends Error {
  public readonly expected: string;
  public readonly configured: string;

  public constructor(expected: string, configured: string) {
    super(
      `this secret was wrapped under master key "${expected}", but the configured ` +
        `master-key provider returned fingerprint "${configured}". Decrypting it needs the master ` +
        'key that wrapped it — this is what a rotation in progress, or a deployment pointed at ' +
        'the wrong key, looks like.',
    );
    this.name = 'MasterKeyMismatchError';
    this.expected = expected;
    this.configured = configured;
  }
}

/**
 * Open a {@link SecretEnvelope}: unwrap its data key under `masterKey`, then decrypt its
 * ciphertext under the data key. Returns the plaintext.
 *
 * Throws {@link MasterKeyMismatchError} on a recorded master key id that does not match
 * `masterKey`, and otherwise propagates whatever `node:crypto` throws on a failed authentication
 * tag (a tampered or corrupted row). There is no case in which this function returns a value that
 * has not been through both AEAD verifications.
 */
export function openSecret(masterKey: MasterKey, envelope: SecretEnvelope): Buffer {
  if (envelope.masterKeyId !== masterKey.id) {
    throw new MasterKeyMismatchError(envelope.masterKeyId, masterKey.id);
  }
  const dataKey = open(masterKey.key, {
    ciphertext: envelope.wrappedDataKey,
    nonce: envelope.wrappedDataKeyNonce,
    tag: envelope.wrappedDataKeyTag,
  });
  return open(dataKey, {
    ciphertext: envelope.ciphertext,
    nonce: envelope.ciphertextNonce,
    tag: envelope.ciphertextTag,
  });
}
