import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { defineObjectStoreContract, type ObjectStoreContractFixture } from './contract.js';
import {
  createS3ObjectStoreProvider,
  createS3ObjectStoreProviderFromConfig,
  ensureS3Bucket,
} from './s3-store.js';

const endpoint = process.env['TEST_S3_ENDPOINT'];

if (endpoint === undefined || endpoint.trim() === '') {
  describe.skip('ObjectStore contract — S3 (SeaweedFS)', () => {
    it('requires TEST_S3_ENDPOINT (the repository test launcher supplies it)', () => undefined);
  });
} else {
  const client = new S3Client({
    endpoint,
    region: process.env['TEST_S3_REGION'] ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env['TEST_S3_ACCESS_KEY_ID'] ?? 'agent_workspace',
      secretAccessKey: process.env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'agent_workspace',
    },
  });

  async function setup(): Promise<ObjectStoreContractFixture> {
    const bucket = `aw-contract-${randomUUID()}`;
    await ensureS3Bucket(client, bucket);
    return {
      provider: createS3ObjectStoreProvider({ client, bucket }),
      teardown: async () => {
        const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
        const objects = (listed.Contents ?? [])
          .filter((entry): entry is typeof entry & { Key: string } => entry.Key !== undefined)
          .map((entry) => ({ Key: entry.Key }));
        if (objects.length > 0) {
          await client.send(
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
          );
        }
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      },
    };
  }

  defineObjectStoreContract('S3 (SeaweedFS)', setup);

  describe('S3 bucket readiness policy', () => {
    it('does not create a missing bucket when native-cloud provisioning is disabled', async () => {
      const bucket = `aw-must-already-exist-${randomUUID()}`;
      await expect(
        createS3ObjectStoreProviderFromConfig(
          {
            bucket,
            region: process.env['TEST_S3_REGION'] ?? 'us-east-1',
            createBucketIfMissing: false,
          },
          client,
        ),
      ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });

      // A second head still fails: the readiness check did not turn a typo into infrastructure.
      await expect(client.send(new ListObjectsV2Command({ Bucket: bucket }))).rejects.toMatchObject(
        { $metadata: { httpStatusCode: 404 } },
      );
    });
  });
}
