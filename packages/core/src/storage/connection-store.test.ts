// @story US-STO-12
import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobServiceClient,
  ContainerSASPermissions,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { formatStorageUrl } from '@indx-workspace/contracts/storage-url';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectionStoreError,
  MEMBER_ACCESS,
  openConnectionStore,
  parseServiceAccount,
  pinnedLookup,
  readOnlyStore,
  ReadOnlyStoreError,
  type ConnectionCredential,
  type ConnectionStoreOptions,
} from './connection-store.js';
import { defineObjectStoreV2Contract } from './contract.js';
import {
  AzureAccountKeyConnection,
  AzureSasTokenConnection,
  azureCredentialFor,
  createAzureSdkBlobContainer,
} from './azure-blob-store.js';
import {
  createGcsObjectStoreFromConfig,
  GcsBucketUnavailableError,
  gcsStorageOptions,
} from './gcs-store.js';
import { createInMemoryObjectStore } from './memory-store.js';
import { scopedObjectStoreProvider, type ObjectStoreV2 } from './object-store.js';
import { ensureS3Bucket } from './s3-store.js';

// The opener imports `gcs-store.js` itself; a test can make its store construction fail.
vi.mock('./gcs-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gcs-store.js')>();
  return {
    ...actual,
    createGcsObjectStoreFromConfig: vi.fn(actual.createGcsObjectStoreFromConfig),
  };
});

const production = { production: true, allowHosts: [] } as const;
const local = { production: false, allowHosts: [] } as const;
const bytes = new Uint8Array([1, 2, 3]);

// Built at runtime so no key-shaped literal sits in the source for a secret scanner to flag.
const s3Credential = (): Extract<ConnectionCredential, { provider: 's3' }> => ({
  provider: 's3',
  accessKeyId: ['AK', 'IA', randomBytes(8).toString('hex').toUpperCase()].join(''),
  secretAccessKey: randomBytes(20).toString('base64'),
});

const open = (
  url: string,
  credential: ConnectionCredential,
  options: Partial<ConnectionStoreOptions> = {},
): Promise<ObjectStoreV2> =>
  openConnectionStore(url, credential, {
    writable: false,
    fileRoots: [],
    egress: production,
    ...options,
  });

async function tempRoot(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-connection-')));
}

async function codeOf(attempt: Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt;
  } catch (error) {
    return error instanceof ConnectionStoreError ? error.code : String(error);
  }
  return undefined;
}

describe('openConnectionStore', () => {
  it('[US-STO-12][unit][sdk] a file:// connection lists and reads the files already in the folder', async () => {
    const root = await tempRoot();
    try {
      await mkdir(path.join(root, 'reports', '2026'), { recursive: true });
      await writeFile(path.join(root, 'reports', 'a.txt'), 'alpha');
      await writeFile(path.join(root, 'reports', '2026', 'b.txt'), 'bravo');
      const store = await open(`file://${root}`, { provider: 'file' }, { fileRoots: [root] });

      const page = await store.listPage('reports');
      expect(page.entries).toMatchObject([
        { kind: 'folder', key: 'reports/2026' },
        { kind: 'file', key: 'reports/a.txt', sizeBytes: 5, contentType: 'text/plain' },
      ]);
      expect(new TextDecoder().decode((await store.get('reports/2026/b.txt'))?.body)).toBe('bravo');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('[US-STO-12][unit][sdk] a read-only connection store throws ReadOnlyStoreError on write', async () => {
    const root = await tempRoot();
    try {
      const store = await open(`file://${root}`, { provider: 'file' }, { fileRoots: [root] });
      await expect(store.write('a.txt', bytes, {})).rejects.toBeInstanceOf(ReadOnlyStoreError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('[US-STO-12][unit][sdk] every non-read member of ObjectStoreV2 is refused when read-only', async () => {
    type WriteMember = {
      [K in keyof typeof MEMBER_ACCESS]: (typeof MEMBER_ACCESS)[K] extends 'write' ? K : never;
    }[keyof typeof MEMBER_ACCESS];
    const calls: Record<WriteMember, (store: ObjectStoreV2) => Promise<unknown>> = {
      put: (store) => store.put('a.txt', { body: bytes }),
      delete: (store) => store.delete('a.txt'),
      copyObject: (store) => store.copyObject('a.txt', 'b.txt'),
      write: (store) => store.write('a.txt', bytes, {}),
    };
    const store = readOnlyStore(createInMemoryObjectStore());
    for (const [member, access] of Object.entries(MEMBER_ACCESS)) {
      if (access !== 'write') continue;
      const call = calls[member as WriteMember];
      await expect(call(store)).rejects.toBeInstanceOf(ReadOnlyStoreError);
    }
    expect(await store.head('a.txt')).toBeNull();
  });

  it('[US-STO-12][unit][sdk] a signed PUT URL is refused and a signed GET URL is not', async () => {
    const sign = vi.fn(() => Promise.resolve({ url: 'https://store.example/k', headers: {} }));
    const store = readOnlyStore({ ...createInMemoryObjectStore(), createSignedUrl: sign });
    await expect(store.createSignedUrl?.('k', { method: 'PUT' })).rejects.toBeInstanceOf(
      ReadOnlyStoreError,
    );
    expect(sign).not.toHaveBeenCalled();
    await expect(store.createSignedUrl?.('k', { method: 'GET' })).resolves.toMatchObject({
      url: 'https://store.example/k',
    });
    expect('createSignedUrl' in readOnlyStore(createInMemoryObjectStore())).toBe(false);
  });

  it('[US-STO-12][unit][sdk] a read-only connection still reads, and a writable one writes', async () => {
    const root = await tempRoot();
    try {
      const writable = await open(
        `file://${root}`,
        { provider: 'file' },
        { fileRoots: [root], writable: true },
      );
      await writable.write('a.txt', bytes, {});
      const readOnly = await open(`file://${root}`, { provider: 'file' }, { fileRoots: [root] });
      expect((await readOnly.head('a.txt'))?.sizeBytes).toBe(3);
      expect((await readOnly.list('')).map((entry) => entry.key)).toContain('a.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('[US-STO-12][unit][sdk] an aborted signal stops the open and the listing', async () => {
    const root = await tempRoot();
    try {
      const aborted = AbortSignal.abort();
      const file = { provider: 'file' } as const;
      await expect(
        open(`file://${root}`, file, { fileRoots: [root], signal: aborted }),
      ).rejects.toBe(aborted.reason);
      const store = await open(`file://${root}`, file, { fileRoots: [root] });
      await expect(store.listPage('', { signal: aborted })).rejects.toBe(aborted.reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('[US-STO-12][unit][sdk] file connections stay under the allowed roots', async () => {
    const base = await tempRoot();
    try {
      const root = path.join(base, 'root');
      const sibling = path.join(base, 'rootX');
      const outside = path.join(base, 'outside');
      const inside = path.join(root, 'team');
      await Promise.all([inside, sibling, outside].map((dir) => mkdir(dir, { recursive: true })));
      await symlink(outside, path.join(root, 'escape'));
      const file = { provider: 'file' } as const;
      const attempt = (target: string, fileRoots: readonly string[] = [root]): Promise<unknown> =>
        open(`file://${target}`, file, { fileRoots });

      await expect(attempt(inside)).resolves.toBeDefined();
      await expect(attempt(root)).resolves.toBeDefined();
      await expect(attempt(inside, [`${root}/../root`])).resolves.toBeDefined();
      const refused = await Promise.all(
        [
          attempt(outside),
          attempt(sibling),
          attempt(path.join(root, 'escape')),
          attempt(path.join(inside, 'missing')),
          attempt(inside, []),
          attempt(inside, [path.join(base, 'missing-root')]),
        ].map(codeOf),
      );
      expect(new Set(refused)).toEqual(new Set(['storage_connection_endpoint_forbidden']));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('[US-STO-12][unit][sdk] a URL with a secret, a bad URL and the wrong credential are refused', async () => {
    const credential = s3Credential();
    expect(await codeOf(open(`s3://acme-data:${credential.provider}@x`, credential))).toBe(
      'storage_connection_url_has_secret',
    );
    expect(await codeOf(open('ftp://acme-data', credential))).toBe(
      'storage_connection_url_invalid',
    );
    expect(await codeOf(open('gcs://acme-data', credential))).toBe(
      'storage_connection_url_invalid',
    );
    expect(await codeOf(open('s3://acme-data', { provider: 'file' }))).toBe(
      'storage_connection_url_invalid',
    );
    expect(await codeOf(open('s3://acme-data', { provider: 's3' } as ConnectionCredential))).toBe(
      'storage_connection_url_invalid',
    );
  });
});

describe('connection store endpoint guard', () => {
  const resolveTo =
    (...addresses: string[]) =>
    () =>
      Promise.resolve(
        addresses.map((address) => ({
          address,
          family: address.includes(':') ? (6 as const) : (4 as const),
        })),
      );

  it.each([
    ['http://s3.example.com', ['93.184.216.34']],
    ['https://127.0.0.1', []],
    ['https://169.254.169.254', []],
    ['https://10.0.0.1', []],
    ['https://100.64.0.1', []],
    ['https://[fd00::1]', []],
    ['https://0.0.0.0', []],
    ['https://[::]', []],
    ['https://[::ffff:10.0.0.1]', []],
    ['https://2130706433', []],
    ['https://0177.0.0.1', []],
    ['https://s3.example.com', ['93.184.216.34', '10.0.0.7']],
    ['https://s3.example.com', ['93.184.216.34', '::ffff:169.254.169.254']],
  ])('[US-STO-12][unit][sdk] private endpoints are refused: %s %j', async (endpoint, resolved) => {
    const url = formatStorageUrl({
      kind: 's3',
      bucket: 'acme-data',
      prefix: '',
      endpoint,
      forcePathStyle: true,
    });
    const credential = s3Credential();
    expect(await codeOf(open(url, credential, { resolve: resolveTo(...resolved) }))).toBe(
      'storage_connection_endpoint_forbidden',
    );
  });

  it('[US-STO-12][unit][sdk] the pinned lookup answers only with the checked addresses', async () => {
    const lookup = pinnedLookup([{ address: '93.184.216.34', family: 4 }]);
    const single = await new Promise((resolve) => {
      lookup('anything.example', {}, (_error, address, family) => resolve({ address, family }));
    });
    expect(single).toEqual({ address: '93.184.216.34', family: 4 });
    const all = await new Promise((resolve) => {
      lookup('anything.example', { all: true }, (_error, addresses) => resolve(addresses));
    });
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('connection store S3 connections', () => {
  let server: Server | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  const securityTokens: (string | string[] | undefined)[] = [];
  async function listen(status: number): Promise<number> {
    securityTokens.length = 0;
    server = createServer((request, response) => {
      securityTokens.push(request.headers['x-amz-security-token']);
      response.statusCode = status;
      response.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  const urlFor = (port: number): string =>
    formatStorageUrl({
      kind: 's3',
      bucket: 'acme-data',
      prefix: '',
      endpoint: `http://bucket-host.invalid:${port}`,
      forcePathStyle: true,
    });
  const toLoopback = () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]);

  it('[US-STO-12][unit][sdk] the client connects to the checked address, not a fresh lookup', async () => {
    const port = await listen(200);
    // `.invalid` never resolves in DNS, so this only opens if the socket used the checked address.
    const store = await open(urlFor(port), s3Credential(), { egress: local, resolve: toLoopback });
    await expect(store.write('a.txt', bytes, {})).rejects.toBeInstanceOf(ReadOnlyStoreError);
  });

  it('[US-STO-12][unit][sdk] a temporary credential sends its session token with every request', async () => {
    const port = await listen(200);
    const sessionToken = randomBytes(24).toString('base64');
    const store = await open(
      urlFor(port),
      { ...s3Credential(), sessionToken },
      { egress: local, resolve: toLoopback },
    );
    await store.read('a.txt');
    expect(securityTokens.length).toBeGreaterThan(0);
    expect(new Set(securityTokens)).toEqual(new Set([sessionToken]));
  });

  it('[US-STO-12][unit][sdk] credentials never appear in a refusal, its cause, or the logs', async () => {
    const credential = { ...s3Credential(), sessionToken: randomBytes(24).toString('base64') };
    const secrets = [credential.accessKeyId, credential.secretAccessKey, credential.sessionToken];
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const port = await listen(403);
    const refusals = [
      open(urlFor(port), credential, { egress: local, resolve: toLoopback }),
      open('s3://acme-data?endpoint=https://127.0.0.1', credential),
      open('s3://acme-data', { provider: 'file' }),
      open(`s3://${credential.accessKeyId}:${credential.secretAccessKey}@acme-data`, credential),
    ];
    const errors = await Promise.all(
      refusals.map((refusal) =>
        refusal.then(
          () => undefined,
          (error: unknown) => error,
        ),
      ),
    );
    expect(await codeOf(refusals[0] as Promise<unknown>)).toBe('storage_connection_unreachable');
    for (const error of errors) {
      expect(error).toBeInstanceOf(ConnectionStoreError);
      expect((error as Error).cause).toBeUndefined();
      for (const secret of secrets) {
        expect(String(error)).not.toContain(secret);
        expect((error as Error).stack ?? '').not.toContain(secret);
      }
    }
    const output = JSON.stringify(logged.flatMap((spy) => spy.mock.calls));
    for (const secret of secrets) expect(output).not.toContain(secret);
  });
});

describe('connection store GCS connections', () => {
  // Built at runtime so no key-shaped literal sits in the source for a secret scanner to flag.
  const serviceAccount = () => ({
    client_email: `svc-${randomBytes(4).toString('hex')}@acme.iam.gserviceaccount.com`,
    private_key: randomBytes(24).toString('base64'),
  });

  it('[US-STO-12][unit][sdk] a GCS connection opens with its service-account credentials, and the server store without them is unchanged', async () => {
    const credentials = serviceAccount();
    expect(await gcsStorageOptions({ bucket: 'acme-data', credentials })).toStrictEqual({
      credentials,
    });
    expect(
      await gcsStorageOptions({ bucket: 'acme-data', projectId: 'acme-prod', credentials }),
    ).toStrictEqual({ projectId: 'acme-prod', credentials });
    expect(await gcsStorageOptions({ bucket: 'acme-data', projectId: 'acme-prod' })).toStrictEqual({
      projectId: 'acme-prod',
    });
    expect(await gcsStorageOptions({ bucket: 'acme-data', timeoutMs: 5_000 })).toStrictEqual({
      retryOptions: { totalTimeout: 5 },
    });
    expect(await gcsStorageOptions({ bucket: 'acme-data' })).toStrictEqual({});
  });

  it('[US-STO-12][unit][sdk] a GCS access token becomes an OAuth2 authClient, never credentials', async () => {
    const accessToken = `ya29.${randomUUID()}`;
    const options = await gcsStorageOptions({
      bucket: 'acme-data',
      projectId: 'acme-prod',
      accessToken,
    });
    expect(options).not.toHaveProperty('credentials');
    expect(options.projectId).toBe('acme-prod');
    const { authClient } = options as unknown as { authClient: unknown };
    expect(authClient).toBeInstanceOf(OAuth2Client);
    expect((authClient as OAuth2Client).credentials.access_token).toBe(accessToken);
  });

  it('[US-STO-12][unit][sdk] a GCS access token without a project, or external_account JSON, is refused without echoing it', async () => {
    const accessToken = `ya29.${randomUUID()}`;
    const externalAccount = JSON.stringify({
      type: 'external_account',
      credential_source: { file: `/tmp/${accessToken}` },
    });
    const refusals = [
      open('gcs://acme-data', { provider: 'gcs', accessToken }),
      open('gcs://acme-data?project=acme-prod', {
        provider: 'gcs',
        serviceAccountJson: externalAccount,
      }),
    ];
    for (const refusal of refusals) {
      const failure = await refusal.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ConnectionStoreError);
      expect((failure as ConnectionStoreError).code).toBe('storage_connection_url_invalid');
      expect((failure as Error).cause).toBeUndefined();
      expect(String(failure)).not.toContain(accessToken);
      expect((failure as Error).stack ?? '').not.toContain(accessToken);
    }
  });

  it('[US-STO-12][unit][sdk] a rejected GCS token is unreachable, with no cause and no token in the error', async () => {
    const accessToken = `ya29.${randomUUID()}`;
    // Shaped like the 401 the bucket check ends in: the SDK error keeps its bearer request.
    const sdkError = Object.assign(new Error(`401 for Bearer ${accessToken}`), {
      code: 401,
      config: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    vi.mocked(createGcsObjectStoreFromConfig).mockRejectedValueOnce(
      new GcsBucketUnavailableError('acme-data', 'unreachable', sdkError),
    );

    const failure: unknown = await open('gcs://acme-data?project=acme-prod', {
      provider: 'gcs',
      accessToken,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConnectionStoreError);
    expect((failure as ConnectionStoreError).code).toBe('storage_connection_unreachable');
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain(accessToken);
    expect((failure as Error).stack ?? '').not.toContain(accessToken);
    expect(JSON.stringify(failure)).not.toContain(accessToken);
  });

  it('[US-STO-12][unit][sdk] a stored key whose type is not service_account is refused even with an email and a key', () => {
    const key = { ...serviceAccount(), project_id: 'acme-prod' };
    expect(parseServiceAccount(JSON.stringify({ type: 'service_account', ...key }))).toStrictEqual(
      key,
    );
    for (const type of ['external_account', 'authorized_user']) {
      expect(parseServiceAccount(JSON.stringify({ type, ...key }))).toBeNull();
    }
  });

  it('[US-STO-12][unit][sdk] an unusable GCS credential is refused without echoing it', async () => {
    const secret = randomBytes(24).toString('base64');
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const bad = [
      `{"private_key":"${secret}"`,
      JSON.stringify({ private_key: secret }),
      JSON.stringify([secret]),
      secret,
    ];
    for (const serviceAccountJson of bad) {
      const failure = await open('gcs://acme-data', { provider: 'gcs', serviceAccountJson }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ConnectionStoreError);
      expect((failure as ConnectionStoreError).code).toBe('storage_connection_url_invalid');
      expect((failure as Error).cause).toBeUndefined();
      expect(String(failure)).not.toContain(secret);
      expect((failure as Error).stack ?? '').not.toContain(secret);
    }
    expect(JSON.stringify(logged.flatMap((spy) => spy.mock.calls))).not.toContain(secret);
    vi.restoreAllMocks();
  });
});

describe('connection store Azure connections', () => {
  let server: Server | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  // Built at runtime so no key-shaped literal sits in the source for a secret scanner to flag.
  const accountKey = (): string => randomBytes(32).toString('base64');
  const sasToken = (): string =>
    `sv=2024-11-04&sp=rl&sr=c&sig=${encodeURIComponent(randomBytes(24).toString('base64'))}`;
  const azureUrl = (serviceUrl: string): string =>
    formatStorageUrl({
      kind: 'azblob',
      account: 'acme',
      serviceUrl,
      container: 'files',
      prefix: '',
    });
  const toLoopback = () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]);

  /**
   * Answers a container listing with an empty page, and Get Container Properties with 200, or with
   * 403 to a SAS as Azure and Azurite do for a container SAS. Every other request gets `otherStatus`.
   */
  async function listen(otherStatus: number): Promise<{ port: number; seen: string[] }> {
    const seen: string[] = [];
    server = createServer((request, response) => {
      const url = request.url ?? '';
      seen.push(url);
      if (url.includes('restype=container') && url.includes('comp=list')) {
        response.setHeader('content-type', 'application/xml');
        response.end(
          '<?xml version="1.0" encoding="utf-8"?><EnumerationResults ContainerName="files"><Blobs /><NextMarker /></EnumerationResults>',
        );
        return;
      }
      response.statusCode = url.includes('restype=container')
        ? url.includes('sig=')
          ? 403
          : 200
        : otherStatus;
      response.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, seen };
  }

  it('[US-STO-12][unit][sdk] the server store without a connection credential still uses DefaultAzureCredential', () => {
    expect(azureCredentialFor({})).toBeInstanceOf(DefaultAzureCredential);
    expect(azureCredentialFor({ managedIdentityClientId: ' ' })).toBeInstanceOf(
      DefaultAzureCredential,
    );
    expect(
      azureCredentialFor({ connection: { account: 'acme', accountKey: accountKey() } }),
    ).toBeInstanceOf(StorageSharedKeyCredential);
  });

  it('[US-STO-12][unit][sdk] a serialised Azure connection config carries no account key or SAS token', () => {
    const key = accountKey();
    const token = sasToken();
    const keyed = new AzureAccountKeyConnection('acme', key);
    const config = {
      serviceUrl: 'https://acme.blob.core.windows.net',
      connections: [keyed, new AzureSasTokenConnection('acme', token)],
    };
    for (const printed of [JSON.stringify(config), JSON.stringify({ ...keyed }), inspect(config)]) {
      expect(printed).toContain('acme');
      expect(printed).not.toContain(key);
      expect(printed).not.toContain(token);
    }
    expect(azureCredentialFor({ connection: keyed })).toBeInstanceOf(StorageSharedKeyCredential);
  });

  it('[US-STO-12][unit][sdk] an account-key connection signs URLs with a fresh service SAS', async () => {
    const key = accountKey();
    const shared = new StorageSharedKeyCredential('acme', key);
    const container = new BlobServiceClient(
      'https://acme.blob.core.windows.net',
      shared,
    ).getContainerClient('files');
    const signed = await createAzureSdkBlobContainer(container, undefined, shared).signUrl?.(
      'a.txt',
      { method: 'GET' },
    );
    expect(signed?.url.startsWith('https://acme.blob.core.windows.net/files/a.txt?')).toBe(true);
    expect(signed?.url).toContain('sig=');
    expect(signed?.url).toContain('sp=r');
    expect(signed?.url).not.toContain(encodeURIComponent(key));
    expect(signed?.url).not.toContain(key);
  });

  it('[US-STO-12][unit][sdk] a SAS-token connection cannot sign, so its token is never returned', async () => {
    const token = sasToken();
    const { port, seen } = await listen(404);
    const store = await open(
      azureUrl(`http://blob-host.invalid:${port}`),
      { provider: 'azblob', sasToken: token },
      { writable: true, egress: local, resolve: toLoopback },
    );
    expect(store.capabilities.sign).toBe(false);
    expect('createSignedUrl' in store).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((url) => url.includes(token))).toBe(true);
    // The readiness probe is a list the SAS grants, not Get Container Properties (403 to a SAS).
    expect(seen.some((url) => url.includes('comp=list'))).toBe(true);
  });

  it.each([
    ['http://blob.example.com', ['93.184.216.34']],
    ['https://127.0.0.1', []],
    ['https://169.254.169.254', []],
    ['https://10.0.0.1', []],
    ['https://blob.example.com', ['93.184.216.34', '10.0.0.7']],
  ])(
    '[US-STO-12][unit][sdk] private Azure endpoints are refused: %s %j',
    async (endpoint, resolved) => {
      const credential = { provider: 'azblob', accountKey: accountKey() } as const;
      const resolve = () =>
        Promise.resolve(resolved.map((address) => ({ address, family: 4 as const })));
      expect(await codeOf(open(azureUrl(endpoint), credential, { resolve }))).toBe(
        'storage_connection_endpoint_forbidden',
      );
    },
  );

  it('[US-STO-12][unit][sdk] the Azure client connects to the checked address, not a fresh lookup', async () => {
    const { port } = await listen(200);
    // `.invalid` never resolves in DNS, so this only opens if the socket used the checked address.
    const store = await open(
      azureUrl(`http://blob-host.invalid:${port}`),
      { provider: 'azblob', sasToken: sasToken() },
      { egress: local, resolve: toLoopback },
    );
    await expect(store.write('a.txt', bytes, {})).rejects.toBeInstanceOf(ReadOnlyStoreError);
  });

  it('[US-STO-12][unit][sdk] Azure credentials never appear in a refusal, a failed read, or the logs', async () => {
    const key = accountKey();
    const token = sasToken();
    const secrets = [key, encodeURIComponent(key), token, token.split('sig=')[1] ?? token];
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const { port } = await listen(403);
    const endpoint = `http://blob-host.invalid:${port}`;
    const settle = (attempt: Promise<unknown>): Promise<unknown> =>
      attempt.then(
        () => undefined,
        (error: unknown) => error,
      );
    const errors = [
      await settle(
        open(
          azureUrl('https://127.0.0.1'),
          { provider: 'azblob', sasToken: token },
          { resolve: toLoopback },
        ),
      ),
      await settle(
        open(
          azureUrl(endpoint),
          { provider: 'azblob', accountKey: key },
          { egress: local, resolve: toLoopback },
        ).then((store) => store.head('a.txt')),
      ),
      await settle(
        open(azureUrl(endpoint), { provider: 's3', accessKeyId: token, secretAccessKey: key }),
      ),
      await settle(
        open(
          azureUrl(endpoint),
          { provider: 'azblob', sasToken: token },
          { egress: local, resolve: toLoopback },
        ).then((store) => store.head('a.txt')),
      ),
    ];
    expect(errors.every((error) => error instanceof Error)).toBe(true);
    const chain = (error: unknown): string =>
      error instanceof Error ? `${String(error)}\n${error.stack ?? ''}\n${chain(error.cause)}` : '';
    for (const error of errors) {
      for (const secret of secrets) expect(chain(error)).not.toContain(secret);
    }
    expect((errors[0] as ConnectionStoreError).code).toBe('storage_connection_endpoint_forbidden');
    const output = JSON.stringify(logged.flatMap((spy) => spy.mock.calls));
    for (const secret of secrets) expect(output).not.toContain(secret);
  });
});

const memoryContract = () =>
  Promise.resolve({
    provider: scopedObjectStoreProvider(createInMemoryObjectStore()),
    teardown: () => Promise.resolve(),
  });
defineObjectStoreV2Contract('connection store — memory', memoryContract);

defineObjectStoreV2Contract('connection store — file', async () => {
  const root = await tempRoot();
  const store = await open(
    `file://${root}`,
    { provider: 'file' },
    { writable: true, fileRoots: [root] },
  );
  return {
    provider: scopedObjectStoreProvider(store),
    teardown: () => rm(root, { recursive: true, force: true }),
    // A connected folder has no sidecar: the type comes from the file name.
    contentTypeFromName: true,
    plantRaw: async (key, planted) => {
      const target = path.join(root, key);
      if (key.endsWith('/')) {
        await mkdir(target, { recursive: true });
        return;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, planted);
    },
  };
});

defineObjectStoreV2Contract('connection store — S3 (SeaweedFS)', async () => {
  const endpoint = process.env['TEST_S3_ENDPOINT'];
  if (endpoint === undefined || endpoint.trim() === '') {
    throw new Error('TEST_S3_ENDPOINT is required (the repository test launcher supplies it)');
  }
  const accessKeyId = process.env['TEST_S3_ACCESS_KEY_ID'] ?? 'agent_workspace';
  const secretAccessKey = process.env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'agent_workspace';
  const region = process.env['TEST_S3_REGION'] ?? 'us-east-1';
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const bucket = `aw-connection-${randomUUID()}`;
  await ensureS3Bucket(client, bucket);
  const store = await open(
    formatStorageUrl({ kind: 's3', bucket, prefix: '', endpoint, region, forcePathStyle: true }),
    { provider: 's3', accessKeyId, secretAccessKey },
    { writable: true, egress: local },
  );
  return {
    provider: scopedObjectStoreProvider(store),
    signedUrlsFetchable: true,
    teardown: async () => {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
      const objects = (listed.Contents ?? []).flatMap((entry) =>
        entry.Key === undefined ? [] : [{ Key: entry.Key }],
      );
      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
        );
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    },
  };
});

// Azurite serves a development account over HTTP; it runs only where the launcher supplies it, the
// same registration `azure-blob-store.test.ts` uses. GCS has no leg: the gcs URL grammar names no
// endpoint, and fake-gcs-server fails the v2 paging case.
const azuriteUrl = process.env['TEST_AZURITE_URL']?.trim() ?? '';
if (azuriteUrl !== '') {
  defineObjectStoreV2Contract('connection store — Azure Blob (Azurite, SAS token)', async () => {
    // The development account's key is read from the SDK so no key literal lives here.
    const shared = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true').credential;
    if (!(shared instanceof StorageSharedKeyCredential)) {
      throw new Error('expected the development shared-key credential');
    }
    const containerName = `aw-${randomUUID()}`;
    const container = new BlobServiceClient(azuriteUrl, shared).getContainerClient(containerName);
    await container.create();
    const token = generateBlobSASQueryParameters(
      {
        containerName,
        permissions: ContainerSASPermissions.parse('racwdl'),
        startsOn: new Date(Date.now() - 5 * 60_000),
        expiresOn: new Date(Date.now() + 60 * 60_000),
      },
      shared,
    ).toString();
    const store = await open(
      formatStorageUrl({
        kind: 'azblob',
        account: shared.accountName,
        serviceUrl: azuriteUrl,
        container: containerName,
        prefix: '',
      }),
      { provider: 'azblob', sasToken: token },
      { writable: true, egress: local },
    );
    return {
      provider: scopedObjectStoreProvider(store),
      teardown: async () => {
        await container.delete();
      },
    };
  });
}
