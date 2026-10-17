import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ENVELOPE_ALGORITHM } from './crypto.js';
import { MasterKeyMismatchError, openSecret, sealSecret } from './envelope.js';
import { loadMasterKey, MASTER_KEY_ENV_VAR, type MasterKey } from './master-key.js';

function key(): MasterKey {
  return loadMasterKey({ [MASTER_KEY_ENV_VAR]: crypto.randomBytes(32).toString('hex') });
}

describe('sealSecret / openSecret', () => {
  it('round-trips a plaintext value through two layers of AES-256-GCM', () => {
    const masterKey = key();
    const plaintext = Buffer.from('sk-ant-api03-abcdefg', 'utf8');
    const envelope = sealSecret(masterKey, plaintext);

    expect(envelope.algorithm).toBe(ENVELOPE_ALGORITHM);
    expect(envelope.masterKeyId).toBe(masterKey.id);
    // Every part an envelope must carry (packages/core/src/db/schema/secrets.ts's CHECKs), all
    // present and none of them the plaintext.
    for (const part of [
      envelope.wrappedDataKey,
      envelope.wrappedDataKeyNonce,
      envelope.wrappedDataKeyTag,
      envelope.ciphertext,
      envelope.ciphertextNonce,
      envelope.ciphertextTag,
    ]) {
      expect(Buffer.isBuffer(part)).toBe(true);
      expect(part.includes(plaintext)).toBe(false);
    }

    expect(openSecret(masterKey, envelope).equals(plaintext)).toBe(true);
  });

  it('seals the same plaintext twice into two different data keys and two different ciphertexts', () => {
    const masterKey = key();
    const plaintext = Buffer.from('same-value-both-times', 'utf8');
    const first = sealSecret(masterKey, plaintext);
    const second = sealSecret(masterKey, plaintext);
    expect(first.wrappedDataKey.equals(second.wrappedDataKey)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('refuses to open under a different master key, naming both fingerprints', () => {
    const sealedUnder = key();
    const configured = key();
    const envelope = sealSecret(sealedUnder, Buffer.from('value'));
    expect(() => openSecret(configured, envelope)).toThrow(MasterKeyMismatchError);
    try {
      openSecret(configured, envelope);
      expect.fail('expected a MasterKeyMismatchError');
    } catch (error) {
      expect(error).toBeInstanceOf(MasterKeyMismatchError);
      const mismatch = error as MasterKeyMismatchError;
      expect(mismatch.expected).toBe(sealedUnder.id);
      expect(mismatch.configured).toBe(configured.id);
    }
  });

  it('refuses to open when the ciphertext was tampered with after sealing', () => {
    const masterKey = key();
    const envelope = sealSecret(masterKey, Buffer.from('value'));
    const tampered = { ...envelope, ciphertext: Buffer.from(envelope.ciphertext) };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => openSecret(masterKey, tampered)).toThrow();
  });

  it('refuses to open when the wrapped data key was tampered with after sealing', () => {
    const masterKey = key();
    const envelope = sealSecret(masterKey, Buffer.from('value'));
    const tampered = { ...envelope, wrappedDataKey: Buffer.from(envelope.wrappedDataKey) };
    tampered.wrappedDataKey[0] = (tampered.wrappedDataKey[0] ?? 0) ^ 0xff;
    expect(() => openSecret(masterKey, tampered)).toThrow();
  });
});
