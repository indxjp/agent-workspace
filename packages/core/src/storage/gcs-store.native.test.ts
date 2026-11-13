// The SDK-backed native GCS client: listing, error sanitising and the streamed write.
import { randomUUID } from 'node:crypto';
import type { RequestListener } from 'node:http';
import { Readable } from 'node:stream';

import type { Bucket } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGcsObjectStoreFromConfig, createNativeGcsClient } from './gcs-store.js';
import {
  errorChain,
  md5Of,
  uploadingBucket,
  withStubbedStorage,
} from './gcs-store.native.test-support.js';
import { ObjectConflictError } from './object-store.js';
import { streamToBytes } from './streams.js';

const uploadedAt = '2026-10-22T00:00:00.000Z';

describe('native GCS client listing', () => {
  it('skips a console folder placeholder instead of failing the page', async () => {
    const metadata = { size: '4', updated: '2026-10-22T00:00:00.000Z', generation: '1' };
    // Only the one call listPage makes; a console "create folder" leaves a zero-byte `name/`.
    const bucket = {
      getFiles: () =>
        Promise.resolve([
          [
            { name: 'ws/a.txt', metadata },
            { name: 'ws/folder/', metadata: { ...metadata, size: '0' } },
          ],
          null,
          { prefixes: [] },
        ]),
    } as unknown as Bucket;

    const page = await createNativeGcsClient(bucket).listPage('ws/', {
      delimiter: false,
      limit: 10,
    });

    expect(page.objects.map((object) => object.name)).toEqual(['ws/a.txt']);
  });
});

describe('native GCS client reads', () => {
  it('asks the SDK for the stored bytes, so a gzip-encoded object is not decompressed', async () => {
    const metadata = { size: '3', updated: '2026-10-22T00:00:00.000Z', generation: '7' };
    const readOptions: unknown[] = [];
    const bucket = {
      file: () => ({
        name: 'ws/a.gz',
        getMetadata: () => Promise.resolve([metadata]),
        createReadStream: (options: unknown) => {
          readOptions.push(options);
          return Readable.from([Buffer.from('abc')]);
        },
      }),
    } as unknown as Bucket;

    const read = await createNativeGcsClient(bucket).readStream('ws/a.gz', undefined, undefined);

    expect(read).not.toBeNull();
    expect(readOptions).toEqual([expect.objectContaining({ decompress: false })]);
  });
});

describe('native GCS client token errors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[US-STO-12][unit][sdk] an access token is sent as the bearer, with no ADC or project lookup, and never reaches the error', async () => {
    const token = `ya29.${randomUUID()}`;
    const authorizations: (string | undefined)[] = [];
    const applicationDefault = vi.spyOn(GoogleAuth.prototype, 'getApplicationDefault');
    const projectId = vi.spyOn(GoogleAuth.prototype, 'getProjectId');
    const reject: RequestListener = (request, response) => {
      authorizations.push(request.headers.authorization);
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 401, message: `rejected ${token}` } }));
    };
    await withStubbedStorage(reject, { bucket: 'acme-data', token }, async (storage) => {
      const error: unknown = await createNativeGcsClient(storage.bucket('acme-data'))
        .head('ws/a.txt')
        .catch((e: unknown) => e);

      expect(authorizations).toEqual([`Bearer ${token}`]);
      expect(applicationDefault).not.toHaveBeenCalled();
      expect(projectId).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(Error);
      expect(errorChain(error)).not.toContain(token);
      expect(String((error as Error).cause)).toContain('HTTP 401');
    });
  });
});

describe('native GCS client delayed refusals', () => {
  // #1991 A3: the media request starts lazily, after `readStream` resolved with the metadata.
  it('[US-STO-12][unit][sdk] a delayed download refusal never exposes its bearer token', async () => {
    const token = `ya29.${randomUUID()}`;
    const metadataThenDeny: RequestListener = (request, response) => {
      if (request.url?.includes('alt=media') === true) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 403, message: `denied Bearer ${token}` } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          name: 'ws/a.txt',
          bucket: 'acme-data',
          size: '4',
          generation: '7',
          updated: '2026-10-28T00:00:00.000Z',
        }),
      );
    };
    await withStubbedStorage(metadataThenDeny, { bucket: 'acme-data', token }, async (storage) => {
      const found = await createNativeGcsClient(storage.bucket('acme-data')).readStream(
        'ws/a.txt',
        undefined,
      );
      expect(found?.object.sizeBytes).toBe(4);
      const error: unknown = await streamToBytes(
        found?.body ?? new ReadableStream<Uint8Array>(),
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(errorChain(error)).not.toContain(token);
      expect(error).toMatchObject({ statusCode: 403 });
    });
  });
});

describe('native GCS client scrubbed errors', () => {
  it('[US-STO-12][unit][sdk] keep the HTTP status and drop the request that carries the bearer token', async () => {
    const token = `ya29.${randomUUID()}`;
    // Shaped like a GaxiosError: the request config, with its Authorization header, rides along.
    const failure = Object.assign(new Error(`request failed: Bearer ${token}`), {
      code: 403,
      config: { headers: { Authorization: `Bearer ${token}` } },
    });
    const bucket = {
      file: () => ({ getMetadata: () => Promise.reject(failure) }),
    } as unknown as Bucket;

    const error: unknown = await createNativeGcsClient(bucket)
      .head('ws/a.txt')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(errorChain(error)).not.toContain(token);
    expect(String((error as Error).cause)).toContain('HTTP 403');
  });
});

describe('native GCS client refusals', () => {
  // #1925 item 15: a bucket deleted after delivery must fail a write-back, not count as a conflict.
  it('[US-STO-12][unit][sdk] a missing bucket is an error on head and read, a missing object is null', async () => {
    // The JSON API's own 404 bodies for objects.get: the bucket's, then the object's.
    let body = { error: { code: 404, message: 'The specified bucket does not exist.' } };
    const notFound: RequestListener = (_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const target = { bucket: 'gone-bucket', token: `ya29.${randomUUID()}` };
    await withStubbedStorage(notFound, target, async (storage) => {
      const client = createNativeGcsClient(storage.bucket('gone-bucket'));

      await expect(client.head('ws/a.txt')).rejects.toThrow(/bucket/iu);
      await expect(client.readStream('ws/a.txt', undefined)).rejects.toThrow(/bucket/iu);

      body = { error: { code: 404, message: 'No such object: gone-bucket/ws/a.txt' } };
      await expect(client.head('ws/a.txt')).resolves.toBeNull();
      await expect(client.readStream('ws/a.txt', undefined)).resolves.toBeNull();
    });
  });

  it('[US-STO-12][unit][sdk] let the store own conflict errors through unchanged', async () => {
    const bucket = { file: () => ({}) } as unknown as Bucket;
    const error: unknown = await createNativeGcsClient(bucket)
      .writeStream('ws/a.txt', new Uint8Array(), { ifMatch: 'not-a-generation' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ObjectConflictError);
  });

  it('[US-STO-12][unit][sdk] refuse a config with both credentials and an access token', async () => {
    await expect(
      createGcsObjectStoreFromConfig({
        bucket: 'acme-data',
        projectId: 'acme-prod',
        accessToken: 'ya29.token',
        credentials: { client_email: 'a@b.c', private_key: 'key' },
      }),
    ).rejects.toThrow('either credentials or an access token, not both');
  });
});

describe('native GCS client streamed write', () => {
  const upload = (bucket: Bucket) =>
    createNativeGcsClient(bucket).writeStream('ws/a.txt', new TextEncoder().encode('mine'), {});

  it('returns the generation of its own upload, not one a later metadata call sees', async () => {
    const written = { size: '4', updated: uploadedAt, generation: '5', md5Hash: md5Of('mine') };
    // Another writer replaced the object between the upload and any follow-up metadata call.
    const replaced = { ...written, generation: '6' };
    const bucket = uploadingBucket(written, { getMetadata: () => Promise.resolve([replaced]) });

    expect((await upload(bucket)).etag).toBe('5');
  });

  // #1746: the SDK's own check deleted a mismatched upload with no precondition, so it could
  // delete a concurrent writer's newer generation.
  it('deletes an upload whose bytes do not match only at its own generation', async () => {
    const deletes: unknown[] = [];
    const uploading = (md5Hash: string) =>
      uploadingBucket(
        { size: '4', updated: uploadedAt, generation: '7', md5Hash },
        {
          delete: (options: unknown) => {
            deletes.push(options);
            return Promise.resolve([{}]);
          },
        },
      );

    await expect(upload(uploading(md5Of('else')))).rejects.toThrow(Error);
    expect(deletes).toEqual([{ ifGenerationMatch: 7 }]);

    deletes.length = 0;
    expect((await upload(uploading(md5Of('mine')))).etag).toBe('7');
    expect(deletes).toEqual([]);
  });
});

describe('native GCS client failed cleanup', () => {
  const upload = (bucket: Bucket) =>
    createNativeGcsClient(bucket).writeStream('ws/a.txt', new TextEncoder().encode('mine'), {});

  it('reports a failed cleanup of a mismatched upload by its status alone', async () => {
    const providerWords = `provider words ${randomUUID()}`;
    const failingDelete = (): Promise<never> =>
      Promise.reject(Object.assign(new Error(providerWords), { code: 503 }));
    const bucket = uploadingBucket(
      { size: '4', updated: uploadedAt, generation: '7', md5Hash: md5Of('else') },
      { delete: failingDelete },
    );

    const failure: unknown = await upload(bucket).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const { message, cause } = failure as Error;
    expect(message).toBe('Google Cloud Storage stored bytes that differ from the ones sent.');
    expect(cause).toMatchObject({
      message: 'Google Cloud Storage integrity cleanup failed.',
      statusCode: 503,
    });
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(
      providerWords,
    );
    expect(String((cause as Error).cause)).not.toContain(providerWords);
  });
});
