import { randomUUID } from 'node:crypto';

import { DefaultAzureCredential } from '@azure/identity';
import {
  AnonymousCredential,
  BlobServiceClient,
  newPipeline,
  StorageSharedKeyCredential,
  type ContainerClient,
  type RequestPolicyFactory,
} from '@azure/storage-blob';

import { azureProviderCall } from '../azure/safe-provider-error.js';
import {
  addressableObjectName,
  prefixedListPrefix,
  prefixedObjectKey,
  storeKeyPrefix,
} from './key-safety.js';
import {
  scopedObjectStoreProvider,
  type EmulatorObjectStore,
  type ObjectListEntry,
  type ObjectStore,
  type ObjectStoreProvider,
  type SignedUrl,
  type SignedUrlRequest,
  clampListLimit,
  compareListingNames,
  ObjectConflictError,
  validatedWriteKey,
  SignedUrlUnsupportedError,
} from './object-store.js';
import { connectionAgents, type ConnectionTransport } from './connection-transport.js';
import { abortableBody, resolveRange } from './streams.js';
import { createAzureSdkBlobContainer } from './azure-blob-sdk-container.js';
import {
  checkedContainerName,
  parseServiceUrl,
  type AzureBlobContainer,
  type AzureBlobEntry,
  type AzureBlobObjectStoreConfig,
} from './azure-blob-protocol.js';

export { createAzureSdkBlobContainer } from './azure-blob-sdk-container.js';

async function readObject(
  client: AzureBlobContainer,
  prefix: string,
  key: string,
  readOptions: Parameters<ObjectStore['read']>[1],
): ReturnType<ObjectStore['read']> {
  const signal = readOptions?.signal;
  signal?.throwIfAborted();
  const objectKey = prefixedObjectKey(prefix, key);
  // A ranged read checks the size first, so a bad range fails the same way on every backend
  // and Azure is only ever asked for a range inside the blob.
  let range: { readonly start: number; readonly end: number } | null = null;
  if (readOptions?.range !== undefined) {
    const meta = await client.head(objectKey);
    if (meta === null) return null;
    range = resolveRange(readOptions.range, meta.sizeBytes);
  }
  const found = await client.readStream(objectKey, range ?? undefined, signal);
  // The range the GET served, which a concurrent replacement can make differ from the HEAD's.
  return found === null
    ? null
    : {
        ...found,
        body: abortableBody(found.body, signal),
        range: range === null ? null : found.range,
      };
}

function toListEntries(entries: readonly AzureBlobEntry[], prefix: string): ObjectListEntry[] {
  return (
    entries
      .filter((entry) => addressableObjectName(entry.name.slice(prefix.length)) !== null)
      .map((entry): ObjectListEntry =>
        entry.kind === 'folder'
          ? { kind: 'folder', key: entry.name.slice(prefix.length) }
          : { ...entry, key: entry.name.slice(prefix.length) },
      )
      // Azure lists by blob name, so folder `a` (`a/`) comes after file `a.txt`. A page sorted
      // by bare key would put it first and the pages would not concatenate into one order.
      .sort(compareListingNames)
  );
}

function signedUrlOrRefusal(
  sign: NonNullable<AzureBlobContainer['signUrl']>,
  prefix: string,
  key: string,
  request: SignedUrlRequest,
): Promise<SignedUrl> {
  if (request.method === 'PUT' && request.requireBoundContentLength === true) {
    // A SAS has no length field: its holder could upload any size.
    return Promise.reject(
      new SignedUrlUnsupportedError('Azure Blob SAS URLs cannot bind an upload length.'),
    );
  }
  return sign(prefixedObjectKey(prefix, key), request);
}

/** Raw Azure Blob backend. Tenant scoping is added by the provider factory below. */
export function createAzureBlobObjectStore(
  client: AzureBlobContainer,
  keyPrefix?: string,
): ObjectStore {
  const prefix = storeKeyPrefix(keyPrefix);
  const sign = client.signUrl?.bind(client);
  return {
    // A SAS has no length field, so an Azure link cannot bind the upload size: the complete step
    // deletes any file over the limit (the storage design, §04).
    capabilities: {
      sign: sign !== undefined,
      boundLengthSign: false,
      range: true,
      conditionalPut: true,
      fileAndFolderShareKey: true,
    },
    head: (key) => client.head(prefixedObjectKey(prefix, key)),
    read: (key, readOptions) => readObject(client, prefix, key, readOptions),
    async write(key, body, writeOptions) {
      const name = await validatedWriteKey(body, writeOptions, () =>
        prefixedObjectKey(prefix, key),
      );
      const meta = await client.writeStream(
        name,
        abortableBody(body, writeOptions.signal),
        writeOptions,
      );
      if (meta === null) throw new ObjectConflictError();
      return meta;
    },
    async listPage(listPrefix, listOptions) {
      const page = await client.listPage(prefixedListPrefix(prefix, listPrefix), {
        delimiter: listOptions?.recursive !== true,
        limit: clampListLimit(listOptions?.limit),
        ...(listOptions?.cursor === undefined ? {} : { cursor: listOptions.cursor }),
        ...(listOptions?.signal === undefined ? {} : { signal: listOptions.signal }),
      });
      return { cursor: page.cursor, entries: toListEntries(page.entries, prefix) };
    },
    ...(sign === undefined
      ? {}
      : {
          createSignedUrl: (key: string, request: SignedUrlRequest): Promise<SignedUrl> =>
            signedUrlOrRefusal(sign, prefix, key, request),
        }),
    delete(key): Promise<void> {
      return client.delete(prefixedObjectKey(prefix, key));
    },
    copy(sourceKey, destinationKey): Promise<void> {
      return client.copy(
        prefixedObjectKey(prefix, sourceKey),
        prefixedObjectKey(prefix, destinationKey),
      );
    },
  };
}
export function createAzureBlobObjectStoreProvider(
  client: AzureBlobContainer,
  keyPrefix?: string,
): ObjectStoreProvider {
  return scopedObjectStoreProvider(createAzureBlobObjectStore(client, keyPrefix));
}

/**
 * Tests only, through `@agent-workspace/core/storage/backends` (the storage design, §07 "Load
 * test"): a new, empty container on the Azurite at `serviceUrl`, such as
 * `http://127.0.0.1:10000/devstoreaccount1`, so a caller outside this package needs no Azure
 * dependency of its own. Azurite's well-known development account is read from the SDK, so no key
 * literal lives here.
 */
export async function createAzuriteObjectStore(serviceUrl: string): Promise<EmulatorObjectStore> {
  const service = new BlobServiceClient(
    serviceUrl,
    BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true').credential,
  );
  const container = service.getContainerClient(`aw-${randomUUID()}`);
  await container.create();
  return {
    provider: createAzureBlobObjectStoreProvider(createAzureSdkBlobContainer(container, service)),
    teardown: async () => {
      await container.delete();
    },
    plantRaw: async (name, bytes) => {
      await container.getBlockBlobClient(name).uploadData(bytes);
    },
  };
}

/** Without a `connection`, exactly the deployment identity the server's own store has always used. */
export function azureCredentialFor(
  config: Pick<AzureBlobObjectStoreConfig, 'managedIdentityClientId' | 'connection'>,
): DefaultAzureCredential | StorageSharedKeyCredential | AnonymousCredential {
  const connection = config.connection;
  if (connection === undefined) {
    return new DefaultAzureCredential(
      config.managedIdentityClientId === undefined || config.managedIdentityClientId.trim() === ''
        ? {}
        : { managedIdentityClientId: config.managedIdentityClientId.trim() },
    );
  }
  return 'accountKey' in connection
    ? new StorageSharedKeyCredential(connection.account, connection.accountKey)
    : new AnonymousCredential();
}

/**
 * Sends every request with the connection's own agents. Setting `request.agent` also keeps the
 * SDK's proxy policy, which only installs an agent on a request without one, from choosing a route
 * of its own: the connection store has already decided between the pinned sockets and the proxy.
 */
function connectionAgentFactory(transport: ConnectionTransport): RequestPolicyFactory {
  const agents = connectionAgents(transport);
  return {
    create: (next) => ({
      sendRequest(request) {
        request.agent = request.url.startsWith('http:') ? agents.http : agents.https;
        return next.sendRequest(request);
      },
    }),
  };
}

export async function createAzureBlobObjectStoreProviderFromConfig(
  config: AzureBlobObjectStoreConfig,
): Promise<ObjectStoreProvider> {
  return scopedObjectStoreProvider(await createAzureBlobObjectStoreFromConfig(config));
}

type AzureCredential = ReturnType<typeof azureCredentialFor>;

/** The service client: a SAS token on its URL, and the connection's own agents when it has some. */
function serviceClientFor(
  config: AzureBlobObjectStoreConfig,
  credential: AzureCredential,
): BlobServiceClient {
  const connection = config.connection;
  const serviceUrl = parseServiceUrl(config.serviceUrl, connection?.account);
  // A SAS token travels on the service URL; it is never read back out to build a returned URL.
  const url =
    connection !== undefined && 'sasToken' in connection
      ? `${serviceUrl}?${connection.sasToken.replace(/^\?/u, '')}`
      : serviceUrl;
  if (config.transport === undefined) return new BlobServiceClient(url, credential);
  const pipeline = newPipeline(credential);
  pipeline.factories.push(connectionAgentFactory(config.transport));
  return new BlobServiceClient(url, pipeline);
}

async function assertContainerReady(
  client: AzureBlobContainer,
  containerClient: ContainerClient,
  credential: AzureCredential,
): Promise<void> {
  if (credential instanceof AnonymousCredential) {
    // A container SAS cannot authorize Get Container Properties; a one-item list needs only `l`.
    await azureProviderCall('blob', 'container-readiness check', () =>
      containerClient.listBlobsFlat().byPage({ maxPageSize: 1 }).next(),
    );
    return;
  }
  await client.assertReady();
}

/** The same store, unscoped: workspace-agnostic names under `config.keyPrefix`. */
export async function createAzureBlobObjectStoreFromConfig(
  config: AzureBlobObjectStoreConfig,
): Promise<ObjectStore> {
  const container = checkedContainerName(config.container);
  const credential = azureCredentialFor(config);
  const service = serviceClientFor(config, credential);
  const containerClient = service.getContainerClient(container);
  const client =
    credential instanceof StorageSharedKeyCredential
      ? createAzureSdkBlobContainer(containerClient, undefined, credential)
      : createAzureSdkBlobContainer(
          containerClient,
          credential instanceof AnonymousCredential ? undefined : service,
        );
  await assertContainerReady(client, containerClient, credential);
  return createAzureBlobObjectStore(client, config.keyPrefix);
}
