import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { defineObjectStoreContract, type ObjectStoreContractFixture } from './contract.js';
import { ObjectConflictError, type ObjectStore } from './object-store.js';
import {
  createS3ObjectStore,
  createS3ObjectStoreFromConfig,
  createS3ObjectStoreProvider,
  createS3ObjectStoreProviderFromConfig,
  ensureS3Bucket,
} from './s3-store.js';
import { readWhole } from './streams.js';

describe('ensureS3Bucket', () => {
  it('creates a missing bucket once, and a second boot finds it and creates nothing', async () => {
    const client = new S3Client({
      endpoint: 'http://seaweedfs.invalid:8333',
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
    });
    // Answer every call in memory, so no request leaves the process.
    const calls: string[] = [];
    let created = false;
    client.middlewareStack.add(
      (_next, context) => () => {
        const name = context.commandName ?? 'unknown';
        calls.push(name);
        if (name === 'CreateBucketCommand') created = true;
        else if (!created) {
          return Promise.reject(
            Object.assign(new Error('NotFound'), { $metadata: { httpStatusCode: 404 } }),
          );
        }
        return Promise.resolve({ output: { $metadata: {} }, response: {} });
      },
      { step: 'initialize' },
    );

    await ensureS3Bucket(client, 'agent-workspace');
    await ensureS3Bucket(client, 'agent-workspace');

    expect(calls).toEqual([
      'HeadBucketCommand',
      'CreateBucketCommand',
      'HeadBucketCommand',
      'HeadBucketCommand',
    ]);
  });
});

// #1925 item 15: a bucket deleted after delivery must fail a write-back, not count as a conflict.
describe('an S3 bucket that is gone', () => {
  it('is an error on a whole or ranged read and on copy, while a missing object is still null or a no-op', async () => {
    // S3's own error bodies: a GET names NoSuchBucket or NoSuchKey; a HEAD has no body at all.
    let code = 'NoSuchBucket';
    const server = createServer((request, response) => {
      response.writeHead(404, { 'content-type': 'application/xml' });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      response.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const store = createS3ObjectStore({
        client: new S3Client({
          endpoint: `http://127.0.0.1:${String(port)}`,
          region: 'us-east-1',
          forcePathStyle: true,
          maxAttempts: 1,
          credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
        }),
        bucket: 'gone-bucket',
      });

      await expect(store.read('a.txt')).rejects.toMatchObject({ name: 'NoSuchBucket' });
      // A ranged read sizes the object with a HEAD first, which cannot name the bucket.
      await expect(store.read('a.txt', { range: { start: 0, end: 1 } })).rejects.toMatchObject({
        name: 'NoSuchBucket',
      });
      await expect(store.copy('a.txt', 'b.txt')).rejects.toMatchObject({ name: 'NoSuchBucket' });

      code = 'NoSuchKey';
      await expect(store.read('a.txt')).resolves.toBeNull();
      await expect(store.read('a.txt', { range: { start: 0, end: 1 } })).resolves.toBeNull();
      await expect(store.copy('a.txt', 'b.txt')).resolves.toBeUndefined();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('an S3 one-level listing page', () => {
  it('sorts by bare key by default and by native name when the server pages that way', async () => {
    // One page as AWS sends it: file `o/a.txt` and folder `o/a/` in separate arrays.
    const server = createServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(
        '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
          '<Contents><Key>o/a.txt</Key><Size>1</Size></Contents>' +
          '<CommonPrefixes><Prefix>o/a/</Prefix></CommonPrefixes></ListBucketResult>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const client = new S3Client({
        endpoint: `http://127.0.0.1:${String(port)}`,
        region: 'us-east-1',
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
      });
      const keysOf = async (store: ReturnType<typeof createS3ObjectStore>) =>
        (await store.listPage('o')).entries.map((entry) => `${entry.kind}:${entry.key}`);

      await expect(keysOf(createS3ObjectStore({ client, bucket: 'b' }))).resolves.toEqual([
        'folder:o/a',
        'file:o/a.txt',
      ]);
      await expect(
        keysOf(createS3ObjectStore({ client, bucket: 'b', listingOrder: 'native' })),
      ).resolves.toEqual(['file:o/a.txt', 'folder:o/a']);

      // The deployment and connection openers name only the endpoint: no endpoint, or an
      // amazonaws.com one, is AWS and pages by native name; any other endpoint is SeaweedFS-like.
      const fromConfig = (endpoint?: string) =>
        createS3ObjectStoreFromConfig(
          {
            bucket: 'b',
            region: 'us-east-1',
            ...(endpoint === undefined ? {} : { endpoint }),
            createBucketIfMissing: false,
            checkBucketOnOpen: false,
          },
          client,
        );
      await expect(keysOf(await fromConfig())).resolves.toEqual(['file:o/a.txt', 'folder:o/a']);
      await expect(keysOf(await fromConfig('https://s3.eu-west-1.amazonaws.com'))).resolves.toEqual(
        ['file:o/a.txt', 'folder:o/a'],
      );
      await expect(keysOf(await fromConfig(`http://127.0.0.1:${String(port)}`))).resolves.toEqual([
        'folder:o/a',
        'file:o/a.txt',
      ]);
      await expect(keysOf(await fromConfig('https://amazonaws.com.example.test'))).resolves.toEqual(
        ['folder:o/a', 'file:o/a.txt'],
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('an S3 listing page and content types', () => {
  // #1746: ListObjectsV2 carries no content type, and a page used to send one HEAD per file for it.
  it('sends no HEAD unless the caller asks for content types, then one per file, a few at a time', async () => {
    const files = Array.from({ length: 20 }, (_, n) => `o/f${String(n).padStart(2, '0')}.txt`);
    let heads = 0;
    let inFlight = 0;
    let mostInFlight = 0;
    const server = createServer((request, response) => {
      if (request.method === 'HEAD') {
        heads += 1;
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        setTimeout(() => {
          inFlight -= 1;
          response.writeHead(200, {
            'content-type': 'text/csv',
            'content-length': '1',
            'x-amz-meta-aw-content-type-known': 'true',
          });
          response.end();
        }, 20);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(
        '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
          files.map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`).join('') +
          '</ListBucketResult>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const client = new S3Client({
        endpoint: `http://127.0.0.1:${String(port)}`,
        region: 'us-east-1',
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
      });
      const store = createS3ObjectStore({ client, bucket: 'b' });

      const plain = await store.listPage('o', { recursive: true });
      expect(heads).toBe(0);
      expect(plain.entries).toHaveLength(20);
      expect(
        plain.entries.every((entry) => entry.kind === 'file' && entry.contentType === null),
      ).toBe(true);

      const typed = await store.listPage('o', { recursive: true, contentTypes: true });
      expect(heads).toBe(20);
      expect(mostInFlight).toBeGreaterThan(1);
      expect(mostInFlight).toBeLessThanOrEqual(8);
      expect(typed.entries.map((entry) => entry.key)).toEqual(files);
      expect(
        typed.entries.every((entry) => entry.kind === 'file' && entry.contentType === 'text/csv'),
      ).toBe(true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('an S3 write', () => {
  // #1746: the time comes from the write's own response, so a write costs no second request.
  it("reports the server's time from the write's response, with no read-back HEAD", async () => {
    const serverTime = new Date('2020-01-01T00:00:00.000Z');
    const methods: string[] = [];
    const server = createServer((request, response) => {
      methods.push(request.method ?? '');
      request.resume();
      request.on('end', () => {
        response.writeHead(200, {
          etag: '"v1"',
          date: serverTime.toUTCString(),
          ...(request.method === 'HEAD'
            ? { 'last-modified': serverTime.toUTCString(), 'content-length': '3' }
            : {}),
        });
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const client = new S3Client({
        endpoint: `http://127.0.0.1:${String(port)}`,
        region: 'us-east-1',
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
      });
      // Two stores on one client: the response reader is registered once, not once per store.
      createS3ObjectStore({ client, bucket: 'b' });
      const store = createS3ObjectStore({ client, bucket: 'b' });
      const meta = await store.write('a.txt', new Uint8Array([1, 2, 3]), {});
      expect(meta.etag).toBe('"v1"');
      expect(meta.lastModified).toEqual(serverTime);
      expect(methods).toEqual(['PUT']);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

const endpoint = process.env['TEST_S3_ENDPOINT'];

if (endpoint === undefined || endpoint.trim() === '') {
  describe.skip('ObjectStore contract — S3 (SeaweedFS)', () => {
    it('requires TEST_S3_ENDPOINT (the repository test launcher supplies it)', () => undefined);
  });
} else {
  const client = new S3Client({
    endpoint,
    region: process.env['TEST_S3_REGION'] ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env['TEST_S3_ACCESS_KEY_ID'] ?? 'agent_workspace',
      secretAccessKey: process.env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'agent_workspace',
    },
  });

  async function setup(): Promise<ObjectStoreContractFixture & { readonly bucket: string }> {
    const bucket = `aw-contract-${randomUUID()}`;
    await ensureS3Bucket(client, bucket);
    return {
      bucket,
      signedUrlsFetchable: true,
      provider: createS3ObjectStoreProvider({ client, bucket }),
      plantRaw: async (key, bytes) => {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes }));
      },
      teardown: async () => {
        const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
        const objects = (listed.Contents ?? [])
          .filter((entry): entry is typeof entry & { Key: string } => entry.Key !== undefined)
          .map((entry) => ({ Key: entry.Key }));
        if (objects.length > 0) {
          await client.send(
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
          );
        }
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      },
    };
  }

  defineObjectStoreContract('S3 (SeaweedFS)', setup);

  describe('S3 conditional create (SeaweedFS)', () => {
    const PART = 5 * 1024 * 1024; // UPLOAD_PART_BYTES in s3-store.ts
    // Generated chunk by chunk so the multipart path is taken without holding the body.
    function generated(totalBytes: number): ReadableStream<Uint8Array> {
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = Math.min(1024 * 1024, totalBytes - sent);
          if (chunk === 0) controller.close();
          else controller.enqueue(new Uint8Array(chunk).fill(7));
          sent += chunk;
        },
      });
    }

    it.each([
      ['a body that fits one PutObject', 1024],
      ['a body above one part (multipart)', PART + 1024 * 1024],
    ])('ifNoneMatch "*" conflicts for %s and keeps the original', async (_label, bytes) => {
      const { bucket, provider, teardown } = await setup();
      try {
        const store = provider.forWorkspace('ws-1');
        const first = await store.write('a.bin', new TextEncoder().encode('original'), {});
        await expect(store.write('a.bin', generated(bytes), { ifNoneMatch: '*' })).rejects.toThrow(
          ObjectConflictError,
        );
        // A conflict on CompleteMultipartUpload must not leave the uploaded parts behind.
        const pending = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
        expect(pending.Uploads ?? []).toEqual([]);
        expect((await store.head('a.bin'))?.etag).toBe(first.etag);
        const created = await store.write('b.bin', generated(bytes), { ifNoneMatch: '*' });
        expect(created.sizeBytes).toBe(bytes);
        expect((await store.head('b.bin'))?.sizeBytes).toBe(bytes);
      } finally {
        await teardown();
      }
    });
  });

  describe('S3 presigned URLs (SeaweedFS)', () => {
    async function withStore(
      run: (
        store: ObjectStore,
        put: (url: string, init: RequestInit) => Promise<Response>,
      ) => Promise<void>,
    ): Promise<void> {
      const fixture = await setup();
      try {
        await run(fixture.provider.forWorkspace('ws-1'), (url, init) =>
          fetch(url, { ...init, method: 'PUT' }),
        );
      } finally {
        await fixture.teardown();
      }
    }

    it('accepts a PUT to the signed URL and serves the bytes back through the store', async () => {
      await withStore(async (store, put) => {
        const body = new TextEncoder().encode('hello');
        const signed = await store.createSignedUrl?.('.attachments/s1/u1/a.txt', {
          method: 'PUT',
          expiresInSeconds: 60,
          contentType: 'text/plain',
          contentLength: body.byteLength,
        });
        expect(signed).toBeDefined();
        const response = await put(signed?.url ?? '', { headers: signed?.headers ?? {}, body });
        expect(response.status).toBe(200);
        const stored = await readWhole(store, '.attachments/s1/u1/a.txt');
        expect(new TextDecoder().decode(stored?.body)).toBe('hello');
        expect(stored?.contentType).toBe('text/plain');
      });
    });

    it('refuses a URL after its expiry', async () => {
      await withStore(async (store, put) => {
        const signed = await store.createSignedUrl?.('a.txt', {
          method: 'PUT',
          expiresInSeconds: 60,
          now: new Date(Date.now() - 120_000),
        });
        const response = await put(signed?.url ?? '', { body: new Uint8Array([1]) });
        expect(response.status).toBe(403);
        expect(await readWhole(store, 'a.txt')).toBeNull();
      });
    });

    it('refuses a URL whose key path was edited', async () => {
      await withStore(async (store, put) => {
        const signed = await store.createSignedUrl?.('.attachments/s1/a.txt', {
          method: 'PUT',
          expiresInSeconds: 60,
        });
        const edited = (signed?.url ?? '').replace('.attachments/s1/', '.attachments/s2/');
        const response = await put(edited, { body: new Uint8Array([1]) });
        expect(response.status).toBe(403);
        expect(await readWhole(store, '.attachments/s2/a.txt')).toBeNull();
      });
    });

    it('refuses an upload whose declared content type or length was changed', async () => {
      await withStore(async (store, put) => {
        const signed = await store.createSignedUrl?.('a.txt', {
          method: 'PUT',
          expiresInSeconds: 60,
          contentType: 'text/plain',
          contentLength: 5,
        });
        const response = await put(signed?.url ?? '', {
          headers: { ...signed?.headers, 'content-type': 'text/html' },
          body: new Uint8Array(5),
        });
        expect(response.status).toBe(403);
      });
    });

    it('serves a signed GET with the forced attachment disposition', async () => {
      await withStore(async (store) => {
        await store.write('a.txt', new TextEncoder().encode('bytes'), { contentType: 'text/html' });
        const signed = await store.createSignedUrl?.('a.txt', {
          method: 'GET',
          expiresInSeconds: 60,
          responseContentType: 'application/octet-stream',
          responseDisposition: 'attachment; filename="a.txt"',
        });
        const response = await fetch(signed?.url ?? '');
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('bytes');
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="a.txt"');
        expect(response.headers.get('content-type')).toBe('application/octet-stream');
      });
    });
  });

  describe('S3 bucket readiness policy', () => {
    it('does not create a missing bucket when native-cloud provisioning is disabled', async () => {
      const bucket = `aw-must-already-exist-${randomUUID()}`;
      await expect(
        createS3ObjectStoreProviderFromConfig(
          {
            bucket,
            region: process.env['TEST_S3_REGION'] ?? 'us-east-1',
            createBucketIfMissing: false,
          },
          client,
        ),
      ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });

      // A second head still fails: the readiness check did not turn a typo into infrastructure.
      await expect(client.send(new ListObjectsV2Command({ Bucket: bucket }))).rejects.toMatchObject(
        { $metadata: { httpStatusCode: 404 } },
      );
    });
  });
}
