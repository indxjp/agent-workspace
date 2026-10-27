/**
 * Load round trips per object-store backend: write a generated body through the store, read it
 * back, compare SHA-256, and assert the process RSS grew by less than 64 MiB.
 *
 * The payload is at least 256 MiB even by default, so a backend that buffers the body grows RSS
 * past the bound on every run, not only with `AW_LOAD_TESTS=1` (1 GiB). The in-memory backend is
 * exempt: it holds its bytes in RAM by design. Each emulator-backed case runs under the same gate
 * as its contract suite: S3 (SeaweedFS) `TEST_S3_ENDPOINT`, Azure Blob (Azurite) `TEST_AZURITE_URL`,
 * Google Cloud Storage (fake-gcs-server) `TEST_GCS_ENDPOINT`. ci.yml runs this file at 1 GiB and
 * requires all four non-memory cases to pass (the storage design, §07 "Load test").
 */
import { DeleteBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { BlobServiceClient } from '@azure/storage-blob';
import { Storage } from '@google-cloud/storage';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createAzureBlobObjectStoreProvider,
  createAzureSdkBlobContainer,
  createGcsObjectStoreProvider,
  createNativeGcsClient,
} from '@agent-workspace/core/storage/backends';
import { openObjectStore, type ObjectStoreV2 } from '@agent-workspace/core/storage';
import { expect, it } from 'vitest';

import { generatedBody, LOAD_BYTES, MiB, peakRssGrowth, warmHttpTransport } from './flat-memory.js';

const PAYLOAD_BYTES = Math.max(LOAD_BYTES, 256 * MiB);
// Collecting every 4 MiB keeps uncollected socket-read garbage out of the reading (PR #1747).
const SAMPLE_EVERY = 4 * MiB;
const RSS_BOUND = 64 * MiB;

function defineLoadRoundTrip(
  label: string,
  open: () => Promise<{ store: ObjectStoreV2; teardown: () => Promise<void> }>,
): void {
  it(`[load] ${label}: 1 GiB round-trips with flat memory`, { timeout: 300_000 }, async () => {
    const { store, teardown } = await open();
    try {
      await warmHttpTransport();
      const { body, sha256 } = generatedBody(PAYLOAD_BYTES);
      let readDigest = '';
      const growth = await peakRssGrowth(async (sample) => {
        let written = 0;
        const sampled = body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              controller.enqueue(chunk);
              written += chunk.byteLength;
              if (written % SAMPLE_EVERY === 0) sample();
            },
          }),
        );
        const meta = await store.write('load/big.bin', sampled, {
          contentType: 'application/octet-stream',
        });
        expect(meta.sizeBytes).toBe(PAYLOAD_BYTES);

        const object = await store.read('load/big.bin');
        if (object === null) throw new Error('the object just written is missing');
        const hash = createHash('sha256');
        let read = 0;
        await object.body.pipeTo(
          new WritableStream<Uint8Array>({
            write(chunk) {
              hash.update(chunk);
              read += chunk.byteLength;
              if (read % SAMPLE_EVERY === 0) sample();
            },
          }),
        );
        expect(read).toBe(PAYLOAD_BYTES);
        readDigest = hash.digest('hex');
      });
      console.info(
        `[load] ${label}: peak RSS growth ${(growth / MiB).toFixed(1)} MiB of ${String(PAYLOAD_BYTES / MiB)} MiB`,
      );
      // Before the digest: a buffering store also reads back reused generator bytes, and the
      // memory bound is the failure this test exists to name.
      expect(growth).toBeLessThan(RSS_BOUND);
      expect(readDigest).toBe(await sha256);
    } finally {
      await teardown();
    }
  });
}

defineLoadRoundTrip('local filesystem', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aw-load-'));
  return {
    store: (await openObjectStore({ kind: 'file', root: dir }, 'files')).forWorkspace(randomUUID()),
    teardown: () => rm(dir, { recursive: true, force: true }),
  };
});

const s3Endpoint = process.env['TEST_S3_ENDPOINT']?.trim() ?? '';
if (s3Endpoint !== '') {
  defineLoadRoundTrip('S3 (SeaweedFS)', async () => {
    const region = process.env['TEST_S3_REGION'] ?? 'us-east-1';
    const accessKeyId = process.env['TEST_S3_ACCESS_KEY_ID'] ?? 'agent_workspace';
    const secretAccessKey = process.env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'agent_workspace';
    const bucket = `aw-load-${randomUUID()}`;
    const workspace = randomUUID();
    const provider = await openObjectStore(
      { kind: 's3', bucket, prefix: '', endpoint: s3Endpoint, region, forcePathStyle: true },
      'files',
      { credentials: { accessKeyId, secretAccessKey } },
    );
    const store = provider.forWorkspace(workspace);
    return {
      store,
      teardown: async () => {
        await store.delete('load/big.bin');
        const client = new S3Client({
          endpoint: s3Endpoint,
          region,
          forcePathStyle: true,
          credentials: { accessKeyId, secretAccessKey },
        });
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        client.destroy();
      },
    };
  });
}

const azuriteUrl = process.env['TEST_AZURITE_URL']?.trim() ?? '';
if (azuriteUrl !== '') {
  defineLoadRoundTrip('Azure Blob (Azurite)', async () => {
    // Azurite's well-known development account, read from the SDK so no key literal lives here.
    const service = new BlobServiceClient(
      azuriteUrl,
      BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true').credential,
    );
    const container = service.getContainerClient(`aw-load-${randomUUID()}`);
    await container.create();
    return {
      store: createAzureBlobObjectStoreProvider(
        createAzureSdkBlobContainer(container, service),
      ).forWorkspace(randomUUID()),
      teardown: async () => {
        await container.delete();
      },
    };
  });
}

const gcsEndpoint = process.env['TEST_GCS_ENDPOINT']?.trim() ?? '';
if (gcsEndpoint !== '') {
  defineLoadRoundTrip('Google Cloud Storage (fake-gcs-server)', async () => {
    const storage = new Storage({ apiEndpoint: gcsEndpoint, projectId: 'aw-load' });
    const [bucket] = await storage.createBucket(`aw-load-${randomUUID()}`);
    return {
      store: createGcsObjectStoreProvider({ client: createNativeGcsClient(bucket) }).forWorkspace(
        randomUUID(),
      ),
      teardown: async () => {
        await bucket.deleteFiles({ force: true });
        await bucket.delete();
      },
    };
  });
}
