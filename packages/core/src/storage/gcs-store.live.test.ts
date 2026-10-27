import { randomUUID } from 'node:crypto';

import { Storage } from '@google-cloud/storage';
import { describe, expect, it } from 'vitest';

import {
  defineObjectStoreContract,
  defineObjectStoreV2Contract,
  type ObjectStoreV2ContractFixture,
} from './contract.js';
import { createGcsObjectStoreProviderFromConfig } from './gcs-store.js';

const bucket = process.env['TEST_GCS_BUCKET']?.trim();
const projectId = process.env['TEST_GCP_PROJECT']?.trim();
const hasLiveBucket = bucket !== undefined && bucket !== '';

async function setup(): Promise<ObjectStoreV2ContractFixture> {
  if (bucket === undefined || bucket === '') {
    throw new Error('TEST_GCS_BUCKET is required for the live GCS suite.');
  }
  const keyPrefix = `agent-workspace-live-${randomUUID()}`;
  const provider = await createGcsObjectStoreProviderFromConfig({
    bucket,
    keyPrefix,
    ...(projectId === undefined || projectId === '' ? {} : { projectId }),
  });
  return {
    provider,
    async teardown(): Promise<void> {
      const storage = new Storage(projectId === undefined || projectId === '' ? {} : { projectId });
      await storage.bucket(bucket).deleteFiles({ prefix: `${keyPrefix}/`, force: true });
    },
  };
}

if (!hasLiveBucket) {
  describe('GCS live-service proof selection', () => {
    it('does not select the live contract without an explicit TEST_GCS_BUCKET', () => {
      expect(hasLiveBucket).toBe(false);
    });
  });
} else {
  describe('GCS live-service proof', () => {
    defineObjectStoreContract('Google Cloud Storage (live service)', setup);
    defineObjectStoreV2Contract('Google Cloud Storage (live service)', setup);

    it('round-trips the files and skills prefixes without crossing them', async () => {
      if (bucket === undefined || bucket === '') throw new Error('TEST_GCS_BUCKET is required');
      const keyPrefix = `agent-workspace-live-${randomUUID()}`;
      const common = {
        bucket,
        ...(projectId === undefined || projectId === '' ? {} : { projectId }),
      };
      const files = (
        await createGcsObjectStoreProviderFromConfig({ ...common, keyPrefix: `${keyPrefix}/files` })
      ).forWorkspace('11111111-1111-4111-8111-111111111111');
      const skills = (
        await createGcsObjectStoreProviderFromConfig({
          ...common,
          keyPrefix: `${keyPrefix}/skills`,
        })
      ).forWorkspace('11111111-1111-4111-8111-111111111111');
      try {
        const bytes = new TextEncoder().encode('live-prefix-proof');
        await files.put('proof.txt', { body: bytes });
        await skills.put('proof.txt', { body: bytes });
        expect(Buffer.from((await files.get('proof.txt'))?.body ?? [])).toEqual(Buffer.from(bytes));
        expect(Buffer.from((await skills.get('proof.txt'))?.body ?? [])).toEqual(
          Buffer.from(bytes),
        );
      } finally {
        const storage = new Storage(
          projectId === undefined || projectId === '' ? {} : { projectId },
        );
        await storage.bucket(bucket).deleteFiles({ prefix: `${keyPrefix}/`, force: true });
      }
    });
  });
}
