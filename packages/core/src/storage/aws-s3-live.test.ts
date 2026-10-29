import {
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { defineObjectStoreContract, type ObjectStoreContractFixture } from './contract.js';
import { createS3ObjectStoreProviderFromConfig } from './s3-store.js';

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
  const region = process.env['TEST_AWS_REGION'] ?? 'us-east-1';
  const client = new S3Client({ region });

  function fixture(topLevelPrefix: 'files' | 'skills') {
    return async (): Promise<ObjectStoreContractFixture> => {
      const keyPrefix = `${topLevelPrefix}/unit16-proof/${randomUUID()}`;
      await client.send(new HeadBucketCommand({ Bucket: liveBucket }));
      return {
        // Opened as a deployment opens it, naming no listing order: with no endpoint the store
        // must pick AWS's native-name paging (folder `a/` after file `a.txt`) by itself.
        provider: await createS3ObjectStoreProviderFromConfig(
          { bucket: liveBucket, region, keyPrefix, createBucketIfMissing: false },
          client,
        ),
        signedUrlsFetchable: true,
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
}
