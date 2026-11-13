// @story US-STO-12
import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobServiceClient,
  ContainerSASPermissions,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { formatStorageUrl } from '@indx-workspace/contracts/storage-url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionStoreError, ReadOnlyStoreError } from './connection-store.js';
import { bytes, codeOf, local, open } from './connection-store.fixture.test-support.js';
import { AzureAccountKeyConnection, AzureSasTokenConnection } from './azure-blob-protocol.js';
import { azureCredentialFor, createAzureSdkBlobContainer } from './azure-blob-store.js';
import { defineObjectStoreContract } from './contract.js';
import { scopedObjectStoreProvider } from './object-store.js';

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

// Azurite serves a development account over HTTP; it runs only where the launcher supplies it, the
// same registration `azure-blob-store.test.ts` uses. GCS has no leg: the gcs URL grammar names no
// endpoint, and fake-gcs-server fails the v2 paging case.
const azuriteUrl = process.env['TEST_AZURITE_URL']?.trim() ?? '';
if (azuriteUrl !== '') {
  defineObjectStoreContract('connection store — Azure Blob (Azurite, SAS token)', async () => {
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
