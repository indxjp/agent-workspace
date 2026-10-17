import crypto from 'node:crypto';

import type { DecryptCommand, DecryptCommandOutput } from '@aws-sdk/client-kms';
import { describe, expect, it } from 'vitest';

import {
  AWS_KMS_ENCRYPTED_MASTER_KEY_ENV_VAR,
  AWS_KMS_ENCRYPTION_CONTEXT,
  AWS_KMS_KEY_ID_ENV_VAR,
  AwsKmsMasterKeyError,
  createAwsKmsMasterKeyProvider,
  type AwsKmsDecryptClient,
} from './aws-kms-master-key-provider.js';

const KEY_ID = 'arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-000000000000';
const CIPHERTEXT = Buffer.from('kms-ciphertext-blob').toString('base64');

function output(plaintext: Uint8Array): DecryptCommandOutput {
  return {
    Plaintext: plaintext,
    KeyId: KEY_ID,
    EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
    $metadata: {},
  };
}

function providerWith(client: AwsKmsDecryptClient, encryptedMasterKey = CIPHERTEXT) {
  return createAwsKmsMasterKeyProvider({
    env: {
      [AWS_KMS_KEY_ID_ENV_VAR]: KEY_ID,
      [AWS_KMS_ENCRYPTED_MASTER_KEY_ENV_VAR]: encryptedMasterKey,
    },
    client,
  });
}

describe('the AWS KMS master-key provider', () => {
  it('decrypts with the configured key id, fixed context and symmetric algorithm', async () => {
    const plaintext = crypto.randomBytes(32);
    let received: DecryptCommand | undefined;
    const provider = providerWith({
      send(command) {
        received = command;
        return Promise.resolve(output(plaintext));
      },
    });

    const masterKey = await provider.load();

    expect(provider.backend).toBe('kms');
    expect(masterKey.key).toEqual(plaintext);
    expect(masterKey.id).toMatch(/^[0-9a-f]{16}$/u);
    expect(received?.input).toMatchObject({
      KeyId: KEY_ID,
      CiphertextBlob: Buffer.from(CIPHERTEXT, 'base64'),
      EncryptionContext: AWS_KMS_ENCRYPTION_CONTEXT,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
    });
  });

  it('refuses missing configuration before constructing or calling a client', async () => {
    for (const env of [
      {},
      { [AWS_KMS_KEY_ID_ENV_VAR]: KEY_ID },
      { [AWS_KMS_ENCRYPTED_MASTER_KEY_ENV_VAR]: CIPHERTEXT },
    ]) {
      const provider = createAwsKmsMasterKeyProvider({ env });
      await expect(provider.load()).rejects.toBeInstanceOf(AwsKmsMasterKeyError);
    }
  });

  it('refuses non-canonical and empty base64 ciphertext before calling KMS', async () => {
    let calls = 0;
    const client: AwsKmsDecryptClient = {
      send() {
        calls += 1;
        return Promise.resolve(output(crypto.randomBytes(32)));
      },
    };
    for (const ciphertext of ['not base64', 'YQ', '====']) {
      await expect(providerWith(client, ciphertext).load()).rejects.toThrow(/canonical base64/u);
    }
    await expect(providerWith(client, '').load()).rejects.toThrow(/is required/u);
    expect(calls).toBe(0);
  });

  it('refuses a missing or wrong-length plaintext key', async () => {
    const missing: AwsKmsDecryptClient = {
      send: () => Promise.resolve({ $metadata: {} }),
    };
    await expect(providerWith(missing).load()).rejects.toThrow(/no plaintext/u);

    const short: AwsKmsDecryptClient = {
      send: () => Promise.resolve(output(crypto.randomBytes(16))),
    };
    await expect(providerWith(short).load()).rejects.toThrow(/not 32 bytes/u);
  });

  it('keeps provider failures, ciphertext and key bytes out of its error surface', async () => {
    const providerSecret = 'kms-driver-secret-do-not-print';
    const plaintextSecret = 'plaintext-key-do-not-print';
    const ciphertext = Buffer.from('ciphertext-do-not-print').toString('base64');
    const client: AwsKmsDecryptClient = {
      send: () => Promise.reject(new Error(providerSecret)),
    };

    try {
      await providerWith(client, ciphertext).load();
      expect.fail('expected KMS load to fail');
    } catch (error) {
      const rendered =
        error instanceof Error ? `${error.name}\n${error.message}\n${error.stack}` : String(error);
      expect(rendered).not.toContain(providerSecret);
      expect(rendered).not.toContain(plaintextSecret);
      expect(rendered).not.toContain(ciphertext);
      expect(rendered).not.toContain(KEY_ID);
    }
  });

  it('preserves the fingerprint when KMS rotation or re-encryption preserves the plaintext', async () => {
    const plaintext = crypto.randomBytes(32);
    const oldProvider = providerWith({ send: () => Promise.resolve(output(plaintext)) });
    const rotatedCiphertext = Buffer.from('rotated-kms-ciphertext').toString('base64');
    const rotatedProvider = providerWith(
      { send: () => Promise.resolve(output(plaintext)) },
      rotatedCiphertext,
    );

    const [oldKey, rotatedKey] = await Promise.all([oldProvider.load(), rotatedProvider.load()]);
    expect(rotatedKey.id).toBe(oldKey.id);
    expect(rotatedKey.key).toEqual(oldKey.key);
  });
});
