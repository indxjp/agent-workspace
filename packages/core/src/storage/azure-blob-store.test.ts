import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { BlobServiceClient } from '@azure/storage-blob';
import { describe, expect, it } from 'vitest';

import { defineObjectStoreContract } from './contract.js';
import {
  createAzureBlobObjectStore,
  createAzureBlobObjectStoreProvider,
  createAzureBlobObjectStoreProviderFromConfig,
  createAzureSdkBlobContainer,
} from './azure-blob-store.js';
import type { AzureBlobContainer } from './azure-blob-protocol.js';
import { drain, fakeAzureBlobContainer } from './azure-blob-fake.test-support.js';
import { ObjectConflictError } from './object-store.js';
import { readWhole, streamToBytes } from './streams.js';

const setupFake = () => {
  const container = fakeAzureBlobContainer();
  return Promise.resolve({
    provider: createAzureBlobObjectStoreProvider(container),
    teardown: () => Promise.resolve(),
    plantRaw: async (key: string, bytes: Uint8Array) => {
      await container.writeStream(key, bytes, {});
    },
  });
};

defineObjectStoreContract('Azure Blob (fake)', setupFake);

describe('Azure Blob v2 capabilities', () => {
  it('cannot bind an upload length into a signed link, so the complete step checks the size', () => {
    const store = createAzureBlobObjectStoreProvider(fakeAzureBlobContainer()).forWorkspace('w');
    expect(store.capabilities).toEqual({
      sign: false,
      boundLengthSign: false,
      range: true,
      conditionalPut: true,
      fileAndFolderShareKey: true,
    });
  });
});

describe('Azure Blob prefix placement', () => {
  it.each(['files', 'skills'])('round-trips through the %s prefix', async (prefix) => {
    const store = createAzureBlobObjectStoreProvider(fakeAzureBlobContainer(), prefix).forWorkspace(
      'workspace-a',
    );
    await store.write('resource.bin', Buffer.from('native-azure'), {});
    expect((await readWhole(store, 'resource.bin'))?.body.toString()).toBe('native-azure');
  });

  it('refuses a SAS-bearing service URL before contacting Azure', async () => {
    await expect(
      createAzureBlobObjectStoreProviderFromConfig({
        serviceUrl: 'https://account.blob.core.windows.net/?sv=2026-01-01&sig=secret',
        container: 'workspace-objects',
      }),
    ).rejects.toThrow(/without credentials, a SAS query, a path or a fragment/u);
  });
});

describe('Azure listing order', () => {
  it('puts file a.txt before folder a, the order Azure itself lists in', async () => {
    const container: AzureBlobContainer = {
      ...fakeAzureBlobContainer(),
      listPage: () =>
        Promise.resolve({
          entries: [
            { kind: 'folder', name: 'o/a' },
            {
              kind: 'file',
              name: 'o/a.txt',
              sizeBytes: 1,
              contentType: null,
              lastModified: new Date(0),
            },
          ],
          cursor: null,
        }),
    };
    const page = await createAzureBlobObjectStore(container).listPage('o', {});
    expect(page.entries.map((entry) => `${entry.kind}:${entry.key}`)).toEqual([
      'file:o/a.txt',
      'folder:o/a',
    ]);
  });

  it('lists pages that concatenate into the single-page order', async () => {
    const store = createAzureBlobObjectStoreProvider(fakeAzureBlobContainer()).forWorkspace('w');
    for (const key of ['o/a.txt', 'o/a/b.txt', 'o/b.txt']) {
      await store.write(key, new Uint8Array([1]), {});
    }
    const whole = await drain(store, 1000);
    expect(whole).toEqual(['file:o/a.txt', 'folder:o/a', 'file:o/b.txt']);
    expect(await drain(store, 1)).toEqual(whole);
  });
});

// The real SDK adapter against Azurite over HTTP. Azurite's answers pin the emulator, not Azure:
// the live acceptance fixture stays the proof for Azure itself.
const azuriteUrl = process.env['TEST_AZURITE_URL']?.trim() ?? '';
if (azuriteUrl !== '') {
  // Azurite's well-known development account, read from the SDK so no key literal lives here.
  const service = new BlobServiceClient(
    azuriteUrl,
    BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true').credential,
  );

  const setupAzurite = async () => {
    const container = service.getContainerClient(`aw-${randomUUID()}`);
    await container.create();
    return {
      container,
      // No service client, so no signing: a user delegation key needs an Entra token, and Azurite
      // here authenticates with its shared development key (it answers 403). Offline SAS coverage
      // is in signed-url.test.ts (the real SDK with a stubbed delegation key). The live acceptance
      // fixture passes its service client, so it signs against Azure itself.
      provider: createAzureBlobObjectStoreProvider(createAzureSdkBlobContainer(container)),
      teardown: async () => {
        await container.delete();
      },
      plantRaw: async (key: string, bytes: Uint8Array) => {
        await container.getBlockBlobClient(key).uploadData(bytes);
      },
    };
  };

  defineObjectStoreContract('Azure Blob (Azurite)', setupAzurite);

  const withAzurite = async (
    run: (fixture: Awaited<ReturnType<typeof setupAzurite>>) => Promise<void>,
  ) => {
    const fixture = await setupAzurite();
    try {
      await run(fixture);
    } finally {
      await fixture.teardown();
    }
  };

  describe('Azure Blob SDK adapter (Azurite)', () => {
    it('answers ifMatch on a missing blob with 412 ConditionNotMet, and the store raises ObjectConflictError', async () => {
      await withAzurite(async ({ container, provider }) => {
        const failure = await container
          .getBlockBlobClient('missing.bin')
          .uploadStream(Readable.from([Buffer.from('x')]), 8 * 1024 * 1024, 1, {
            conditions: { ifMatch: '"never-written"' },
          })
          .then(
            () => undefined,
            (caught: unknown) => caught,
          );
        // Observed on Azurite 3.37.0 (the pinned image): 412 ConditionNotMet, not 404 BlobNotFound.
        expect(failure).toMatchObject({ statusCode: 412, code: 'ConditionNotMet' });
        await expect(
          provider
            .forWorkspace('w')
            .write('missing.bin', new Uint8Array([1]), { ifMatch: '"never-written"' }),
        ).rejects.toThrow(ObjectConflictError);
      });
    });

    it('lists pages that concatenate into the single-page order', async () => {
      await withAzurite(async ({ provider }) => {
        const store = provider.forWorkspace('w');
        for (const key of ['o/a.txt', 'o/a/b.txt', 'o/b.txt']) {
          await store.write(key, new Uint8Array([1]), {});
        }
        const whole = await drain(store, 1000);
        expect(whole).toEqual(['file:o/a.txt', 'folder:o/a', 'file:o/b.txt']);
        expect(await drain(store, 1)).toEqual(whole);
      });
    });

    it('reports the whole size on a ranged read (the Content-Range total)', async () => {
      await withAzurite(async ({ provider }) => {
        const store = provider.forWorkspace('w');
        await store.write('ten.bin', Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), {});
        const found = await store.read('ten.bin', { range: { start: 2, end: 5 } });
        if (found === null) throw new Error('the blob just written is missing');
        expect(found.meta.sizeBytes).toBe(10);
        expect(found.range).toEqual({ start: 2, end: 5 });
        expect(Array.from(await streamToBytes(found.body))).toEqual([2, 3, 4, 5]);
      });
    });
  });
}
