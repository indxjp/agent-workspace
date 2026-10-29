import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { BlobServiceClient, BlockBlobClient, ContainerClient } from '@azure/storage-blob';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defineObjectStoreContract } from './contract.js';
import {
  createAzureBlobObjectStore,
  createAzureBlobObjectStoreProvider,
  createAzureBlobObjectStoreProviderFromConfig,
  createAzureSdkBlobContainer,
  type AzureBlobContainer,
  type AzureBlobEntry,
} from './azure-blob-store.js';
import {
  ObjectConflictError,
  RangeNotSatisfiableError,
  type ObjectContent,
  type ObjectMeta,
  type ObjectStore,
} from './object-store.js';
import { bytesToStream, readWhole, streamToBytes } from './streams.js';

type FakeBlob = ObjectContent & { readonly etag: string };

function fakeAzureBlobContainer(): AzureBlobContainer {
  const values = new Map<string, FakeBlob>();
  let version = 0;
  const store = (name: string, body: Uint8Array, contentType: string | null): FakeBlob => {
    version += 1;
    const blob = {
      body: Buffer.from(body),
      contentType,
      sizeBytes: body.byteLength,
      lastModified: new Date('2026-09-23T00:00:00.000Z'),
      etag: `"${String(version)}"`,
    };
    values.set(name, blob);
    return blob;
  };
  const metaOf = (blob: FakeBlob): ObjectMeta => ({
    sizeBytes: blob.sizeBytes,
    contentType: blob.contentType,
    etag: blob.etag,
    lastModified: blob.lastModified,
  });
  return {
    assertReady: () => Promise.resolve(),
    head(name) {
      const blob = values.get(name);
      return Promise.resolve(blob === undefined ? null : metaOf(blob));
    },
    readStream(name, range) {
      const blob = values.get(name);
      if (blob === undefined) return Promise.resolve(null);
      const served =
        range === undefined ? null : { start: range.start, end: range.end ?? blob.sizeBytes - 1 };
      const bytes = served === null ? blob.body : blob.body.subarray(served.start, served.end + 1);
      return Promise.resolve({
        meta: metaOf(blob),
        range: served,
        body: bytesToStream(Uint8Array.from(bytes)),
      });
    },
    async writeStream(name, body, options) {
      const bytes = body instanceof Uint8Array ? body : await streamToBytes(body);
      const current = values.get(name);
      if (options.ifNoneMatch === '*' && current !== undefined) return null;
      if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) return null;
      return metaOf(store(name, bytes, options.contentType ?? null));
    },
    listPage(prefix, { delimiter, cursor, limit }) {
      // Rows keyed by Azure's listing name (a folder as `name/`), so paging follows Azure's order
      // and a file and a folder of one name both survive.
      const rows = new Map<string, AzureBlobEntry>();
      for (const [name, value] of values) {
        if (!name.startsWith(prefix) || name === prefix) continue;
        const separator = delimiter ? name.indexOf('/', prefix.length) : -1;
        if (separator >= 0) {
          const folder = name.slice(0, separator);
          rows.set(`${folder}/`, { kind: 'folder', name: folder });
        } else {
          rows.set(name, {
            kind: 'file',
            name,
            sizeBytes: value.sizeBytes,
            contentType: value.contentType,
            lastModified: value.lastModified,
          });
        }
      }
      const after = cursor === undefined ? '' : Buffer.from(cursor, 'base64url').toString();
      const rest = [...rows.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .filter(([id]) => cursor === undefined || id > after);
      const page = rest.slice(0, limit);
      const last = page[page.length - 1];
      return Promise.resolve({
        entries: page.map(([, entry]) => entry),
        cursor:
          rest.length > limit && last !== undefined
            ? Buffer.from(last[0]).toString('base64url')
            : null,
      });
    },
    copy(sourceName: string, destinationName: string): Promise<void> {
      const source = values.get(sourceName);
      if (source !== undefined) store(destinationName, source.body, source.contentType);
      return Promise.resolve();
    },
    delete(name: string): Promise<void> {
      values.delete(name);
      return Promise.resolve();
    },
  };
}

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

describe('Azure SDK streamed write', () => {
  const sdkStore = () =>
    createAzureBlobObjectStoreProvider(
      createAzureSdkBlobContainer(new ContainerClient('https://unit.blob.core.windows.net/c')),
    ).forWorkspace('workspace-a');
  const azureError = (statusCode: number, code: string) =>
    Object.assign(new Error('provider failure'), { statusCode, code });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uploads with an 8 MiB buffer and concurrency 1, and maps a 412 to ObjectConflictError', async () => {
    const upload = vi
      .spyOn(BlockBlobClient.prototype, 'uploadStream')
      .mockRejectedValue(azureError(412, 'ConditionNotMet'));
    await expect(
      sdkStore().write('k.bin', new Uint8Array([1]), { ifNoneMatch: '*' }),
    ).rejects.toThrow(ObjectConflictError);
    expect(upload).toHaveBeenCalledWith(
      expect.any(Readable),
      8 * 1024 * 1024,
      1,
      expect.objectContaining({ conditions: { ifNoneMatch: '*' } }),
    );
  });

  it('sends ifMatch as a condition and treats a missing blob under ifMatch as a conflict', async () => {
    const upload = vi
      .spyOn(BlockBlobClient.prototype, 'uploadStream')
      .mockRejectedValue(azureError(404, 'BlobNotFound'));
    await expect(
      sdkStore().write('k.bin', new Uint8Array([1]), { ifMatch: '"v1"' }),
    ).rejects.toThrow(ObjectConflictError);
    expect(upload).toHaveBeenCalledWith(
      expect.any(Readable),
      8 * 1024 * 1024,
      1,
      expect.objectContaining({ conditions: { ifMatch: '"v1"' } }),
    );
  });

  it.each([
    ['a lease conflict', azureError(409, 'LeaseIdMissing')],
    ['a missing blob without ifMatch', azureError(404, 'BlobNotFound')],
  ])('does not report %s as a precondition failure', async (_name, error) => {
    vi.spyOn(BlockBlobClient.prototype, 'uploadStream').mockRejectedValue(error);
    const failure = await sdkStore()
      .write('k.bin', new Uint8Array([1]), {})
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ObjectConflictError);
  });

  it('returns the etag of its own upload, not one a later properties call sees', async () => {
    const lastModified = new Date('2026-10-22T00:00:00.000Z');
    vi.spyOn(BlockBlobClient.prototype, 'uploadStream').mockImplementation(async (source) => {
      await finished(source.resume()); // drained, as the SDK would
      return { etag: '"0xMINE"', lastModified, _response: undefined as never };
    });
    // Another writer replaced the blob between the upload and any follow-up properties call.
    vi.spyOn(BlockBlobClient.prototype, 'getProperties').mockResolvedValue({
      etag: '"0xOTHER"',
      contentLength: 99,
      lastModified,
      _response: undefined as never,
    });
    const meta = await sdkStore().write('k.bin', bytesToStream(new Uint8Array(7)), {
      contentType: 'text/plain',
    });
    expect(meta).toEqual({
      etag: '"0xMINE"',
      sizeBytes: 7,
      contentType: 'text/plain',
      lastModified,
    });
  });

  const headOf = (contentLength: number) =>
    vi.spyOn(BlockBlobClient.prototype, 'getProperties').mockResolvedValue({
      contentLength,
      etag: '"v1"',
      _response: undefined as never,
    });

  it('maps a 416 from a blob that shrank after the size check to RangeNotSatisfiableError', async () => {
    headOf(10);
    vi.spyOn(BlockBlobClient.prototype, 'download').mockRejectedValue(
      azureError(416, 'InvalidRange'),
    );
    await expect(sdkStore().read('k.bin', { range: { start: 2, end: 5 } })).rejects.toBeInstanceOf(
      RangeNotSatisfiableError,
    );
  });

  it('answers the range the GET served, not the one the earlier HEAD implied', async () => {
    headOf(10);
    vi.spyOn(BlockBlobClient.prototype, 'download').mockResolvedValue({
      contentRange: 'bytes 2-3/4',
      contentLength: 2,
      readableStreamBody: Readable.from([Buffer.from([2, 3])]),
      _response: undefined as never,
    });
    const found = await sdkStore().read('k.bin', { range: { start: 2, end: 5 } });
    expect(found?.range).toEqual({ start: 2, end: 3 });
    expect(found?.meta.sizeBytes).toBe(4);
    await found?.body.cancel();
  });

  it('copies on the service instead of downloading and re-uploading the blob', async () => {
    const copy = vi.spyOn(BlockBlobClient.prototype, 'beginCopyFromURL').mockResolvedValue({
      pollUntilDone: () => Promise.resolve({ copyStatus: 'success' }),
    } as never);
    const download = vi.spyOn(BlockBlobClient.prototype, 'download');
    await sdkStore().copy('from.bin', 'to.bin');
    expect(copy).toHaveBeenCalledWith(
      'https://unit.blob.core.windows.net/c/workspaces/workspace-a/from.bin',
    );
    expect(download).not.toHaveBeenCalled();
  });

  it('treats a missing copy source as a no-op', async () => {
    vi.spyOn(BlockBlobClient.prototype, 'beginCopyFromURL').mockRejectedValue(
      azureError(404, 'CannotVerifyCopySource'),
    );
    await expect(sdkStore().copy('gone.bin', 'to.bin')).resolves.toBeUndefined();
  });

  it("surfaces the caller's own body failure instead of a provider error", async () => {
    vi.spyOn(BlockBlobClient.prototype, 'uploadStream').mockImplementation(
      (source: Readable) =>
        new Promise((_resolve, reject) => {
          source.once('error', () => {
            reject(azureError(500, 'InternalError'));
          });
          source.destroy(new Error('source broke'));
        }),
    );
    await expect(
      sdkStore().write('k.bin', new ReadableStream<Uint8Array>({ pull: () => undefined }), {}),
    ).rejects.toThrow('source broke');
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

/** Every `kind:key` under `o`, read `limit` entries per page. */
async function drain(store: ObjectStore, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listPage('o', {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    seen.push(...page.entries.map((entry) => `${entry.kind}:${entry.key}`));
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return seen;
}

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
