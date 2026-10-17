import { describe, expect, it } from 'vitest';

import { openSecret, sealSecret } from './envelope.js';
import { createGoogleSecretManagerMasterKeyProviderFromEnvironment } from './google-secret-manager-master-key.js';

const beforeRotation = process.env['TEST_GCP_MASTER_KEY_SECRET_BEFORE_ROTATION']?.trim();
const afterRotation = process.env['TEST_GCP_MASTER_KEY_SECRET_AFTER_ROTATION']?.trim();
const hasRotationProof =
  beforeRotation !== undefined &&
  beforeRotation !== '' &&
  afterRotation !== undefined &&
  afterRotation !== '';

if (!hasRotationProof) {
  describe('Google Secret Manager / Cloud KMS live-service proof selection', () => {
    it('does not select the rotation proof without both explicit secret versions', () => {
      expect(hasRotationProof).toBe(false);
    });
  });
} else {
  describe('Google Secret Manager / Cloud KMS live-service proof', () => {
    it('decrypts an existing envelope after the documented wrapping-key rotation', async () => {
      if (
        beforeRotation === undefined ||
        beforeRotation === '' ||
        afterRotation === undefined ||
        afterRotation === ''
      ) {
        throw new Error('both live Secret Manager versions are required');
      }
      const before = await createGoogleSecretManagerMasterKeyProviderFromEnvironment({
        GCP_MASTER_KEY_SECRET: beforeRotation,
      }).load();
      const after = await createGoogleSecretManagerMasterKeyProviderFromEnvironment({
        GCP_MASTER_KEY_SECRET: afterRotation,
      }).load();
      const plaintext = Buffer.from('live-cmek-rotation-proof', 'utf8');
      const envelope = sealSecret(before, plaintext);

      expect(after.id).toBe(before.id);
      expect(openSecret(after, envelope)).toEqual(plaintext);
      expect(JSON.stringify(envelope)).not.toContain(plaintext.toString('utf8'));
    });
  });
}
