import { S3Client } from '@aws-sdk/client-s3';
import { BlobServiceClient, type UserDelegationKey } from '@azure/storage-blob';
import { Storage } from '@google-cloud/storage';
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createAzureBlobObjectStoreProvider,
  createAzureSdkBlobContainer,
} from './azure-blob-store.js';
import {
  createGcsObjectStoreProvider,
  createNativeGcsClient,
  type GcsClient,
} from './gcs-store.js';
import { createLocalFilesystemObjectStoreProvider } from './local-fs-store.js';
import { createInMemoryObjectStoreProvider } from './memory-store.js';
import { SignedUrlUnsupportedError, type SignedUrlRequest } from './object-store.js';
import { presignS3Url } from './s3-presign.js';
import { createS3ObjectStoreProvider } from './s3-store.js';

const NOW = new Date('2026-10-18T12:00:00.000Z');

describe('presignS3Url', () => {
  it('reproduces the worked example in the AWS query-string authentication documentation', () => {
    const url = presignS3Url({
      method: 'GET',
      scheme: 'https',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      expiresInSeconds: 86_400,
      now: new Date('2013-05-24T00:00:00.000Z'),
    });
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('changes the signature when a signed header changes', () => {
    const base = {
      method: 'PUT',
      scheme: 'https',
      host: 'bucket.s3.amazonaws.com',
      path: '/a b/c.txt',
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'token' },
      expiresInSeconds: 60,
      now: NOW,
    } as const;
    const first = presignS3Url({ ...base, signedHeaders: { 'content-type': 'text/plain' } });
    const second = presignS3Url({ ...base, signedHeaders: { 'content-type': 'text/html' } });
    expect(first).toContain('/a%20b/c.txt?');
    expect(first).toContain('X-Amz-Security-Token=token');
    expect(first).toContain('X-Amz-SignedHeaders=content-type%3Bhost');
    expect(first.split('X-Amz-Signature=')[1]).not.toBe(second.split('X-Amz-Signature=')[1]);
  });
});

const PUT: SignedUrlRequest = {
  method: 'PUT',
  expiresInSeconds: 300,
  contentType: 'text/plain',
  contentLength: 5,
  now: NOW,
};
const GET: SignedUrlRequest = {
  method: 'GET',
  expiresInSeconds: 300,
  responseContentType: 'application/octet-stream',
  responseDisposition: 'attachment',
  now: NOW,
};

/**
 * The download a browser is sent to: an attachment with a real filename, never rendered inline.
 * None of SigV4, GCS V4 or an Azure SAS can ask for `x-content-type-options` on a signed response
 * (the only overrides are type, disposition, cache, encoding and language), so `nosniff` cannot be
 * requested from the storage domain and the forced attachment is what is relied on (the storage
 * design, §05).
 */
const ATTACHMENT = `attachment; filename="q3.pdf"; filename*=UTF-8''q3.pdf`;
const DOWNLOAD: SignedUrlRequest = { ...GET, responseDisposition: ATTACHMENT };

describe('S3 createSignedUrl', () => {
  const client = new S3Client({
    endpoint: 'http://127.0.0.1:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
  });
  const store = createS3ObjectStoreProvider({ client, bucket: 'files' }).forWorkspace('ws-1');

  it('signs a PUT under the workspace prefix and returns the headers the signature covers', async () => {
    const signed = await store.createSignedUrl?.('.attachments/s1/u1/a.txt', PUT);
    const url = new URL(signed?.url ?? '');
    expect(url.origin).toBe('http://127.0.0.1:9000');
    expect(url.pathname).toBe('/files/workspaces/ws-1/.attachments/s1/u1/a.txt');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;x-amz-meta-aw-content-type-known',
    );
    expect(signed?.headers).toEqual({
      'content-type': 'text/plain',
      'x-amz-meta-aw-content-type-known': 'true',
    });
  });

  it('signs the response overrides of a GET', async () => {
    const signed = await store.createSignedUrl?.('a.txt', GET);
    const url = new URL(signed?.url ?? '');
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment');
    expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(signed?.headers).toEqual({});
  });

  // @story US-STO-05
  it('[US-STO-05][unit][sdk] a signed S3 GET forces an attachment disposition', async () => {
    const signed = await store.createSignedUrl?.('q3.pdf', DOWNLOAD);
    const { searchParams } = new URL(signed?.url ?? '');
    expect(searchParams.get('response-content-disposition')).toBe(ATTACHMENT);
    expect(searchParams.get('response-content-type')).toBe('application/octet-stream');
  });

  it('refuses a key that escapes the workspace before signing', async () => {
    await expect(store.createSignedUrl?.('../ws-2/a.txt', PUT)).rejects.toThrow();
  });

  describe('with a public endpoint', () => {
    const publicStore = createS3ObjectStoreProvider({
      client,
      bucket: 'files',
      publicEndpoint: 'http://localhost:8333',
    }).forWorkspace('ws-1');

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a presigned upload with publicEndpoint names that host and verifies against it', async () => {
      const key = '.attachments/s1/u1/a.txt';
      const signed = await publicStore.createSignedUrl?.(key, PUT);
      const url = new URL(signed?.url ?? '');
      expect(url.origin).toBe('http://localhost:8333');
      expect(url.pathname).toBe(`/files/workspaces/ws-1/${key}`);
      expect(signed?.url).toBe(
        presignS3Url({
          method: 'PUT',
          scheme: 'http',
          host: 'localhost:8333',
          path: `/files/workspaces/ws-1/${key}`,
          region: 'us-east-1',
          credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
          expiresInSeconds: 300,
          signedHeaders: {
            'content-length': '5',
            'content-type': 'text/plain',
            'x-amz-meta-aw-content-type-known': 'true',
          },
          now: NOW,
        }),
      );
      const own = new URL((await store.createSignedUrl?.(key, PUT))?.url ?? '');
      expect(url.searchParams.get('X-Amz-Signature')).not.toBe(
        own.searchParams.get('X-Amz-Signature'),
      );
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a signed download names the public host too', async () => {
      const url = new URL((await publicStore.createSignedUrl?.('a.txt', GET))?.url ?? '');
      expect(url.origin).toBe('http://localhost:8333');
      expect(url.pathname).toBe('/files/workspaces/ws-1/a.txt');
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a public endpoint with a base path keeps it, and an https default port is omitted', async () => {
      const proxied = createS3ObjectStoreProvider({
        client,
        bucket: 'files',
        publicEndpoint: 'https://files.example.com:443/s3/',
      }).forWorkspace('ws-1');
      const url = new URL((await proxied.createSignedUrl?.('a.txt', GET))?.url ?? '');
      expect(url.origin).toBe('https://files.example.com');
      expect(url.pathname).toBe('/s3/files/workspaces/ws-1/a.txt');
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] refuses a public endpoint that is not http or https', () => {
      expect(() =>
        createS3ObjectStoreProvider({ client, bucket: 'files', publicEndpoint: 'ftp://host' }),
      ).toThrow(/publicEndpoint/u);
    });

    // @story US-STO-02
    it.each(['https://u:p@host', 'https://host/?x=1', 'https://host/#f'])(
      '[US-STO-02][unit][sdk] refuses a public endpoint with credentials, query, or fragment: %s',
      (publicEndpoint) => {
        expect(() =>
          createS3ObjectStoreProvider({ client, bucket: 'files', publicEndpoint }),
        ).toThrow(
          'publicEndpoint must be an http or https URL without credentials, query, or fragment.',
        );
      },
    );
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] binds the content length into the signature when it must be bound', async () => {
    const bound = { method: 'PUT', contentLength: 5, requireBoundContentLength: true } as const;
    const signed = await store.createSignedUrl?.('up.bin', { ...bound, now: NOW });
    const url = new URL(signed?.url ?? '');
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('content-length');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    await expect(
      store.createSignedUrl?.('up.bin', { method: 'PUT', requireBoundContentLength: true }),
    ).rejects.toThrow(SignedUrlUnsupportedError);
  });
});

describe('GCS createSignedUrl', () => {
  it('forwards the prefixed key and the request to the client', async () => {
    const calls: { name: string; request: SignedUrlRequest }[] = [];
    const client: GcsClient = {
      write: () => Promise.resolve(),
      read: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      copy: () => Promise.resolve(),
      head: () => Promise.resolve(null),
      readStream: () => Promise.resolve(null),
      writeStream: () => Promise.reject(new Error('unused')),
      listPage: () => Promise.resolve({ objects: [], folders: [], cursor: null }),
      signUrl(name, request) {
        calls.push({ name, request });
        return Promise.resolve({ url: 'https://storage.googleapis.com/x', headers: {} });
      },
    };
    const store = createGcsObjectStoreProvider({ client }).forWorkspace('ws-1');
    await store.createSignedUrl?.('a.txt', PUT);
    expect(calls).toEqual([{ name: 'workspaces/ws-1/a.txt', request: PUT }]);
    await expect(store.createSignedUrl?.('../a.txt', PUT)).rejects.toThrow();
  });

  const offlineClient = () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const storage = new Storage({
      projectId: 'p',
      credentials: { client_email: 'signer@p.iam.gserviceaccount.com', private_key: privateKey },
    });
    return createNativeGcsClient(storage.bucket('files'));
  };

  // @story US-STO-05
  it('[US-STO-05][unit][sdk] a signed GCS GET forces an attachment disposition', async () => {
    const signed = await offlineClient().signUrl?.('workspaces/ws-1/q3.pdf', {
      ...DOWNLOAD,
      now: new Date(),
    });
    const { searchParams } = new URL(signed?.url ?? '');
    expect(searchParams.get('response-content-disposition')).toBe(ATTACHMENT);
    expect(searchParams.get('response-content-type')).toBe('application/octet-stream');
  });

  it('signs a V4 URL offline with the native client', async () => {
    const client = offlineClient();
    const signed = await client.signUrl?.('workspaces/ws-1/a.txt', {
      ...PUT,
      now: new Date(),
    });
    const url = new URL(signed?.url ?? '');
    expect(url.pathname).toBe('/files/workspaces/ws-1/a.txt');
    expect(url.searchParams.get('X-Goog-Expires')).toBe('300');
    expect(url.searchParams.get('X-Goog-SignedHeaders')).toContain('x-goog-content-length-range');
    expect(signed?.headers).toEqual({
      'content-type': 'text/plain',
      'x-goog-meta-aw-content-type-known': 'true',
      'x-goog-content-length-range': '5,5',
    });
    const read = await client.signUrl?.('workspaces/ws-1/a.txt', { ...GET, now: new Date() });
    expect(new URL(read?.url ?? '').searchParams.get('response-content-disposition')).toBe(
      'attachment',
    );
  });
});

const UNUSED_V2_MEMBERS = {
  head: () => Promise.resolve(null),
  readStream: () => Promise.resolve(null),
  writeStream: () => Promise.resolve(null),
  listPage: () => Promise.resolve({ entries: [], cursor: null }),
  copy: () => Promise.resolve(),
};

describe('Azure Blob createSignedUrl', () => {
  it('forwards the prefixed key and the request to the container', async () => {
    const names: string[] = [];
    const store = createAzureBlobObjectStoreProvider({
      assertReady: () => Promise.resolve(),
      put: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      listHierarchy: () => Promise.resolve([]),
      listFlat: () => Promise.resolve([]),
      ...UNUSED_V2_MEMBERS,
      signUrl(name) {
        names.push(name);
        return Promise.resolve({
          url: 'https://acct.blob.core.windows.net/c/x?sig=1',
          headers: {},
        });
      },
    }).forWorkspace('ws-1');
    await store.createSignedUrl?.('a.txt', GET);
    expect(names).toEqual(['workspaces/ws-1/a.txt']);
    await expect(store.createSignedUrl?.('../a.txt', GET)).rejects.toThrow();
  });

  it('refuses to sign a PUT that must bind its length, before minting anything', async () => {
    const names: string[] = [];
    const store = createAzureBlobObjectStoreProvider({
      assertReady: () => Promise.resolve(),
      put: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      listHierarchy: () => Promise.resolve([]),
      listFlat: () => Promise.resolve([]),
      ...UNUSED_V2_MEMBERS,
      signUrl(name) {
        names.push(name);
        return Promise.resolve({
          url: 'https://acct.blob.core.windows.net/c/x?sig=1',
          headers: {},
        });
      },
    }).forWorkspace('ws-1');
    await expect(
      store.createSignedUrl?.('a.txt', { ...PUT, requireBoundContentLength: true }),
    ).rejects.toBeInstanceOf(SignedUrlUnsupportedError);
    expect(names).toEqual([]);
    await store.createSignedUrl?.('a.txt', PUT);
    expect(names).toEqual(['workspaces/ws-1/a.txt']);
  });

  const offlineContainer = () => {
    const delegationKey: UserDelegationKey = {
      signedObjectId: '00000000-0000-0000-0000-000000000001',
      signedTenantId: '00000000-0000-0000-0000-000000000002',
      signedStartsOn: new Date(NOW.getTime() - 300_000),
      signedExpiresOn: new Date(NOW.getTime() + 300_000),
      signedService: 'b',
      signedVersion: '2023-11-03',
      value: Buffer.from('k'.repeat(32)).toString('base64'),
    };
    class OfflineService extends BlobServiceClient {
      public override getUserDelegationKey(): Promise<
        Awaited<ReturnType<BlobServiceClient['getUserDelegationKey']>>
      > {
        return Promise.resolve({ ...delegationKey, _response: undefined as never });
      }
    }
    const service = new OfflineService('https://acct.blob.core.windows.net');
    return createAzureSdkBlobContainer(service.getContainerClient('files'), service);
  };

  // Azurite offers no signing (#1740), so the SAS parameters are read from an offline signature.
  // @story US-STO-05
  it('[US-STO-05][unit][sdk] a signed Azure GET forces an attachment disposition', async () => {
    const read = await offlineContainer().signUrl?.('workspaces/ws-1/q3.pdf', DOWNLOAD);
    const { searchParams } = new URL(read?.url ?? '');
    expect(searchParams.get('rscd')).toBe(ATTACHMENT);
    expect(searchParams.get('rsct')).toBe('application/octet-stream');
  });

  it('mints a user-delegation SAS with the SDK container', async () => {
    const container = offlineContainer();
    const put = await container.signUrl?.('workspaces/ws-1/a.txt', PUT);
    const url = new URL(put?.url ?? '');
    expect(url.origin).toBe('https://acct.blob.core.windows.net');
    expect(url.pathname).toBe('/files/workspaces/ws-1/a.txt');
    expect(url.searchParams.get('sp')).toBe('cw');
    expect(url.searchParams.get('spr')).toBe('https');
    expect(url.searchParams.get('se')).toBe('2026-10-18T12:05:00Z');
    expect(put?.headers).toEqual({
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-blob-content-type': 'text/plain',
      'x-ms-meta-aw_content_type_known': 'true',
    });
    const read = await container.signUrl?.('workspaces/ws-1/a.txt', GET);
    const readUrl = new URL(read?.url ?? '');
    expect(readUrl.searchParams.get('sp')).toBe('r');
    expect(readUrl.searchParams.get('rscd')).toBe('attachment');
  });
});

describe('backends that cannot sign', () => {
  it('leaves createSignedUrl absent on the in-memory and local-filesystem stores', () => {
    const inMemory = createInMemoryObjectStoreProvider().forWorkspace('ws-1');
    const local = createLocalFilesystemObjectStoreProvider('/tmp/unused').forWorkspace('ws-1');
    expect('createSignedUrl' in inMemory).toBe(false);
    expect('createSignedUrl' in local).toBe(false);
  });
});
