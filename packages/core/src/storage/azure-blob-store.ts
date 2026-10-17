import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';

import { azureProviderCall } from '../azure/safe-provider-error.js';
import { toObjectKey, toObjectPrefix } from './key-safety.js';
import {
  scopedObjectStoreProvider,
  type ObjectContent,
  type ObjectListEntry,
  type ObjectStore,
  type ObjectStoreProvider,
  type PutObjectInput,
  compareEntryKeys,
} from './object-store.js';

const CONTENT_TYPE_KNOWN_METADATA = 'aw_content_type_known';

export interface AzureBlobFileEntry {
  readonly kind: 'file';
  readonly name: string;
  readonly sizeBytes: number;
  readonly contentType: string | null;
  readonly lastModified: Date;
}

export interface AzureBlobFolderEntry {
  readonly kind: 'folder';
  readonly name: string;
}

export type AzureBlobEntry = AzureBlobFileEntry | AzureBlobFolderEntry;

/** Narrow external-service port so ordinary CI can exercise the backend without Azure. */
export interface AzureBlobContainer {
  assertReady(): Promise<void>;
  put(name: string, input: PutObjectInput): Promise<void>;
  get(name: string): Promise<ObjectContent | null>;
  delete(name: string): Promise<void>;
  listHierarchy(prefix: string): Promise<readonly AzureBlobEntry[]>;
  listFlat(prefix: string): Promise<readonly AzureBlobFileEntry[]>;
}

export interface AzureBlobObjectStoreConfig {
  readonly serviceUrl: string;
  readonly container: string;
  readonly managedIdentityClientId?: string;
  readonly keyPrefix?: string;
}

function prefixFor(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return '';
  return `${toObjectPrefix(value.replace(/\/+$/u, ''))}/`;
}

function objectName(prefix: string, key: string): string {
  return `${prefix}${toObjectKey(key)}`;
}

function hierarchyPrefix(prefix: string, key: string): string {
  const safe = toObjectPrefix(key);
  return safe === '' ? prefix : `${prefix}${safe}/`;
}

function contentType(
  metadata: Readonly<Record<string, string>> | undefined,
  value: string | undefined,
) {
  return metadata?.[CONTENT_TYPE_KNOWN_METADATA] === 'true' ? (value ?? null) : null;
}

function azureStatusCode(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined;
}

function readDownloadBody(stream: NodeJS.ReadableStream | undefined): Promise<Buffer> {
  if (stream === undefined) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: unknown) => {
      if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
        return;
      }
      reject(new Error('Azure Blob returned an unsupported response-body chunk.'));
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export function createAzureSdkBlobContainer(client: ContainerClient): AzureBlobContainer {
  return {
    async assertReady() {
      await azureProviderCall('blob', 'container-readiness check', () => client.getProperties());
    },
    async put(name, input) {
      const hasContentType = input.contentType !== undefined && input.contentType !== null;
      await azureProviderCall('blob', 'put', () =>
        client.getBlockBlobClient(name).uploadData(input.body, {
          ...(hasContentType ? { blobHTTPHeaders: { blobContentType: input.contentType } } : {}),
          ...(hasContentType ? { metadata: { [CONTENT_TYPE_KNOWN_METADATA]: 'true' } } : {}),
        }),
      );
    },
    async get(name) {
      return azureProviderCall('blob', 'get', async () => {
        const blob = client.getBlockBlobClient(name);
        try {
          const response = await blob.download();
          const body = await readDownloadBody(response.readableStreamBody);
          return {
            body,
            contentType: contentType(response.metadata, response.contentType),
            sizeBytes: response.contentLength ?? body.byteLength,
            lastModified: response.lastModified ?? new Date(0),
          };
        } catch (error) {
          if (azureStatusCode(error) === 404) return null;
          throw error;
        }
      });
    },
    async delete(name) {
      await azureProviderCall('blob', 'delete', () =>
        client.getBlockBlobClient(name).deleteIfExists(),
      );
    },
    async listHierarchy(requestedPrefix) {
      return azureProviderCall('blob', 'hierarchical list', async () => {
        const entries: AzureBlobEntry[] = [];
        for await (const entry of client.listBlobsByHierarchy('/', {
          prefix: requestedPrefix,
          includeMetadata: true,
        })) {
          if (entry.kind === 'prefix') {
            entries.push({ kind: 'folder', name: entry.name.replace(/\/$/u, '') });
            continue;
          }
          if (entry.name === requestedPrefix) continue;
          entries.push({
            kind: 'file',
            name: entry.name,
            sizeBytes: entry.properties.contentLength ?? 0,
            contentType: contentType(entry.metadata, entry.properties.contentType),
            lastModified: entry.properties.lastModified ?? new Date(0),
          });
        }
        return entries;
      });
    },
    async listFlat(requestedPrefix) {
      return azureProviderCall('blob', 'flat list', async () => {
        const entries: AzureBlobFileEntry[] = [];
        for await (const entry of client.listBlobsFlat({
          prefix: requestedPrefix,
          includeMetadata: true,
        })) {
          entries.push({
            kind: 'file',
            name: entry.name,
            sizeBytes: entry.properties.contentLength ?? 0,
            contentType: contentType(entry.metadata, entry.properties.contentType),
            lastModified: entry.properties.lastModified ?? new Date(0),
          });
        }
        return entries;
      });
    },
  };
}

/** Raw Azure Blob backend. Tenant scoping is added by the provider factory below. */
export function createAzureBlobObjectStore(
  client: AzureBlobContainer,
  keyPrefix?: string,
): ObjectStore {
  const prefix = prefixFor(keyPrefix);
  return {
    put(key, input): Promise<void> {
      return client.put(objectName(prefix, key), input);
    },
    get(key): Promise<ObjectContent | null> {
      return client.get(objectName(prefix, key));
    },
    delete(key): Promise<void> {
      return client.delete(objectName(prefix, key));
    },
    async list(key): Promise<readonly ObjectListEntry[]> {
      const entries = await client.listHierarchy(hierarchyPrefix(prefix, key));
      return entries
        .map((entry): ObjectListEntry =>
          entry.kind === 'folder'
            ? { kind: 'folder', key: entry.name.slice(prefix.length) }
            : { ...entry, key: entry.name.slice(prefix.length) },
        )
        .sort(compareEntryKeys);
    },
    async listPrefix(key): Promise<readonly ObjectListEntry[]> {
      const safe = toObjectPrefix(key);
      const requestedPrefix = safe === '' ? prefix : `${prefix}${safe}`;
      const entries = await client.listFlat(requestedPrefix);
      return entries
        .filter((entry) => {
          const relative = entry.name.slice(prefix.length);
          return safe === '' || relative === safe || relative.startsWith(`${safe}/`);
        })
        .map((entry) => ({ ...entry, key: entry.name.slice(prefix.length) }))
        .sort(compareEntryKeys);
    },
    async copyObject(sourceKey, destinationKey): Promise<void> {
      const source = await client.get(objectName(prefix, sourceKey));
      if (source === null) return;
      await client.put(objectName(prefix, destinationKey), {
        body: source.body,
        contentType: source.contentType,
      });
    },
  };
}

export function createAzureBlobObjectStoreProvider(
  client: AzureBlobContainer,
  keyPrefix?: string,
): ObjectStoreProvider {
  return scopedObjectStoreProvider(createAzureBlobObjectStore(client, keyPrefix));
}

function parseServiceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Azure Blob storage requires a parseable HTTPS service URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error(
      'Azure Blob storage requires an HTTPS account service URL without credentials, a SAS query, a path or a fragment (ADR-0060).',
    );
  }
  return url.toString().replace(/\/$/u, '');
}

export async function createAzureBlobObjectStoreProviderFromConfig(
  config: AzureBlobObjectStoreConfig,
): Promise<ObjectStoreProvider> {
  const container = config.container.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(container) || container.includes('--')) {
    throw new Error(
      'Azure Blob container names must be 3-63 lowercase letters, digits or hyphens.',
    );
  }
  const credential = new DefaultAzureCredential(
    config.managedIdentityClientId === undefined || config.managedIdentityClientId.trim() === ''
      ? {}
      : { managedIdentityClientId: config.managedIdentityClientId.trim() },
  );
  const containerClient = new BlobServiceClient(
    parseServiceUrl(config.serviceUrl),
    credential,
  ).getContainerClient(container);
  const client = createAzureSdkBlobContainer(containerClient);
  await client.assertReady();
  return createAzureBlobObjectStoreProvider(client, config.keyPrefix);
}
