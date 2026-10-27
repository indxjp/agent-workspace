import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import { Storage, type Bucket, type StorageOptions } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  defineObjectStoreContract,
  defineObjectStoreV2Contract,
  type ObjectStoreV2ContractFixture,
} from './contract.js';
import {
  createGcsObjectStore,
  createGcsObjectStoreFromConfig,
  createGcsObjectStoreProvider,
  createNativeGcsClient,
  gcsStorageOptions,
  type GcsClient,
  type GcsObjectContent,
  type GcsStoredObject,
} from './gcs-store.js';
import { ObjectConflictError, type PutObjectInput } from './object-store.js';
import { bytesToStream, resolveRange, streamToBytes } from './streams.js';

// Points every client the store builds at a local stub while set. The store's config has no
// endpoint, so production keeps none; a custom endpoint drops auth unless asked to keep it.
const redirect = vi.hoisted(() => ({ apiEndpoint: '' }));
vi.mock('@google-cloud/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google-cloud/storage')>();
  class RedirectedStorage extends actual.Storage {
    public constructor(options: StorageOptions = {}) {
      super(
        redirect.apiEndpoint === ''
          ? options
          : {
              ...options,
              apiEndpoint: redirect.apiEndpoint,
              useAuthWithCustomEndpoint: true,
              retryOptions: { autoRetry: false },
            },
      );
    }
  }
  return { ...actual, Storage: RedirectedStorage };
});

/** A local HTTP server that records each request and answers it with `reply`. */
async function recordingServer(
  reply: (method: string, url: string) => { status: number; body: unknown },
): Promise<{
  url: string;
  host: string;
  requests: { method: string; url: string; authorization: string | undefined }[];
  close: () => void;
}> {
  const requests: { method: string; url: string; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const method = request.method ?? '';
    const url = request.url ?? '';
    requests.push({ method, url, authorization: request.headers.authorization });
    request.resume();
    request.on('end', () => {
      const { status, body } = reply(method, url);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    url: `http://${host}`,
    host,
    requests,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

interface FakeObject {
  readonly body: Uint8Array;
  readonly contentType: string | null;
  readonly contentTypeKnown: boolean;
  readonly lastModified: Date;
  readonly generation: number;
}

// Like a GCS page token, the cursor does not expose the object name it resumes after.
const encodeCursor = (name: string): string => Buffer.from(name).toString('base64url');
const decodeCursor = (cursor: string): string => Buffer.from(cursor, 'base64url').toString();

function createFakeGcsClient(): GcsClient & { readonly objects: Map<string, FakeObject> } {
  const objects = new Map<string, FakeObject>();
  let clock = 0;
  const metadata = (name: string, object: FakeObject): GcsStoredObject => ({
    name,
    sizeBytes: object.body.byteLength,
    contentType: object.contentType,
    contentTypeKnown: object.contentTypeKnown,
    lastModified: object.lastModified,
    etag: String(object.generation),
  });
  return {
    objects,
    write(name: string, input: PutObjectInput): Promise<void> {
      clock += 1;
      objects.set(name, {
        body: Uint8Array.from(input.body),
        contentType: input.contentType ?? null,
        contentTypeKnown: input.contentType !== undefined && input.contentType !== null,
        lastModified: new Date(clock * 1_000),
        generation: clock,
      });
      return Promise.resolve();
    },
    read(name: string): Promise<GcsObjectContent | null> {
      const object = objects.get(name);
      return Promise.resolve(
        object === undefined ? null : { ...metadata(name, object), body: object.body },
      );
    },
    delete(name: string): Promise<void> {
      objects.delete(name);
      return Promise.resolve();
    },
    list(prefix: string): Promise<readonly GcsStoredObject[]> {
      return Promise.resolve(
        [...objects.entries()]
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, object]) => metadata(name, object)),
      );
    },
    copy(sourceName: string, destinationName: string): Promise<void> {
      const source = objects.get(sourceName);
      if (source !== undefined) {
        clock += 1;
        objects.set(destinationName, {
          ...source,
          body: Uint8Array.from(source.body),
          lastModified: new Date(clock * 1_000),
          generation: clock,
        });
      }
      return Promise.resolve();
    },
    head(name) {
      const object = objects.get(name);
      return Promise.resolve(object === undefined ? null : metadata(name, object));
    },
    readStream(name, range) {
      const object = objects.get(name);
      if (object === undefined) return Promise.resolve(null);
      const served = resolveRange(range, object.body.byteLength);
      const bytes = served === null ? object.body : object.body.slice(served.start, served.end + 1);
      return Promise.resolve({ object: metadata(name, object), body: bytesToStream(bytes) });
    },
    async writeStream(name, body, options) {
      const bytes = body instanceof Uint8Array ? body : await streamToBytes(body);
      const current = objects.get(name);
      if (options.ifNoneMatch === '*' && current !== undefined) throw new ObjectConflictError();
      if (options.ifMatch !== undefined && String(current?.generation) !== options.ifMatch) {
        throw new ObjectConflictError();
      }
      clock += 1;
      const stored: FakeObject = {
        body: Uint8Array.from(bytes),
        contentType: options.contentType ?? null,
        contentTypeKnown: options.contentType !== undefined && options.contentType !== null,
        lastModified: new Date(clock * 1_000),
        generation: clock,
      };
      objects.set(name, stored);
      return metadata(name, stored);
    },
    listPage(prefix, options) {
      const files = new Map<string, FakeObject>();
      const folders = new Set<string>();
      for (const [name, object] of objects) {
        if (!name.startsWith(prefix)) continue;
        const slash = name.slice(prefix.length).indexOf('/');
        if (options.delimiter && slash >= 0) {
          folders.add(`${prefix}${name.slice(prefix.length, prefix.length + slash)}/`);
        } else {
          files.set(name, object);
        }
      }
      // Pages hold files and folders together, ordered by name; the cursor resumes after one name.
      const after = options.cursor === undefined ? '' : decodeCursor(options.cursor);
      const rows = [...files.keys(), ...folders].sort().filter((row) => row > after);
      const page = rows.slice(0, options.limit);
      const last = page[page.length - 1];
      return Promise.resolve({
        objects: page.flatMap((row) => {
          const object = files.get(row);
          return object === undefined ? [] : [metadata(row, object)];
        }),
        folders: page.filter((row) => !files.has(row)),
        cursor: rows.length > options.limit && last !== undefined ? encodeCursor(last) : null,
      });
    },
  };
}

function setup(): Promise<ObjectStoreV2ContractFixture> {
  const client = createFakeGcsClient();
  return Promise.resolve({
    provider: createGcsObjectStoreProvider({ client }),
    teardown: () => {
      client.objects.clear();
      return Promise.resolve();
    },
    plantRaw: (key, bytes) => client.write(key, { body: bytes }),
  });
}

defineObjectStoreContract('Google Cloud Storage (offline fake)', setup);
defineObjectStoreV2Contract('Google Cloud Storage (offline fake)', setup);

// The real SDK adapter against fake-gcs-server over HTTP. The live acceptance fixture stays the
// proof for Google Cloud Storage itself (the emulator does not verify signatures).
//
// Only the v1 contract: fake-gcs-server 1.56.1 returns every common prefix on every page of a
// delimited listing and does not count prefixes against maxResults (GCS counts items and prefixes
// together), so the v2 contract's paging case fails on the emulator, not on the store. The v2
// read and write paths over this emulator are exercised by tests/load/object-store-round-trip.
const gcsEndpoint = process.env['TEST_GCS_ENDPOINT']?.trim() ?? '';
if (gcsEndpoint !== '') {
  const storage = new Storage({ apiEndpoint: gcsEndpoint, projectId: 'aw-test' });
  const setupEmulator = async (): Promise<ObjectStoreV2ContractFixture> => {
    const [bucket] = await storage.createBucket(`aw-${randomUUID()}`);
    return {
      provider: createGcsObjectStoreProvider({ client: createNativeGcsClient(bucket) }),
      teardown: async () => {
        await bucket.deleteFiles({ force: true });
        await bucket.delete();
      },
    };
  };
  defineObjectStoreContract('Google Cloud Storage (fake-gcs-server)', setupEmulator);
}

describe('GCS deployment prefixes', () => {
  it('keeps files and skills in separate prefixes while both round-trip', async () => {
    const client = createFakeGcsClient();
    const files = createGcsObjectStoreProvider({ client, keyPrefix: 'files' }).forWorkspace(
      '11111111-1111-4111-8111-111111111111',
    );
    const skills = createGcsObjectStoreProvider({ client, keyPrefix: 'skills' }).forWorkspace(
      '11111111-1111-4111-8111-111111111111',
    );
    await files.put('shared.txt', { body: new TextEncoder().encode('file') });
    await skills.put('shared.txt', { body: new TextEncoder().encode('skill') });

    expect(new TextDecoder().decode((await files.get('shared.txt'))?.body)).toBe('file');
    expect(new TextDecoder().decode((await skills.get('shared.txt'))?.body)).toBe('skill');
    expect([...client.objects.keys()].sort()).toEqual([
      'files/workspaces/11111111-1111-4111-8111-111111111111/shared.txt',
      'skills/workspaces/11111111-1111-4111-8111-111111111111/shared.txt',
    ]);
  });

  it('ignores foreign placeholder and encoded names without hiding addressable objects', async () => {
    const client = createFakeGcsClient();
    const store = createGcsObjectStoreProvider({ client, keyPrefix: 'files' }).forWorkspace(
      '11111111-1111-4111-8111-111111111111',
    );
    const foreignObject: FakeObject = {
      body: new Uint8Array(),
      contentType: null,
      contentTypeKnown: false,
      lastModified: new Date(1_000),
      generation: 1,
    };
    client.objects.set(
      'files/workspaces/11111111-1111-4111-8111-111111111111/reports/',
      foreignObject,
    );
    client.objects.set(
      'files/workspaces/11111111-1111-4111-8111-111111111111/foreign%name.txt',
      foreignObject,
    );
    await store.put('visible.txt', { body: new TextEncoder().encode('visible') });

    await expect(store.list('')).resolves.toEqual([
      expect.objectContaining({ kind: 'file', key: 'visible.txt' }),
    ]);
    await expect(store.listPrefix('')).resolves.toEqual([
      expect.objectContaining({ kind: 'file', key: 'visible.txt' }),
    ]);
  });

  it('lists every object of the raw store under an empty prefix, in code-unit order', async () => {
    const store = createGcsObjectStore({ client: createFakeGcsClient() });
    for (const key of ['b.txt', 'a/z.txt', 'B.txt']) {
      await store.put(key, { body: new TextEncoder().encode(key) });
    }

    const listed = await store.listPrefix('');

    expect(listed.map((entry) => entry.key)).toEqual(['B.txt', 'a/z.txt', 'b.txt']);
  });
});

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

describe('native GCS client errors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[US-STO-12][unit][sdk] an access token is sent as the bearer, with no ADC or project lookup, and never reaches the error', async () => {
    const token = `ya29.${randomUUID()}`;
    const authorizations: (string | undefined)[] = [];
    const stub = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 401, message: `rejected ${token}` } }));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const applicationDefault = vi.spyOn(GoogleAuth.prototype, 'getApplicationDefault');
    const projectId = vi.spyOn(GoogleAuth.prototype, 'getProjectId');
    try {
      const { port } = stub.address() as AddressInfo;
      const storage = new Storage({
        ...(await gcsStorageOptions({
          bucket: 'acme-data',
          projectId: 'acme-prod',
          accessToken: token,
        })),
        apiEndpoint: `http://127.0.0.1:${String(port)}`,
        useAuthWithCustomEndpoint: true,
        retryOptions: { autoRetry: false },
      });

      const error: unknown = await createNativeGcsClient(storage.bucket('acme-data'))
        .head('ws/a.txt')
        .catch((e: unknown) => e);

      expect(authorizations).toEqual([`Bearer ${token}`]);
      expect(applicationDefault).not.toHaveBeenCalled();
      expect(projectId).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(Error);
      const chain = (value: unknown): string =>
        value instanceof Error
          ? `${String(value)}\n${value.stack ?? ''}\n${JSON.stringify(value)}\n${chain(value.cause)}`
          : '';
      expect(chain(error)).not.toContain(token);
      expect(String((error as Error).cause)).toContain('HTTP 401');
    } finally {
      stub.closeAllConnections();
      stub.close();
    }
  });

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
    const chain = (value: unknown): string =>
      value instanceof Error
        ? `${String(value)}\n${value.stack ?? ''}\n${JSON.stringify(value)}\n${chain(value.cause)}`
        : '';
    expect(chain(error)).not.toContain(token);
    expect(String((error as Error).cause)).toContain('HTTP 403');
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

describe('a GCS store opened with an access token', () => {
  afterEach(() => {
    redirect.apiEndpoint = '';
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('[US-STO-12][unit][sdk] cannot sign, and never asks the metadata server or ADC across create, test, list, read, write and a sign attempt', async () => {
    const token = `ya29.${randomUUID()}`;
    const metadata = await recordingServer(() => ({ status: 404, body: {} }));
    const gcs = await recordingServer((method, url) => {
      if (method === 'GET' && url.startsWith('/storage/v1/b/acme-data?')) {
        return { status: 200, body: { name: 'acme-data' } };
      }
      if (method === 'GET' && url.startsWith('/storage/v1/b/acme-data/o?')) {
        return { status: 200, body: { kind: 'storage#objects' } };
      }
      return { status: 404, body: { error: { code: 404, message: 'Not Found' } } };
    });
    // Both overrides `gcp-metadata` reads, so no metadata request can leave for the real server.
    vi.stubEnv('GCE_METADATA_HOST', metadata.host);
    vi.stubEnv('GCE_METADATA_IP', metadata.host);
    redirect.apiEndpoint = gcs.url;
    const adc = vi.spyOn(
      GoogleAuth.prototype as unknown as { getApplicationDefaultAsync: () => Promise<unknown> },
      'getApplicationDefaultAsync',
    );
    try {
      const store = await createGcsObjectStoreFromConfig({
        bucket: 'acme-data',
        projectId: 'acme-prod',
        accessToken: token,
      });

      expect(store.capabilities.sign).toBe(false);
      expect(store.capabilities.boundLengthSign).toBe(false);
      expect(store).not.toHaveProperty('createSignedUrl');
      await expect(store.listPage('', { limit: 1 })).resolves.toEqual({
        entries: [],
        cursor: null,
      });
      await expect(store.list('')).resolves.toEqual([]);
      await expect(store.get('a.txt')).resolves.toBeNull();
      await expect(store.write('a.txt', new TextEncoder().encode('a'), {})).rejects.toThrow();
      await store.createSignedUrl?.('a.txt', { method: 'GET' }).catch(() => undefined);

      expect(adc).not.toHaveBeenCalled();
      expect(metadata.requests).toEqual([]);
      expect(gcs.requests.length).toBeGreaterThanOrEqual(5);
      for (const request of gcs.requests) expect(request.authorization).toBe(`Bearer ${token}`);
    } finally {
      gcs.close();
      metadata.close();
    }
  });
});

describe('native GCS client streamed write', () => {
  it('returns the generation of its own upload, not one a later metadata call sees', async () => {
    const written = { size: '4', updated: '2026-10-22T00:00:00.000Z', generation: '5' };
    // Another writer replaced the object between the upload and any follow-up metadata call.
    const replaced = { ...written, generation: '6' };
    const file = {
      name: 'ws/a.txt',
      metadata: {},
      // Like the SDK's simple upload: the response body becomes `file.metadata` on completion.
      createWriteStream: () =>
        new Writable({
          write: (_chunk, _encoding, callback) => {
            callback();
          },
          final: (callback) => {
            file.metadata = written;
            callback();
          },
        }),
      getMetadata: () => Promise.resolve([replaced]),
    };
    const bucket = { file: () => file } as unknown as Bucket;

    const object = await createNativeGcsClient(bucket).writeStream(
      'ws/a.txt',
      new TextEncoder().encode('mine'),
      {},
    );

    expect(object.etag).toBe('5');
  });
});
