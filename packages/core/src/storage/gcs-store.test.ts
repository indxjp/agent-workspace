import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import { Storage, type Bucket, type StorageOptions } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  defineObjectStoreContract,
  defineObjectKeyContract,
  type ObjectStoreContractFixture,
} from './contract.js';
import {
  createFakeGcsObjectStore,
  createGcsObjectStore,
  createGcsObjectStoreFromConfig,
  createGcsObjectStoreProvider,
  createNativeGcsClient,
  GcsEndpointForbiddenError,
  gcsStorageOptions,
  type GcsClient,
  type GcsStoredObject,
} from './gcs-store.js';
import { ObjectConflictError } from './object-store.js';
import { bytesToStream, listAll, readWhole, resolveRange, streamToBytes } from './streams.js';

// Points every client the store builds at a local stub while set, over any endpoint its config
// names; a custom endpoint drops auth unless asked to keep it.
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
    delete(name: string): Promise<void> {
      objects.delete(name);
      return Promise.resolve();
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

function setup(): Promise<ObjectStoreContractFixture> {
  const client = createFakeGcsClient();
  return Promise.resolve({
    provider: createGcsObjectStoreProvider({ client }),
    teardown: () => {
      client.objects.clear();
      return Promise.resolve();
    },
    plantRaw: async (key, bytes) => {
      await client.writeStream(key, bytes, {});
    },
  });
}

defineObjectStoreContract('Google Cloud Storage (offline fake)', setup);

// The real SDK adapter against fake-gcs-server over HTTP. The live acceptance fixture stays the
// proof for Google Cloud Storage itself (the emulator does not verify signatures).
//
// Only the keys-and-tenants contract: on each page of a delimited listing fake-gcs-server 1.56.1
// returns every common prefix at or after the page's start, uncapped, so a prefix that sorts after
// the page's items comes back on every later page, and it does not count prefixes against
// maxResults (GCS counts items and prefixes together). The full contract's paging case therefore
// fails on the emulator, not on the store.
// The read and write paths over this emulator are exercised by tests/load/object-store-round-trip.
const gcsEndpoint = process.env['TEST_GCS_ENDPOINT']?.trim() ?? '';
if (gcsEndpoint !== '') {
  // The factory tests/load opens its store with, so this leg also proves it.
  const setupEmulator = (): Promise<ObjectStoreContractFixture> =>
    createFakeGcsObjectStore(gcsEndpoint);
  defineObjectKeyContract('Google Cloud Storage (fake-gcs-server)', setupEmulator);

  // Owner decision (c) on #1746: a foreign `name/` placeholder object (a console "create folder")
  // is hidden: never a file entry, and the folder it implies lists as empty, as on S3 and Azure.
  it('hides a foreign folder placeholder object from every fake-gcs-server listing', async () => {
    const { provider, teardown, plantRaw } = await createFakeGcsObjectStore(gcsEndpoint);
    try {
      const workspace = '11111111-1111-4111-8111-111111111111';
      const store = provider.forWorkspace(workspace);
      await store.write('docs/real.txt', new TextEncoder().encode('real'), {});
      await plantRaw(`workspaces/${workspace}/docs/console-folder/`, new Uint8Array());
      await plantRaw(`workspaces/${workspace}/docs/console-folder/inner/`, new Uint8Array());

      const keys = async (prefix: string, recursive: boolean): Promise<string[]> =>
        (await listAll(store, prefix, { recursive })).map((entry) => `${entry.kind}:${entry.key}`);
      await expect(keys('docs', true)).resolves.toEqual(['file:docs/real.txt']);
      await expect(keys('docs', false)).resolves.toEqual([
        'folder:docs/console-folder',
        'file:docs/real.txt',
      ]);
      await expect(keys('docs/console-folder', true)).resolves.toEqual([]);
      await expect(keys('docs/console-folder', false)).resolves.toEqual([
        'folder:docs/console-folder/inner',
      ]);
    } finally {
      await teardown();
    }
  });

  it('copy() copies bytes and content type on fake-gcs-server and ignores a missing source', async () => {
    const { provider, teardown } = await setupEmulator();
    try {
      const store = provider.forWorkspace('11111111-1111-4111-8111-111111111111');
      await store.write('from.txt', new TextEncoder().encode('payload'), {
        contentType: 'text/plain',
      });
      await store.copy('from.txt', 'to.txt');
      await store.copy('gone.txt', 'never.txt');
      expect(await store.head('to.txt')).toMatchObject({ sizeBytes: 7, contentType: 'text/plain' });
      expect(await store.head('from.txt')).not.toBeNull();
      expect(await store.head('never.txt')).toBeNull();
    } finally {
      await teardown();
    }
  });
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
    await files.write('shared.txt', new TextEncoder().encode('file'), {});
    await skills.write('shared.txt', new TextEncoder().encode('skill'), {});

    expect(new TextDecoder().decode((await readWhole(files, 'shared.txt'))?.body)).toBe('file');
    expect(new TextDecoder().decode((await readWhole(skills, 'shared.txt'))?.body)).toBe('skill');
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
    await store.write('visible.txt', new TextEncoder().encode('visible'), {});

    // A delimited listing reports the placeholder's prefix as a folder, as S3 and Azure do.
    await expect(listAll(store, '')).resolves.toEqual([
      { kind: 'folder', key: 'reports' },
      expect.objectContaining({ kind: 'file', key: 'visible.txt' }),
    ]);
    await expect(listAll(store, '', { recursive: true })).resolves.toEqual([
      expect.objectContaining({ kind: 'file', key: 'visible.txt' }),
    ]);
  });

  it('lists every object of the raw store under an empty prefix, in code-unit order', async () => {
    const store = createGcsObjectStore({ client: createFakeGcsClient() });
    for (const key of ['b.txt', 'a/z.txt', 'B.txt']) {
      await store.write(key, new TextEncoder().encode(key), {});
    }

    const { entries: listed } = await store.listPage('', { recursive: true });

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

  // #1991 A3: the media request starts lazily, after `readStream` resolved with the metadata.
  it('[US-STO-12][unit][sdk] a delayed download refusal never exposes its bearer token', async () => {
    const token = `ya29.${randomUUID()}`;
    const stub = createServer((request, response) => {
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
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
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

      const found = await createNativeGcsClient(storage.bucket('acme-data')).readStream(
        'ws/a.txt',
        undefined,
      );
      expect(found?.object.sizeBytes).toBe(4);
      const error: unknown = await streamToBytes(
        found?.body ?? new ReadableStream<Uint8Array>(),
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      const chain = (value: unknown): string =>
        value instanceof Error
          ? `${String(value)}\n${value.stack ?? ''}\n${JSON.stringify(value)}\n${chain(value.cause)}`
          : '';
      expect(chain(error)).not.toContain(token);
      expect(error).toMatchObject({ statusCode: 403 });
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

  // #1925 item 15: a bucket deleted after delivery must fail a write-back, not count as a conflict.
  it('[US-STO-12][unit][sdk] a missing bucket is an error on head and read, a missing object is null', async () => {
    // The JSON API's own 404 bodies for objects.get: the bucket's, then the object's.
    let body = { error: { code: 404, message: 'The specified bucket does not exist.' } };
    const stub = createServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = stub.address() as AddressInfo;
      const storage = new Storage({
        ...(await gcsStorageOptions({
          bucket: 'gone-bucket',
          projectId: 'acme-prod',
          accessToken: `ya29.${randomUUID()}`,
        })),
        apiEndpoint: `http://127.0.0.1:${String(port)}`,
        useAuthWithCustomEndpoint: true,
        retryOptions: { autoRetry: false },
      });
      const client = createNativeGcsClient(storage.bucket('gone-bucket'));

      await expect(client.head('ws/a.txt')).rejects.toThrow(/bucket/iu);
      await expect(client.readStream('ws/a.txt', undefined)).rejects.toThrow(/bucket/iu);

      body = { error: { code: 404, message: 'No such object: gone-bucket/ws/a.txt' } };
      await expect(client.head('ws/a.txt')).resolves.toBeNull();
      await expect(client.readStream('ws/a.txt', undefined)).resolves.toBeNull();
    } finally {
      stub.closeAllConnections();
      stub.close();
    }
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

// Live GCS (#1835 follow-up): a configured store sanitises provider errors, and it wrapped the
// caller's own failing body as "Google Cloud Storage write failed." too. fake-gcs-server runs the
// unsanitised native client, so only a configured store over a stub shows it.
describe('a configured GCS store whose caller body fails', () => {
  it('rejects with the body error, not a sanitised provider error', async () => {
    const server = await recordingServer(() => ({ status: 200, body: {} }));
    try {
      const store = await createGcsObjectStoreFromConfig({
        bucket: 'acme-data',
        projectId: 'acme-prod',
        accessToken: `ya29.${randomUUID()}`,
        apiEndpoint: server.url,
        checkBucketOnOpen: false,
      });
      let pulls = 0;
      const failing = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls > 2) controller.error(new Error('source broke'));
          else controller.enqueue(new Uint8Array(1024).fill(7));
        },
      });
      await expect(store.write('half.bin', failing, {})).rejects.toThrow('source broke');
      // A provider failure is still sanitised.
      const refused = await recordingServer(() => ({ status: 503, body: { error: 'down' } }));
      try {
        const down = await createGcsObjectStoreFromConfig({
          bucket: 'acme-data',
          projectId: 'acme-prod',
          accessToken: `ya29.${randomUUID()}`,
          apiEndpoint: refused.url,
          checkBucketOnOpen: false,
          timeoutMs: 1_000,
        });
        await expect(down.write('a.txt', new Uint8Array([1]), {})).rejects.toThrow(
          'Google Cloud Storage write failed.',
        );
      } finally {
        refused.close();
      }
    } finally {
      server.close();
    }
  });
});

describe('a GCS store that must dial its endpoint', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('[US-STO-12][unit][sdk] is refused before any request when STORAGE_EMULATOR_HOST redirects the SDK', async () => {
    const emulator = await recordingServer(() => ({ status: 200, body: {} }));
    vi.stubEnv('STORAGE_EMULATOR_HOST', emulator.url);
    const config = {
      bucket: 'acme-data',
      projectId: 'acme-prod',
      accessToken: `ya29.${randomUUID()}`,
      checkBucketOnOpen: false,
    } as const;
    try {
      // The SDK honours the variable by itself, so only the flag stops the redirect.
      await expect(createGcsObjectStoreFromConfig(config)).resolves.toBeDefined();
      await expect(
        createGcsObjectStoreFromConfig({ ...config, requireApiEndpoint: true }),
      ).rejects.toBeInstanceOf(GcsEndpointForbiddenError);
      expect(emulator.requests).toEqual([]);
    } finally {
      emulator.close();
    }
  });

  it('[US-STO-12][unit][sdk] opens when the SDK keeps the Google endpoint', async () => {
    await expect(
      createGcsObjectStoreFromConfig({
        bucket: 'acme-data',
        projectId: 'acme-prod',
        accessToken: `ya29.${randomUUID()}`,
        checkBucketOnOpen: false,
        requireApiEndpoint: true,
      }),
    ).resolves.toBeDefined();
  });

  it('[US-STO-12][unit][sdk] dials a configured endpoint, and is still refused when STORAGE_EMULATOR_HOST redirects it', async () => {
    const configured = await recordingServer(() => ({
      status: 200,
      body: { kind: 'storage#objects' },
    }));
    const emulator = await recordingServer(() => ({ status: 200, body: {} }));
    const token = `ya29.${randomUUID()}`;
    const config = {
      bucket: 'acme-data',
      projectId: 'acme-prod',
      accessToken: token,
      apiEndpoint: configured.url,
      requireApiEndpoint: true,
    } as const;
    try {
      vi.stubEnv('STORAGE_EMULATOR_HOST', emulator.url);
      await expect(createGcsObjectStoreFromConfig(config)).rejects.toBeInstanceOf(
        GcsEndpointForbiddenError,
      );
      vi.unstubAllEnvs();
      expect(configured.requests).toEqual([]);
      expect(emulator.requests).toEqual([]);

      const store = await createGcsObjectStoreFromConfig(config);
      await expect(store.listPage('', { limit: 1 })).resolves.toEqual({
        entries: [],
        cursor: null,
      });
      // The open's one-object bucket check, then the listing; both carry the connection's token.
      expect(configured.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        expect.stringMatching(/^GET \/storage\/v1\/b\/acme-data\/o\?/u),
        expect.stringMatching(/^GET \/storage\/v1\/b\/acme-data\/o\?/u),
      ]);
      expect(configured.requests.map(({ authorization }) => authorization)).toEqual([
        `Bearer ${token}`,
        `Bearer ${token}`,
      ]);
      expect(emulator.requests).toEqual([]);
    } finally {
      configured.close();
      emulator.close();
    }
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
      await expect(store.listPage('', { recursive: true })).resolves.toEqual({
        entries: [],
        cursor: null,
      });
      await expect(store.read('a.txt')).resolves.toBeNull();
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

/** GCS's `md5Hash`: the base64 MD5 of the stored bytes. */
function md5Of(text: string): string {
  return createHash('md5').update(text).digest('base64');
}

describe('native GCS client streamed write', () => {
  it('returns the generation of its own upload, not one a later metadata call sees', async () => {
    const written = {
      size: '4',
      updated: '2026-10-22T00:00:00.000Z',
      generation: '5',
      md5Hash: md5Of('mine'),
    };
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

  // #1746: the SDK's own check deleted a mismatched upload with no precondition, so it could
  // delete a concurrent writer's newer generation.
  it('deletes an upload whose bytes do not match only at its own generation', async () => {
    const deletes: unknown[] = [];
    const uploading = (md5Hash: string) => {
      const file = {
        name: 'ws/a.txt',
        metadata: {},
        createWriteStream: () =>
          new Writable({
            write: (_chunk, _encoding, callback) => {
              callback();
            },
            final: (callback) => {
              file.metadata = {
                size: '4',
                updated: '2026-10-22T00:00:00.000Z',
                generation: '7',
                md5Hash,
              };
              callback();
            },
          }),
        delete: (options: unknown) => {
          deletes.push(options);
          return Promise.resolve([{}]);
        },
      };
      return { file: () => file } as unknown as Bucket;
    };
    const body = (): Uint8Array => new TextEncoder().encode('mine');

    await expect(
      createNativeGcsClient(uploading(md5Of('else'))).writeStream('ws/a.txt', body(), {}),
    ).rejects.toThrow(Error);
    expect(deletes).toEqual([{ ifGenerationMatch: 7 }]);

    deletes.length = 0;
    const object = await createNativeGcsClient(uploading(md5Of('mine'))).writeStream(
      'ws/a.txt',
      body(),
      {},
    );
    expect(object.etag).toBe('7');
    expect(deletes).toEqual([]);
  });

  it('reports a failed cleanup of a mismatched upload by its status alone', async () => {
    const providerWords = `provider words ${randomUUID()}`;
    const failingDelete = (): Promise<never> =>
      Promise.reject(Object.assign(new Error(providerWords), { code: 503 }));
    const file = {
      name: 'ws/a.txt',
      metadata: {},
      createWriteStream: () =>
        new Writable({
          write: (_chunk, _encoding, callback) => {
            callback();
          },
          final: (callback) => {
            file.metadata = {
              size: '4',
              updated: '2026-10-22T00:00:00.000Z',
              generation: '7',
              md5Hash: md5Of('else'),
            };
            callback();
          },
        }),
      delete: failingDelete,
    };
    const bucket = { file: () => file } as unknown as Bucket;

    const failure: unknown = await createNativeGcsClient(bucket)
      .writeStream('ws/a.txt', new TextEncoder().encode('mine'), {})
      .then(
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
