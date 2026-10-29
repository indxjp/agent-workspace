import { randomUUID } from 'node:crypto';

import { Storage } from '@google-cloud/storage';
import { describe, expect, it, vi } from 'vitest';

import { defineObjectStoreContract, type ObjectStoreContractFixture } from './contract.js';
import { createGcsObjectStoreProviderFromConfig } from './gcs-store.js';
import { readWhole } from './streams.js';

// Real GCS round trips take seconds, not the 5 s default; as azure-live.vitest.config.mjs does.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const bucket = process.env['TEST_GCS_BUCKET']?.trim();
const projectId = process.env['TEST_GCP_PROJECT']?.trim();
const hasLiveBucket = bucket !== undefined && bucket !== '';

async function setup(): Promise<ObjectStoreContractFixture> {
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
    signedUrlsFetchable: true,
    refusesExpiredSigning: true,
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
        await files.write('proof.txt', bytes, {});
        await skills.write('proof.txt', bytes, {});
        expect(Buffer.from((await readWhole(files, 'proof.txt'))?.body ?? [])).toEqual(
          Buffer.from(bytes),
        );
        expect(Buffer.from((await readWhole(skills, 'proof.txt'))?.body ?? [])).toEqual(
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
