import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { BlockBlobClient, ContainerClient } from '@azure/storage-blob';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAzureBlobObjectStoreProvider,
  createAzureSdkBlobContainer,
} from './azure-blob-store.js';
import { ObjectConflictError, RangeNotSatisfiableError } from './object-store.js';
import { bytesToStream } from './streams.js';

const sdkStore = () =>
  createAzureBlobObjectStoreProvider(
    createAzureSdkBlobContainer(new ContainerClient('https://unit.blob.core.windows.net/c')),
  ).forWorkspace('workspace-a');
const azureError = (statusCode: number, code: string) =>
  Object.assign(new Error('provider failure'), { statusCode, code });

const headOf = (contentLength: number) =>
  vi.spyOn(BlockBlobClient.prototype, 'getProperties').mockResolvedValue({
    contentLength,
    etag: '"v1"',
    _response: undefined as never,
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Azure SDK streamed write', () => {
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
});

describe('Azure SDK write results', () => {
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

describe('Azure SDK reads, heads and copies', () => {
  it('does not read a missing container as a missing object', async () => {
    vi.spyOn(BlockBlobClient.prototype, 'getProperties').mockRejectedValue(
      azureError(404, 'ContainerNotFound'),
    );
    await expect(sdkStore().head('k.bin')).rejects.toThrow();
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
});

describe('Azure SDK ranges and copies', () => {
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
});
