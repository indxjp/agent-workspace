import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

import { DefaultAzureCredential } from '@azure/identity';
import {
  AnonymousCredential,
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  newPipeline,
  SASProtocol,
  StorageSharedKeyCredential,
  type BlobItem,
  type BlobSASSignatureValues,
  type ContainerClient,
  type RequestPolicyFactory,
  type SASQueryParameters,
} from '@azure/storage-blob';

import { azureProviderCall } from '../azure/safe-provider-error.js';
import {
  addressableObjectName,
  prefixedListPrefix,
  prefixedObjectKey,
  storeKeyPrefix,
  toObjectPrefix,
} from './key-safety.js';
import {
  scopedObjectStoreProvider,
  type ByteRange,
  type ObjectContent,
  type ObjectListEntry,
  type ObjectMeta,
  type ObjectStoreProviderV2,
  type ObjectStoreV2,
  type PutObjectInput,
  type SignedUrl,
  type SignedUrlRequest,
  type WriteOptions,
  clampListLimit,
  compareEntryKeys,
  ObjectConflictError,
  validatedWriteKey,
  PRESIGNED_URL_DEFAULT_TTL_SECONDS,
  RangeNotSatisfiableError,
  SignedUrlUnsupportedError,
} from './object-store.js';
import { countedBody, resolveRange, toNodeReadable, toWebStream } from './streams.js';

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
  /** A server-side copy, bytes, content type and metadata; a missing source is a no-op. */
  copy(sourceName: string, destinationName: string): Promise<void>;
  delete(name: string): Promise<void>;
  listHierarchy(prefix: string): Promise<readonly AzureBlobEntry[]>;
  listFlat(prefix: string): Promise<readonly AzureBlobFileEntry[]>;
  head(name: string): Promise<ObjectMeta | null>;
  /**
   * The whole blob's meta, the bytes of `range` (all of them when omitted) and the range actually
   * served. Throws {@link RangeNotSatisfiableError} when the blob no longer holds `range`.
   */
  readStream(
    name: string,
    range: ByteRange | undefined,
  ): Promise<{
    meta: ObjectMeta;
    range: { readonly start: number; readonly end: number } | null;
    body: ReadableStream<Uint8Array>;
  } | null>;
  /** `null` when a precondition failed; the caller turns that into {@link ObjectConflictError}. */
  writeStream(
    name: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options: WriteOptions,
  ): Promise<ObjectMeta | null>;
  listPage(
    prefix: string,
    options: { delimiter: boolean; cursor?: string; limit: number; signal?: AbortSignal },
  ): Promise<{ entries: readonly AzureBlobEntry[]; cursor: string | null }>;
  /** User-delegation SAS URL for one blob; absent when the container cannot sign. No blob I/O. */
  signUrl?(name: string, request: SignedUrlRequest): Promise<SignedUrl>;
}

/** A customer's storage account credential: a shared key, or a SAS token placed on the service URL. */
type AzureBlobConnection = { readonly account: string } & (
  { readonly accountKey: string } | { readonly sasToken: string }
);

/**
 * The connection secret sits in a private field behind a getter, so `JSON.stringify`, `Object.keys`
 * or a spread of a config never carries it, while `'accountKey' in connection` still holds.
 */
export class AzureAccountKeyConnection {
  readonly account: string;
  readonly #accountKey: string;
  constructor(account: string, accountKey: string) {
    this.account = account;
    this.#accountKey = accountKey;
  }
  get accountKey(): string {
    return this.#accountKey;
  }
}

/** The SAS-token counterpart of {@link AzureAccountKeyConnection}. */
export class AzureSasTokenConnection {
  readonly account: string;
  readonly #sasToken: string;
  constructor(account: string, sasToken: string) {
    this.account = account;
    this.#sasToken = sasToken;
  }
  get sasToken(): string {
    return this.#sasToken;
  }
}

export interface AzureBlobObjectStoreConfig {
  readonly serviceUrl: string;
  readonly container: string;
  readonly managedIdentityClientId?: string;
  readonly keyPrefix?: string;
  /** Absent means the deployment's own identity ({@link DefaultAzureCredential}). */
  readonly connection?: AzureBlobConnection;
  /** Resolves every hostname the client dials; a connection store answers only with checked addresses. */
  readonly lookup?: LookupFunction;
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

function azureErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

/**
 * A failed precondition: 412 (`ConditionNotMet`), or `BlobAlreadyExists` for `If-None-Match: *`.
 * `If-Match` on a missing blob may answer `BlobNotFound`; that is the same "not the version you
 * named" and also conflicts. Every other 404 or 409 (a lease, a missing container) is a real failure.
 */
function isWriteConflict(error: unknown, ifMatch: boolean): boolean {
  const code = azureErrorCode(error);
  return (
    azureStatusCode(error) === 412 ||
    code === 'ConditionNotMet' ||
    code === 'BlobAlreadyExists' ||
    (ifMatch && code === 'BlobNotFound')
  );
}

function writeConditions(options: WriteOptions) {
  if (options.ifNoneMatch === '*') return { ifNoneMatch: '*' };
  return options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch };
}

function fileEntry(item: BlobItem): AzureBlobFileEntry {
  return {
    kind: 'file',
    name: item.name,
    sizeBytes: item.properties.contentLength ?? 0,
    contentType: contentType(item.metadata, item.properties.contentType),
    lastModified: item.properties.lastModified,
  };
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

/** Clock skew allowance for a user-delegation key that starts "now". */
const DELEGATION_KEY_BACKDATE_MS = 5 * 60 * 1_000;

const RANGE_REFUSED = Symbol('range refused');
const UPLOAD_BUFFER_BYTES = 8 * 1024 * 1024;
// One block in flight keeps a write's memory near UPLOAD_BUFFER_BYTES whatever the object size.
const UPLOAD_MAX_CONCURRENCY = 1;

type SasMinter = (
  values: BlobSASSignatureValues,
  startsOn: Date,
  expiresOn: Date,
) => Promise<SASQueryParameters>;

/**
 * `service` signs with a user-delegation key, `sharedKey` with the account key; with neither the
 * container cannot sign. A SAS-token connection passes neither: its token is the only credential
 * and must never be appended to a returned URL.
 */
export function createAzureSdkBlobContainer(
  client: ContainerClient,
  service?: BlobServiceClient,
  sharedKey?: StorageSharedKeyCredential,
): AzureBlobContainer {
  const mintSas: SasMinter | undefined =
    sharedKey !== undefined
      ? (values) => Promise.resolve(generateBlobSASQueryParameters(values, sharedKey))
      : service === undefined
        ? undefined
        : async (values, startsOn, expiresOn) =>
            generateBlobSASQueryParameters(
              values,
              await azureProviderCall('blob', 'user delegation key', () =>
                service.getUserDelegationKey(startsOn, expiresOn),
              ),
              service.accountName,
            );
  const headBlob = (name: string): Promise<ObjectMeta | null> =>
    azureProviderCall('blob', 'head', async () => {
      try {
        const response = await client.getBlockBlobClient(name).getProperties();
        return {
          sizeBytes: response.contentLength ?? 0,
          contentType: contentType(response.metadata, response.contentType),
          etag: response.etag ?? '',
          lastModified: response.lastModified ?? new Date(0),
        };
      } catch (error) {
        if (azureStatusCode(error) === 404) return null;
        throw error;
      }
    });
  return {
    ...(mintSas === undefined
      ? {}
      : {
          // ponytail: one delegation-key call per mint; cache the key for its validity window if
          // mint latency matters.
          async signUrl(name: string, request: SignedUrlRequest): Promise<SignedUrl> {
            const now = request.now ?? new Date();
            const startsOn = new Date(now.getTime() - DELEGATION_KEY_BACKDATE_MS);
            const ttl = request.expiresInSeconds ?? PRESIGNED_URL_DEFAULT_TTL_SECONDS;
            const expiresOn = new Date(now.getTime() + ttl * 1_000);
            const writes = request.method === 'PUT';
            const hasContentType =
              writes && request.contentType !== undefined && request.contentType !== null;
            const values = {
              containerName: client.containerName,
              blobName: name,
              permissions: BlobSASPermissions.parse(writes ? 'cw' : 'r'),
              startsOn,
              expiresOn,
              protocol: SASProtocol.Https,
              ...(request.responseContentType === undefined
                ? {}
                : { contentType: request.responseContentType }),
              ...(request.responseDisposition === undefined
                ? {}
                : { contentDisposition: request.responseDisposition }),
            };
            const sas = (await mintSas(values, startsOn, expiresOn)).toString();
            return {
              url: `${client.getBlockBlobClient(name).url}?${sas}`,
              headers: writes
                ? {
                    'x-ms-blob-type': 'BlockBlob',
                    ...(hasContentType
                      ? {
                          'x-ms-blob-content-type': request.contentType ?? '',
                          [`x-ms-meta-${CONTENT_TYPE_KNOWN_METADATA}`]: 'true',
                        }
                      : {}),
                  }
                : {},
            };
          },
        }),
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
    async copy(sourceName, destinationName) {
      await azureProviderCall('blob', 'copy', async () => {
        try {
          // Same account, so the destination's own credential authorizes reading the source.
          const poller = await client
            .getBlockBlobClient(destinationName)
            .beginCopyFromURL(client.getBlockBlobClient(sourceName).url);
          await poller.pollUntilDone();
        } catch (error) {
          if (azureStatusCode(error) !== 404) throw error;
        }
      });
    },
    async delete(name) {
      await azureProviderCall('blob', 'delete', () =>
        client.getBlockBlobClient(name).deleteIfExists(),
      );
    },
    head: headBlob,
    async readStream(name, range) {
      const found = await azureProviderCall('blob', 'read', async () => {
        try {
          const response = await client
            .getBlockBlobClient(name)
            .download(
              range?.start ?? 0,
              range?.end === undefined ? undefined : range.end - range.start + 1,
            );
          const source = response.readableStreamBody;
          if (!(source instanceof Readable)) {
            throw new Error('Azure Blob returned no readable response body.');
          }
          // `Content-Range: bytes 2-5/10` carries both the served range and the whole size.
          const served = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.contentRange ?? '');
          if (range !== undefined && served === null) {
            source.destroy();
            throw new Error('Azure Blob ignored the requested byte range.');
          }
          return {
            meta: {
              sizeBytes: served === null ? (response.contentLength ?? 0) : Number(served[3]),
              contentType: contentType(response.metadata, response.contentType),
              etag: response.etag ?? '',
              lastModified: response.lastModified ?? new Date(0),
            },
            range: served === null ? null : { start: Number(served[1]), end: Number(served[2]) },
            body: toWebStream(source),
          };
        } catch (error) {
          const status = azureStatusCode(error);
          if (status === 404) return null;
          // Returned, not thrown: `azureProviderCall` rewraps whatever is thrown inside it.
          if (status === 416) return RANGE_REFUSED;
          throw error;
        }
      });
      // The blob shrank between the caller's size check and the read.
      if (found === RANGE_REFUSED) throw new RangeNotSatisfiableError();
      return found;
    },
    async writeStream(name, body, options) {
      const hasContentType = options.contentType !== undefined && options.contentType !== null;
      const counted = countedBody(body);
      const source = toNodeReadable(counted.body);
      let uploaded: { readonly etag?: string; readonly lastModified?: Date } | null;
      try {
        uploaded = await azureProviderCall('blob', 'write', async () => {
          try {
            return await client
              .getBlockBlobClient(name)
              .uploadStream(source, UPLOAD_BUFFER_BYTES, UPLOAD_MAX_CONCURRENCY, {
                conditions: writeConditions(options),
                ...(hasContentType
                  ? {
                      blobHTTPHeaders: { blobContentType: options.contentType },
                      metadata: { [CONTENT_TYPE_KNOWN_METADATA]: 'true' },
                    }
                  : {}),
              });
          } catch (error) {
            if (isWriteConflict(error, options.ifMatch !== undefined)) return null;
            throw error;
          }
        });
      } catch (error) {
        // The caller's own body failed: report that, not the provider error it caused.
        throw source.errored ?? error;
      } finally {
        source.destroy(); // cancels the source stream if it was not read to the end
      }
      if (uploaded === null) return null;
      // The upload's own response, so the etag is this write's, not a later writer's.
      return {
        sizeBytes: counted.sizeBytes(),
        contentType: options.contentType ?? null,
        etag: uploaded.etag ?? '',
        lastModified: uploaded.lastModified ?? new Date(0),
      };
    },
    async listPage(requestedPrefix, options) {
      return azureProviderCall('blob', 'list page', async () => {
        const settings = {
          maxPageSize: options.limit,
          ...(options.cursor === undefined ? {} : { continuationToken: options.cursor }),
        };
        const listing = {
          prefix: requestedPrefix,
          includeMetadata: true,
          ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
        };
        let folders: readonly { name: string }[] = [];
        let items: readonly BlobItem[] = [];
        let next: string | undefined;
        // One page only: the loop exists because `byPage()` is an async iterator.
        if (options.delimiter) {
          for await (const page of client.listBlobsByHierarchy('/', listing).byPage(settings)) {
            folders = page.segment.blobPrefixes ?? [];
            items = page.segment.blobItems;
            next = page.continuationToken;
            break;
          }
        } else {
          for await (const page of client.listBlobsFlat(listing).byPage(settings)) {
            items = page.segment.blobItems;
            next = page.continuationToken;
            break;
          }
        }
        const entries: AzureBlobEntry[] = folders.map((folder) => ({
          kind: 'folder',
          name: folder.name.replace(/\/$/u, ''),
        }));
        for (const item of items) {
          if (item.name !== requestedPrefix) entries.push(fileEntry(item));
        }
        return { entries, cursor: next === undefined || next === '' ? null : next };
      });
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

function byListingName(entry: ObjectListEntry): ObjectListEntry {
  return entry.kind === 'folder' ? { ...entry, key: `${entry.key}/` } : entry;
}

/** Raw Azure Blob backend. Tenant scoping is added by the provider factory below. */
export function createAzureBlobObjectStore(
  client: AzureBlobContainer,
  keyPrefix?: string,
): ObjectStoreV2 {
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
    async read(key, readOptions) {
      const objectKey = prefixedObjectKey(prefix, key);
      // A ranged read checks the size first, so a bad range fails the same way on every backend
      // and Azure is only ever asked for a range inside the blob.
      let range: { readonly start: number; readonly end: number } | null = null;
      if (readOptions?.range !== undefined) {
        const meta = await client.head(objectKey);
        if (meta === null) return null;
        range = resolveRange(readOptions.range, meta.sizeBytes);
      }
      const found = await client.readStream(objectKey, range ?? undefined);
      // The range the GET served, which a concurrent replacement can make differ from the HEAD's.
      return found === null ? null : { ...found, range: range === null ? null : found.range };
    },
    async write(key, body, writeOptions) {
      const name = await validatedWriteKey(body, writeOptions, () =>
        prefixedObjectKey(prefix, key),
      );
      const meta = await client.writeStream(name, body, writeOptions);
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
      return {
        cursor: page.cursor,
        entries: page.entries
          .filter((entry) => addressableObjectName(entry.name.slice(prefix.length)) !== null)
          .map((entry): ObjectListEntry =>
            entry.kind === 'folder'
              ? { kind: 'folder', key: entry.name.slice(prefix.length) }
              : { ...entry, key: entry.name.slice(prefix.length) },
          )
          // Azure lists by blob name, so folder `a` (`a/`) comes after file `a.txt`. A page sorted
          // by bare key would put it first and the pages would not concatenate into one order.
          .sort((left, right) => compareEntryKeys(byListingName(left), byListingName(right))),
      };
    },
    ...(sign === undefined
      ? {}
      : {
          createSignedUrl: (key: string, request: SignedUrlRequest): Promise<SignedUrl> => {
            if (request.method === 'PUT' && request.requireBoundContentLength === true) {
              // A SAS has no length field: its holder could upload any size.
              return Promise.reject(
                new SignedUrlUnsupportedError('Azure Blob SAS URLs cannot bind an upload length.'),
              );
            }
            return sign(prefixedObjectKey(prefix, key), request);
          },
        }),
    put(key, input): Promise<void> {
      return client.put(prefixedObjectKey(prefix, key), input);
    },
    get(key): Promise<ObjectContent | null> {
      return client.get(prefixedObjectKey(prefix, key));
    },
    delete(key): Promise<void> {
      return client.delete(prefixedObjectKey(prefix, key));
    },
    async list(key): Promise<readonly ObjectListEntry[]> {
      const entries = await client.listHierarchy(prefixedListPrefix(prefix, key));
      return entries
        .filter((entry) => addressableObjectName(entry.name.slice(prefix.length)) !== null)
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
          if (addressableObjectName(relative) === null) return false;
          return safe === '' || relative === safe || relative.startsWith(`${safe}/`);
        })
        .map((entry) => ({ ...entry, key: entry.name.slice(prefix.length) }))
        .sort(compareEntryKeys);
    },
    copyObject(sourceKey, destinationKey): Promise<void> {
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
): ObjectStoreProviderV2 {
  return scopedObjectStoreProvider(createAzureBlobObjectStore(client, keyPrefix));
}

/**
 * The server's own store takes an HTTPS account URL and nothing else (ADR-0060). A connection has
 * already passed the egress check, which refuses `http:` except to loopback outside production, so
 * it may also name an emulator's path-style `http://host:port/<account>` URL.
 */
function parseServiceUrl(raw: string, connectionAccount?: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Azure Blob storage requires a parseable HTTPS service URL.');
  }
  const path = url.pathname.replace(/\/$/u, '');
  if (
    (url.protocol !== 'https:' && !(connectionAccount !== undefined && url.protocol === 'http:')) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (path !== '' && path !== (connectionAccount === undefined ? '' : `/${connectionAccount}`))
  ) {
    throw new Error(
      'Azure Blob storage requires an HTTPS account service URL without credentials, a SAS query, a path or a fragment (ADR-0060).',
    );
  }
  return url.toString().replace(/\/$/u, '');
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

/** Sends every request over a socket opened with `lookup`, so the client never resolves a name itself. */
function pinnedAgentFactory(lookup: LookupFunction): RequestPolicyFactory {
  const httpAgent = new http.Agent({ keepAlive: true, lookup });
  const httpsAgent = new https.Agent({ keepAlive: true, lookup });
  return {
    create: (next) => ({
      sendRequest(request) {
        request.agent = request.url.startsWith('http:') ? httpAgent : httpsAgent;
        return next.sendRequest(request);
      },
    }),
  };
}

export async function createAzureBlobObjectStoreProviderFromConfig(
  config: AzureBlobObjectStoreConfig,
): Promise<ObjectStoreProviderV2> {
  return scopedObjectStoreProvider(await createAzureBlobObjectStoreFromConfig(config));
}

/** The same store, unscoped: workspace-agnostic names under `config.keyPrefix`. */
export async function createAzureBlobObjectStoreFromConfig(
  config: AzureBlobObjectStoreConfig,
): Promise<ObjectStoreV2> {
  const container = config.container.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(container) || container.includes('--')) {
    throw new Error(
      'Azure Blob container names must be 3-63 lowercase letters, digits or hyphens.',
    );
  }
  const connection = config.connection;
  const credential = azureCredentialFor(config);
  const serviceUrl = parseServiceUrl(config.serviceUrl, connection?.account);
  // A SAS token travels on the service URL; it is never read back out to build a returned URL.
  const url =
    connection !== undefined && 'sasToken' in connection
      ? `${serviceUrl}?${connection.sasToken.replace(/^\?/u, '')}`
      : serviceUrl;
  let service: BlobServiceClient;
  if (config.lookup === undefined) {
    service = new BlobServiceClient(url, credential);
  } else {
    const pipeline = newPipeline(credential);
    pipeline.factories.push(pinnedAgentFactory(config.lookup));
    service = new BlobServiceClient(url, pipeline);
  }
  const containerClient = service.getContainerClient(container);
  const client =
    credential instanceof StorageSharedKeyCredential
      ? createAzureSdkBlobContainer(containerClient, undefined, credential)
      : createAzureSdkBlobContainer(
          containerClient,
          credential instanceof AnonymousCredential ? undefined : service,
        );
  if (credential instanceof AnonymousCredential) {
    // A container SAS cannot authorize Get Container Properties; a one-item list needs only `l`.
    await azureProviderCall('blob', 'container-readiness check', () =>
      containerClient.listBlobsFlat().byPage({ maxPageSize: 1 }).next(),
    );
  } else {
    await client.assertReady();
  }
  return createAzureBlobObjectStore(client, config.keyPrefix);
}
