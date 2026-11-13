/**
 * The adapter from the official `@azure/storage-blob` container to the small protocol in
 * `azure-blob-protocol.ts`: one function per operation, each calling the SDK inside
 * `azureProviderCall` so a provider failure reaches a caller only as a safe error.
 */
import { Readable } from 'node:stream';

import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
  type BlobDownloadResponseParsed,
  type BlobItem,
  type BlobSASSignatureValues,
  type ContainerClient,
  type SASQueryParameters,
} from '@azure/storage-blob';

import { azureProviderCall } from '../azure/safe-provider-error.js';
import {
  PRESIGNED_URL_DEFAULT_TTL_SECONDS,
  RangeNotSatisfiableError,
  type ByteRange,
  type ObjectMeta,
  type SignedUrl,
  type SignedUrlRequest,
  type WriteOptions,
} from './object-store.js';
import { countedBody, servedRange, toNodeReadable, toWebStream } from './streams.js';
import {
  azureStatusCode,
  isBlobMissing,
  contentType,
  CONTENT_TYPE_KNOWN_METADATA,
  DELEGATION_KEY_BACKDATE_MS,
  delegationKeyWindow,
  isWriteConflict,
  signedPutHeaders,
  writeConditions,
  type AzureBlobContainer,
  type AzureBlobDownload,
  type AzureBlobEntry,
  type AzureBlobFileEntry,
  type AzureBlobListOptions,
} from './azure-blob-protocol.js';

function fileEntry(item: BlobItem): AzureBlobFileEntry {
  return {
    kind: 'file',
    name: item.name,
    sizeBytes: item.properties.contentLength ?? 0,
    contentType: contentType(item.metadata, item.properties.contentType),
    lastModified: item.properties.lastModified,
  };
}

const RANGE_REFUSED = Symbol('range refused');
const UPLOAD_BUFFER_BYTES = 8 * 1024 * 1024;
// One block in flight keeps a write's memory near UPLOAD_BUFFER_BYTES whatever the object size.
const UPLOAD_MAX_CONCURRENCY = 1;

type SasMinter = (
  values: BlobSASSignatureValues,
  startsOn: Date,
  expiresOn: Date,
) => Promise<SASQueryParameters>;

/** Signs with the account key, else with a user-delegation key from `service`, else not at all. */
function sasMinterFor(
  service: BlobServiceClient | undefined,
  sharedKey: StorageSharedKeyCredential | undefined,
): SasMinter | undefined {
  if (sharedKey !== undefined) {
    return (values) => Promise.resolve(generateBlobSASQueryParameters(values, sharedKey));
  }
  if (service === undefined) return undefined;
  return async (values, startsOn, expiresOn) => {
    const key = delegationKeyWindow(startsOn, expiresOn, Date.now());
    return generateBlobSASQueryParameters(
      values,
      await azureProviderCall('blob', 'user delegation key', () =>
        service.getUserDelegationKey(key.startsOn, key.expiresOn),
      ),
      service.accountName,
    );
  };
}

function sasValuesFor(
  client: ContainerClient,
  name: string,
  request: SignedUrlRequest,
  window: { readonly startsOn: Date; readonly expiresOn: Date },
): BlobSASSignatureValues {
  return {
    containerName: client.containerName,
    blobName: name,
    permissions: BlobSASPermissions.parse(request.method === 'PUT' ? 'cw' : 'r'),
    startsOn: window.startsOn,
    expiresOn: window.expiresOn,
    protocol: SASProtocol.Https,
    ...(request.responseContentType === undefined
      ? {}
      : { contentType: request.responseContentType }),
    ...(request.responseDisposition === undefined
      ? {}
      : { contentDisposition: request.responseDisposition }),
  };
}

// ponytail: one delegation-key call per mint; cache the key for its validity window if
// mint latency matters.
async function signBlobUrl(
  client: ContainerClient,
  mintSas: SasMinter,
  name: string,
  request: SignedUrlRequest,
): Promise<SignedUrl> {
  const now = request.now ?? new Date();
  const ttl = request.expiresInSeconds ?? PRESIGNED_URL_DEFAULT_TTL_SECONDS;
  const window = {
    startsOn: new Date(now.getTime() - DELEGATION_KEY_BACKDATE_MS),
    expiresOn: new Date(now.getTime() + ttl * 1_000),
  };
  const values = sasValuesFor(client, name, request, window);
  const sas = (await mintSas(values, window.startsOn, window.expiresOn)).toString();
  return {
    url: `${client.getBlockBlobClient(name).url}?${sas}`,
    headers: signedPutHeaders(request),
  };
}

function headBlob(client: ContainerClient, name: string): Promise<ObjectMeta | null> {
  return azureProviderCall('blob', 'head', async () => {
    try {
      const response = await client.getBlockBlobClient(name).getProperties();
      return {
        sizeBytes: response.contentLength ?? 0,
        contentType: contentType(response.metadata, response.contentType),
        etag: response.etag ?? '',
        lastModified: response.lastModified ?? new Date(0),
      };
    } catch (error) {
      if (isBlobMissing(error)) return null;
      throw error;
    }
  });
}

function downloadResult(
  response: BlobDownloadResponseParsed,
  range: ByteRange | undefined,
): AzureBlobDownload {
  const source = response.readableStreamBody;
  if (!(source instanceof Readable)) {
    throw new Error('Azure Blob returned no readable response body.');
  }
  // `Content-Range: bytes 2-5/10` carries both the served range and the whole size.
  const served = servedRange(response.contentRange);
  if (range !== undefined && served === null) {
    source.destroy();
    throw new Error('Azure Blob ignored the requested byte range.');
  }
  return {
    meta: {
      sizeBytes: served === null ? (response.contentLength ?? 0) : served.size,
      contentType: contentType(response.metadata, response.contentType),
      etag: response.etag ?? '',
      lastModified: response.lastModified ?? new Date(0),
    },
    range: served === null ? null : { start: served.start, end: served.end },
    body: toWebStream(source),
  };
}

async function readBlob(
  client: ContainerClient,
  name: string,
  range: ByteRange | undefined,
  signal: AbortSignal | undefined,
): Promise<AzureBlobDownload | null> {
  const found = await azureProviderCall('blob', 'read', async () => {
    try {
      const response = await client
        .getBlockBlobClient(name)
        .download(
          range?.start ?? 0,
          range?.end === undefined ? undefined : range.end - range.start + 1,
          signal === undefined ? {} : { abortSignal: signal },
        );
      return downloadResult(response, range);
    } catch (error) {
      if (isBlobMissing(error)) return null;
      const status = azureStatusCode(error);
      // Returned, not thrown: `azureProviderCall` rewraps whatever is thrown inside it.
      if (status === 416) return RANGE_REFUSED;
      throw error;
    }
  });
  // The blob shrank between the caller's size check and the read.
  if (found === RANGE_REFUSED) throw new RangeNotSatisfiableError();
  return found;
}

function uploadOptions(options: WriteOptions) {
  const hasContentType = options.contentType !== undefined && options.contentType !== null;
  return {
    conditions: writeConditions(options),
    ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    ...(hasContentType
      ? {
          blobHTTPHeaders: { blobContentType: options.contentType },
          metadata: { [CONTENT_TYPE_KNOWN_METADATA]: 'true' },
        }
      : {}),
  };
}

async function writeBlob(
  client: ContainerClient,
  name: string,
  body: ReadableStream<Uint8Array> | Uint8Array,
  options: WriteOptions,
): Promise<ObjectMeta | null> {
  const counted = countedBody(body);
  const source = toNodeReadable(counted.body);
  let uploaded: { readonly etag?: string; readonly lastModified?: Date } | null;
  try {
    uploaded = await azureProviderCall('blob', 'write', async () => {
      try {
        return await client
          .getBlockBlobClient(name)
          .uploadStream(
            source,
            UPLOAD_BUFFER_BYTES,
            UPLOAD_MAX_CONCURRENCY,
            uploadOptions(options),
          );
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
}

/** One page only: the loop exists because `byPage()` is an async iterator. */
async function firstPage<Page>(pages: AsyncIterable<Page>): Promise<Page | undefined> {
  for await (const page of pages) return page;
  return undefined;
}

async function firstListing(
  client: ContainerClient,
  requestedPrefix: string,
  options: AzureBlobListOptions,
): Promise<{
  folders: readonly { name: string }[];
  items: readonly BlobItem[];
  next: string | undefined;
}> {
  const settings = {
    maxPageSize: options.limit,
    ...(options.cursor === undefined ? {} : { continuationToken: options.cursor }),
  };
  const listing = {
    prefix: requestedPrefix,
    includeMetadata: true,
    ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
  };
  if (options.delimiter) {
    const page = await firstPage(client.listBlobsByHierarchy('/', listing).byPage(settings));
    return {
      folders: page?.segment.blobPrefixes ?? [],
      items: page?.segment.blobItems ?? [],
      next: page?.continuationToken,
    };
  }
  const page = await firstPage(client.listBlobsFlat(listing).byPage(settings));
  return { folders: [], items: page?.segment.blobItems ?? [], next: page?.continuationToken };
}

function listBlobPage(
  client: ContainerClient,
  requestedPrefix: string,
  options: AzureBlobListOptions,
): Promise<{ entries: readonly AzureBlobEntry[]; cursor: string | null }> {
  return azureProviderCall('blob', 'list page', async () => {
    const { folders, items, next } = await firstListing(client, requestedPrefix, options);
    const entries: AzureBlobEntry[] = folders.map((folder) => ({
      kind: 'folder',
      name: folder.name.replace(/\/$/u, ''),
    }));
    for (const item of items) {
      if (item.name !== requestedPrefix) entries.push(fileEntry(item));
    }
    return { entries, cursor: next === undefined || next === '' ? null : next };
  });
}

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
  const mintSas = sasMinterFor(service, sharedKey);
  return {
    ...(mintSas === undefined
      ? {}
      : {
          signUrl: (name: string, request: SignedUrlRequest) =>
            signBlobUrl(client, mintSas, name, request),
        }),
    async assertReady() {
      await azureProviderCall('blob', 'container-readiness check', () => client.getProperties());
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
          if (!isBlobMissing(error)) throw error;
        }
      });
    },
    async delete(name) {
      await azureProviderCall('blob', 'delete', () =>
        client.getBlockBlobClient(name).deleteIfExists(),
      );
    },
    head: (name) => headBlob(client, name),
    readStream: (name, range, signal) => readBlob(client, name, range, signal),
    writeStream: (name, body, options) => writeBlob(client, name, body, options),
    listPage: (requestedPrefix, options) => listBlobPage(client, requestedPrefix, options),
  };
}
