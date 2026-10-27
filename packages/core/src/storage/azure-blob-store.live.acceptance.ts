import { randomUUID } from 'node:crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { describe, expect, it } from 'vitest';

import {
  defineObjectStoreContract,
  defineObjectStoreV2Contract,
  type ObjectStoreV2ContractFixture,
} from './contract.js';
import {
  createAzureBlobObjectStoreProvider,
  createAzureSdkBlobContainer,
} from './azure-blob-store.js';

function requiredServiceUrl(): string {
  const value = process.env['AZURE_BLOB_LIVE_SERVICE_URL']?.trim();
  if (value === undefined || value === '') {
    throw new Error('AZURE_BLOB_LIVE_SERVICE_URL is required for the live proof.');
  }
  return value;
}

const serviceUrl = requiredServiceUrl();
const service = new BlobServiceClient(serviceUrl, new DefaultAzureCredential());

async function setup(): Promise<ObjectStoreV2ContractFixture> {
  const name = `aw-sdk16-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const container = service.getContainerClient(name);
  await container.create();
  const client = createAzureSdkBlobContainer(container);
  await client.assertReady();
  return {
    provider: createAzureBlobObjectStoreProvider(client),
    teardown: () => container.deleteIfExists().then(() => undefined),
  };
}

defineObjectStoreContract('Azure Blob (live)', setup);
defineObjectStoreV2Contract('Azure Blob (live)', setup);

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
        await store.put('proof/value.txt', {
          body: Buffer.from(`azure-${prefix}`),
          contentType: 'text/plain',
        });
        const value = await store.get('proof/value.txt');
        expect(value?.body.toString()).toBe(`azure-${prefix}`);
        expect(value?.contentType).toBe('text/plain');
      }
    } finally {
      await container.deleteIfExists();
    }
  }, 60_000);
});
