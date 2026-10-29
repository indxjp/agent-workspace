import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { describe, expect, it } from 'vitest';

import { defineObjectStoreContract, type ObjectStoreContractFixture } from './contract.js';
import {
  createAzureBlobObjectStoreProvider,
  createAzureSdkBlobContainer,
} from './azure-blob-store.js';
import { ObjectConflictError } from './object-store.js';
import { readWhole } from './streams.js';

function requiredServiceUrl(): string {
  const value = process.env['AZURE_BLOB_LIVE_SERVICE_URL']?.trim();
  if (value === undefined || value === '') {
    throw new Error('AZURE_BLOB_LIVE_SERVICE_URL is required for the live proof.');
  }
  return value;
}

const serviceUrl = requiredServiceUrl();
const service = new BlobServiceClient(serviceUrl, new DefaultAzureCredential());

async function setup(): Promise<ObjectStoreContractFixture> {
  const name = `aw-sdk16-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const container = service.getContainerClient(name);
  await container.create();
  // With the service client the store signs through a user delegation key, as a deployment does.
  const client = createAzureSdkBlobContainer(container, service);
  await client.assertReady();
  return {
    provider: createAzureBlobObjectStoreProvider(client),
    teardown: () => container.deleteIfExists().then(() => undefined),
    signedUrlsFetchable: true,
  };
}

defineObjectStoreContract('Azure Blob (live)', setup);

describe('Azure Blob live storage proof', () => {
  it('round-trips files and skills prefixes through a temporary real container', async () => {
    const name = `aw-sdk16-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const container = service.getContainerClient(name);
    await container.create();
    try {
      const client = createAzureSdkBlobContainer(container);
      await client.assertReady();
      for (const prefix of ['files', 'skills']) {
        const store = createAzureBlobObjectStoreProvider(client, prefix).forWorkspace(
          '00000000-0000-4000-8000-000000000001',
        );
        await store.write('proof/value.txt', Buffer.from(`azure-${prefix}`), {
          contentType: 'text/plain',
        });
        const value = await readWhole(store, 'proof/value.txt');
        expect(value?.body.toString()).toBe(`azure-${prefix}`);
        expect(value?.contentType).toBe('text/plain');
      }
    } finally {
      await container.deleteIfExists();
    }
  }, 60_000);
});

describe('Azure Blob live: ifMatch on a missing blob', () => {
  // Azurite answers 412 ConditionNotMet (azure-blob-store.test.ts), and so does Azure: observed on
  // 2026-10-29 against a StorageV2 account in eastus (#1746).
  it('answers 412 ConditionNotMet, as Azurite does, and the store raises ObjectConflictError', async () => {
    const name = `aw-sdk16-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const container = service.getContainerClient(name);
    await container.create();
    try {
      const failure = await container
        .getBlockBlobClient('missing.bin')
        .uploadStream(Readable.from([Buffer.from('x')]), 8 * 1024 * 1024, 1, {
          conditions: { ifMatch: '"never-written"' },
        })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(failure).toMatchObject({ statusCode: 412, code: 'ConditionNotMet' });
      await expect(
        createAzureBlobObjectStoreProvider(createAzureSdkBlobContainer(container))
          .forWorkspace('00000000-0000-4000-8000-000000000001')
          .write('missing.bin', new Uint8Array([1]), { ifMatch: '"never-written"' }),
      ).rejects.toThrow(ObjectConflictError);
    } finally {
      await container.deleteIfExists();
    }
  }, 60_000);
});
