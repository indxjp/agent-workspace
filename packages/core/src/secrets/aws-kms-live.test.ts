import { EncryptCommand, KMSClient, ReEncryptCommand } from '@aws-sdk/client-kms';
import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AWS_KMS_ENCRYPTED_MASTER_KEY_ENV_VAR,
  AWS_KMS_ENCRYPTION_CONTEXT,
  AWS_KMS_KEY_ID_ENV_VAR,
  createAwsKmsMasterKeyProvider,
} from './aws-kms-master-key-provider.js';
import { openSecret, sealSecret } from './envelope.js';

const sourceKeyId = process.env['TEST_AWS_KMS_KEY_ID'];
const destinationKeyId = process.env['TEST_AWS_KMS_ROTATION_KEY_ID'];

if (
  sourceKeyId === undefined ||
  sourceKeyId.trim() === '' ||
  destinationKeyId === undefined ||
  destinationKeyId.trim() === ''
) {
  console.warn(
    '[secrets/aws-kms-live.test.ts] SKIPPED — TEST_AWS_KMS_KEY_ID and ' +
      'TEST_AWS_KMS_ROTATION_KEY_ID are not both set, so KMS decrypt/re-encrypt was NOT proven.',
  );
  describe('AWS KMS master-key provider live proof', () => {
    it('records that the live proof was not configured in this run', () => {
      expect(sourceKeyId?.trim() ?? '').toBe('');
      expect(destinationKeyId?.trim() ?? '').toBe('');
    });
  });
} else {
  const liveSourceKeyId = sourceKeyId.trim();
  const liveDestinationKeyId = destinationKeyId.trim();
  describe('AWS KMS master-key provider live proof', () => {
    it('opens a pre-rotation credential after KMS re-encrypts the wrapped master key', async () => {
      const client = new KMSClient({ region: process.env['TEST_AWS_REGION'] ?? 'us-east-1' });
      const plaintextMasterKey = crypto.randomBytes(32);
      const encrypted = await client.send(
        new EncryptCommand({
          KeyId: liveSourceKeyId,
          Plaintext: plaintextMasterKey,
          EncryptionContext: AWS_KMS_ENCRYPTION_CONTEXT,
          EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        }),
      );
      if (encrypted.CiphertextBlob === undefined) {
        throw new Error('AWS KMS Encrypt returned no ciphertext blob.');
      }

      const before = createAwsKmsMasterKeyProvider({
        env: {
          [AWS_KMS_KEY_ID_ENV_VAR]: liveSourceKeyId,
          [AWS_KMS_ENCRYPTED_MASTER_KEY_ENV_VAR]: Buffer.from(encrypted.CiphertextBlob).toString(
            'base64',
          ),
        },
        client,
      });
      const oldMasterKey = await before.load();
      const envelope = sealSecret(oldMasterKey, Buffer.from('credential-before-kms-rotation'));

      const reEncrypted = await client.send(
        new ReEncryptCommand({
          SourceKeyId: liveSourceKeyId,
          DestinationKeyId: liveDestinationKeyId,
          CiphertextBlob: encrypted.CiphertextBlob,
          SourceEncryptionContext: AWS_KMS_ENCRYPTION_CONTEXT,
          DestinationEncryptionContext: AWS_KMS_ENCRYPTION_CONTEXT,
          SourceEncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          DestinationEncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        }),
      );
      if (reEncrypted.CiphertextBlob === undefined) {
        throw new Error('AWS KMS ReEncrypt returned no ciphertext blob.');
      }

      const after = createAwsKmsMasterKeyProvider({
        env: {
          [AWS_KMS_KEY_ID_ENV_VAR]: liveDestinationKeyId,
          [AWS_KMS_ENCRYPTED_MASTER_KEY_ENV_VAR]: Buffer.from(reEncrypted.CiphertextBlob).toString(
            'base64',
          ),
        },
        client,
      });
      const rotatedMasterKey = await after.load();

      expect(rotatedMasterKey.id).toBe(oldMasterKey.id);
      expect(openSecret(rotatedMasterKey, envelope).toString('utf8')).toBe(
        'credential-before-kms-rotation',
      );
    });
  });
}
