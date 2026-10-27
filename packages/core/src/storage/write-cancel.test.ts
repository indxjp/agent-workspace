/** A failed `write` releases its source stream instead of leaving it half-read. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { S3Client } from '@aws-sdk/client-s3';
import { ContainerClient } from '@azure/storage-blob';
import { Storage } from '@google-cloud/storage';
import { describe, expect, it } from 'vitest';

import { createAzureBlobObjectStore, createAzureSdkBlobContainer } from './azure-blob-store.js';
import { createGcsObjectStore, createNativeGcsClient } from './gcs-store.js';
import { UnsafeObjectKeyError } from './key-safety.js';
import { createLocalFilesystemObjectStore } from './local-fs-store.js';
import { createInMemoryObjectStore } from './memory-store.js';
import type { ObjectStoreV2 } from './object-store.js';
import { createS3ObjectStore } from './s3-store.js';

const MIB = 1024 * 1024;

/** A long body that records whether its consumer cancelled it. */
function trackedBody(): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(MIB));
      if (pulls >= 40) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

describe('a failed write cancels its source', () => {
  it('a failed write cancels its source stream', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aw-cancel-'));
    try {
      const store = createLocalFilesystemObjectStore(root);
      await store.write('a', new Uint8Array(1), {});
      const { body, cancelled } = trackedBody();
      // `a` is a file, so `a/b` cannot be created.
      await expect(store.write('a/b', body, {})).rejects.toThrow();
      expect(cancelled()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // No network: each store refuses the key before it would contact its service.
  const rawStores: readonly (readonly [string, () => ObjectStoreV2])[] = [
    ['in-memory', () => createInMemoryObjectStore()],
    ['local filesystem', () => createLocalFilesystemObjectStore(path.join(tmpdir(), 'aw-unused'))],
    [
      'S3',
      () =>
        createS3ObjectStore({
          client: new S3Client({ region: 'us-east-1', endpoint: 'http://127.0.0.1:1' }),
          bucket: 'b',
        }),
    ],
    [
      'GCS',
      () =>
        createGcsObjectStore({
          client: createNativeGcsClient(new Storage({ projectId: 'p' }).bucket('b')),
        }),
    ],
    [
      'Azure Blob',
      () =>
        createAzureBlobObjectStore(
          createAzureSdkBlobContainer(new ContainerClient('https://unit.blob.core.windows.net/c')),
        ),
    ],
  ];

  it.each(rawStores)(
    'the raw %s store cancels the body of a write it refuses the key of',
    async (_name, create) => {
      const { body, cancelled } = trackedBody();
      await expect(create().write('../escape', body, {})).rejects.toThrow(UnsafeObjectKeyError);
      expect(cancelled()).toBe(true);
    },
  );
});
