import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  defineObjectStoreContract,
  defineObjectStoreV2Contract,
  type ObjectStoreV2ContractFixture,
} from './contract.js';
import { ObjectConflictError, type ObjectStore } from './object-store.js';
import {
  createS3ObjectStoreProvider,
  createS3ObjectStoreProviderFromConfig,
  ensureS3Bucket,
} from './s3-store.js';

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

  async function setup(): Promise<ObjectStoreV2ContractFixture & { readonly bucket: string }> {
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
  defineObjectStoreV2Contract('S3 (SeaweedFS)', setup);

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
        const stored = await store.get('.attachments/s1/u1/a.txt');
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
        expect(await store.get('a.txt')).toBeNull();
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
        expect(await store.get('.attachments/s2/a.txt')).toBeNull();
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
        await store.put('a.txt', {
          body: new TextEncoder().encode('bytes'),
          contentType: 'text/html',
        });
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
