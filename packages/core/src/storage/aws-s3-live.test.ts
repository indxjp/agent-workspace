import {
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  defineObjectStoreContract,
  defineObjectStoreV2Contract,
  type ObjectStoreV2ContractFixture,
} from './contract.js';
import { createS3ObjectStoreProvider } from './s3-store.js';

const bucket = process.env['TEST_AWS_S3_BUCKET'];

if (bucket === undefined || bucket.trim() === '') {
  console.warn(
    '[storage/aws-s3-live.test.ts] SKIPPED — TEST_AWS_S3_BUCKET is not set, so the ObjectStore ' +
      'contract was NOT exercised against native AWS S3.',
  );
  describe('ObjectStore contract — native AWS S3 live proof', () => {
    it('records that the live proof was not configured in this run', () => {
      expect(bucket?.trim() ?? '').toBe('');
    });
  });
} else {
  const liveBucket = bucket.trim();
  const client = new S3Client({ region: process.env['TEST_AWS_REGION'] ?? 'us-east-1' });

  function fixture(topLevelPrefix: 'files' | 'skills') {
    return async (): Promise<ObjectStoreV2ContractFixture> => {
      const keyPrefix = `${topLevelPrefix}/unit16-proof/${randomUUID()}`;
      await client.send(new HeadBucketCommand({ Bucket: liveBucket }));
      return {
        provider: createS3ObjectStoreProvider({ client, bucket: liveBucket, keyPrefix }),
        teardown: async () => {
          let continuationToken: string | undefined;
          do {
            const listed = await client.send(
              new ListObjectsV2Command({
                Bucket: liveBucket,
                Prefix: `${keyPrefix}/`,
                ...(continuationToken === undefined
                  ? {}
                  : { ContinuationToken: continuationToken }),
              }),
            );
            const objects = (listed.Contents ?? [])
              .filter((entry): entry is typeof entry & { Key: string } => entry.Key !== undefined)
              .map((entry) => ({ Key: entry.Key }));
            if (objects.length > 0) {
              await client.send(
                new DeleteObjectsCommand({ Bucket: liveBucket, Delete: { Objects: objects } }),
              );
            }
            continuationToken =
              listed.IsTruncated === true ? listed.NextContinuationToken : undefined;
          } while (continuationToken !== undefined);
        },
      };
    };
  }

  defineObjectStoreContract('native AWS S3 — files/ prefix', fixture('files'));
  defineObjectStoreContract('native AWS S3 — skills/ prefix', fixture('skills'));
  defineObjectStoreV2Contract('native AWS S3 — files/ prefix', fixture('files'));
  defineObjectStoreV2Contract('native AWS S3 — skills/ prefix', fixture('skills'));
}
