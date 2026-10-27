import type { Bucket, File, FileMetadata } from '@google-cloud/storage';
import { pipeline } from 'node:stream/promises';

import {
  addressableObjectName,
  prefixedListPrefix,
  prefixedObjectKey,
  storeKeyPrefix,
  toObjectKey,
  toObjectPrefix,
  UnsafeObjectKeyError,
} from './key-safety.js';
import {
  scopedObjectStoreProvider,
  clampListLimit,
  ObjectConflictError,
  RangeNotSatisfiableError,
  validatedWriteKey,
  PRESIGNED_URL_DEFAULT_TTL_SECONDS,
  type ByteRange,
  type ObjectContent,
  type ObjectListEntry,
  type ObjectMeta,
  type ObjectStoreV2,
  type ObjectStoreProviderV2,
  type PutObjectInput,
  type SignedUrl,
  type SignedUrlRequest,
  type WriteOptions,
  compareEntryKeys,
} from './object-store.js';
import { resolveRange, toNodeReadable, toWebStream } from './streams.js';

const CONTENT_TYPE_KNOWN_METADATA_KEY = 'aw-content-type-known';

export interface GcsStoredObject {
  readonly name: string;
  readonly sizeBytes: number;
  readonly contentType: string | null;
  readonly contentTypeKnown: boolean;
  readonly lastModified: Date;
  /** The object's generation number, as a string: it changes on every rewrite. */
  readonly etag: string;
}

export interface GcsObjectContent extends GcsStoredObject {
  readonly body: Uint8Array;
}

/** The narrow Google Storage protocol used by the backend; tests provide an offline fake. */
export interface GcsClient {
  write(name: string, input: PutObjectInput): Promise<void>;
  read(name: string): Promise<GcsObjectContent | null>;
  delete(name: string): Promise<void>;
  list(prefix: string): Promise<readonly GcsStoredObject[]>;
  copy(sourceName: string, destinationName: string): Promise<void>;
  head(name: string): Promise<GcsStoredObject | null>;
  /** The whole object's metadata and the bytes of `range` (all of them when omitted). */
  readStream(
    name: string,
    range: ByteRange | undefined,
  ): Promise<{ object: GcsStoredObject; body: ReadableStream<Uint8Array> } | null>;
  /** Rejects with {@link ObjectConflictError} when a precondition fails. */
  writeStream(
    name: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options: WriteOptions,
  ): Promise<GcsStoredObject>;
  /** One page; `delimiter` set means one level, with `folders` as full prefixes. */
  listPage(
    prefix: string,
    options: { delimiter: boolean; cursor?: string; limit: number },
  ): Promise<{
    objects: readonly GcsStoredObject[];
    folders: readonly string[];
    cursor: string | null;
  }>;
  /** V4-signed URL for one object; absent when the client cannot sign. Performs no object I/O. */
  signUrl?(name: string, request: SignedUrlRequest): Promise<SignedUrl>;
}

export interface GcsObjectStoreOptions {
  readonly client: GcsClient;
  readonly keyPrefix?: string;
}

export interface GcsObjectStoreConfig {
  readonly bucket: string;
  readonly keyPrefix?: string;
  readonly projectId?: string;
  /** A connection's service-account key; absent means the deployment's application default credentials. */
  readonly credentials?: GcsServiceAccountCredentials;
  /**
   * A connection's short-lived OAuth access token, used instead of `credentials`. It needs a
   * `projectId`, so the client never looks one up in gcloud or the metadata server.
   */
  readonly accessToken?: string;
  /** Total retry deadline for each native client operation, in milliseconds. */
  readonly timeoutMs?: number;
}

interface GcsServiceAccountCredentials {
  readonly client_email: string;
  readonly private_key: string;
}

/**
 * The `Storage` constructor options for `config`; with neither `credentials` nor `accessToken` they
 * are the ADC-only options.
 */
export async function gcsStorageOptions(config: GcsObjectStoreConfig) {
  const projectId = config.projectId?.trim();
  return {
    ...(projectId === undefined || projectId === '' ? {} : { projectId }),
    ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
    ...(config.accessToken === undefined
      ? {}
      : { authClient: await accessTokenClient(config.accessToken) }),
    ...(config.timeoutMs === undefined
      ? {}
      : { retryOptions: { totalTimeout: Math.max(1, config.timeoutMs / 1_000) } }),
  };
}

// `setCredentials`, not the constructor's `credentials`, so the SDK never tries to refresh the token.
// Imported on the token path only, as `@google-cloud/storage` is, so the barrel loads neither.
async function accessTokenClient(accessToken: string) {
  const { OAuth2Client } = await import('google-auth-library');
  const client = new OAuth2Client();
  client.setCredentials({ access_token: accessToken });
  return client;
}

/** Validate an SDK list prefix while preserving the delimiter the store adds internally. */
function nativeListingPrefix(prefix: string): string {
  if (prefix === '') return '';
  if (!prefix.endsWith('/')) return toObjectPrefix(prefix);
  return `${toObjectPrefix(prefix.slice(0, -1))}/`;
}

function toContent(object: GcsObjectContent): ObjectContent {
  return {
    body: object.body,
    contentType: object.contentTypeKnown ? object.contentType : null,
    sizeBytes: object.sizeBytes,
    lastModified: object.lastModified,
  };
}

function toFileEntry(object: GcsStoredObject, prefixLength: number): ObjectListEntry {
  return {
    kind: 'file',
    key: object.name.slice(prefixLength),
    sizeBytes: object.sizeBytes,
    contentType: object.contentTypeKnown ? object.contentType : null,
    lastModified: object.lastModified,
  };
}

/** Raw native GCS backend. Tenant scoping is added by {@link createGcsObjectStoreProvider}. */
export function createGcsObjectStore(options: GcsObjectStoreOptions): ObjectStoreV2 {
  const prefix = storeKeyPrefix(options.keyPrefix);
  const sign = options.client.signUrl?.bind(options.client);
  const metaOf = (object: GcsStoredObject): ObjectMeta => ({
    sizeBytes: object.sizeBytes,
    contentType: object.contentTypeKnown ? object.contentType : null,
    etag: object.etag,
    lastModified: object.lastModified,
  });
  return {
    capabilities: {
      sign: sign !== undefined,
      boundLengthSign: sign !== undefined,
      range: true,
      conditionalPut: true,
      fileAndFolderShareKey: true,
    },
    ...(sign === undefined
      ? {}
      : {
          createSignedUrl: (key: string, request: SignedUrlRequest): Promise<SignedUrl> =>
            sign(prefixedObjectKey(prefix, key), request),
        }),

    async head(key): Promise<ObjectMeta | null> {
      const object = await options.client.head(prefixedObjectKey(prefix, key));
      return object === null ? null : metaOf(object);
    },

    async read(key, readOptions) {
      const found = await options.client.readStream(
        prefixedObjectKey(prefix, key),
        readOptions?.range,
      );
      if (found === null) return null;
      return {
        meta: metaOf(found.object),
        body: found.body,
        range: resolveRange(readOptions?.range, found.object.sizeBytes),
      };
    },

    async write(key, body, writeOptions): Promise<ObjectMeta> {
      const name = await validatedWriteKey(body, writeOptions, () =>
        prefixedObjectKey(prefix, key),
      );
      return metaOf(await options.client.writeStream(name, body, writeOptions));
    },

    async listPage(listPrefix, listOptions) {
      const requestedPrefix = prefixedListPrefix(prefix, listPrefix);
      // `getFiles` takes no AbortSignal: an abort is honoured before the one request, not during it.
      listOptions?.signal?.throwIfAborted();
      const page = await options.client.listPage(requestedPrefix, {
        delimiter: listOptions?.recursive !== true,
        limit: clampListLimit(listOptions?.limit),
        ...(listOptions?.cursor === undefined ? {} : { cursor: listOptions.cursor }),
      });
      const entries: ObjectListEntry[] = [];
      for (const folder of page.folders) {
        const safeFolder = addressableObjectName(folder.replace(/\/$/u, ''));
        if (safeFolder === null) continue;
        entries.push({ kind: 'folder', key: safeFolder.slice(prefix.length) });
      }
      for (const object of page.objects) {
        const safeName = addressableObjectName(object.name);
        if (safeName === null || safeName === requestedPrefix) continue;
        entries.push(toFileEntry({ ...object, name: safeName }, prefix.length));
      }
      return { entries: entries.sort(compareEntryKeys), cursor: page.cursor };
    },

    put(key, input): Promise<void> {
      return options.client.write(prefixedObjectKey(prefix, key), input);
    },

    async get(key): Promise<ObjectContent | null> {
      const object = await options.client.read(prefixedObjectKey(prefix, key));
      return object === null ? null : toContent(object);
    },

    delete(key): Promise<void> {
      return options.client.delete(prefixedObjectKey(prefix, key));
    },

    async list(key): Promise<readonly ObjectListEntry[]> {
      const requestedPrefix = prefixedListPrefix(prefix, key);
      const folders = new Set<string>();
      const files: ObjectListEntry[] = [];
      for (const object of await options.client.list(requestedPrefix)) {
        const safeName = addressableObjectName(object.name);
        if (safeName === null) continue;
        if (!safeName.startsWith(requestedPrefix) || safeName === requestedPrefix) continue;
        const remainder = safeName.slice(requestedPrefix.length);
        const slash = remainder.indexOf('/');
        if (slash >= 0) {
          folders.add(`${requestedPrefix}${remainder.slice(0, slash)}`.slice(prefix.length));
          continue;
        }
        files.push(toFileEntry({ ...object, name: safeName }, prefix.length));
      }
      return [
        ...[...folders].map((folder) => ({ kind: 'folder' as const, key: folder })),
        ...files,
      ].sort(compareEntryKeys);
    },

    async listPrefix(key): Promise<readonly ObjectListEntry[]> {
      const safe = toObjectPrefix(key);
      const requestedPrefix = safe === '' ? prefix : `${prefix}${safe}`;
      const entries: ObjectListEntry[] = [];
      for (const object of await options.client.list(requestedPrefix)) {
        const safeName = addressableObjectName(object.name);
        if (safeName === null) continue;
        const relative = safeName.slice(prefix.length);
        if (safe !== '' && relative !== safe && !relative.startsWith(`${safe}/`)) continue;
        entries.push(toFileEntry({ ...object, name: safeName }, prefix.length));
      }
      return entries.sort(compareEntryKeys);
    },

    copyObject(sourceKey, destinationKey): Promise<void> {
      return options.client.copy(
        prefixedObjectKey(prefix, sourceKey),
        prefixedObjectKey(prefix, destinationKey),
      );
    },
  };
}

export function createGcsObjectStoreProvider(
  options: GcsObjectStoreOptions,
): ObjectStoreProviderV2 {
  return scopedObjectStoreProvider(createGcsObjectStore(options));
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'code');
  return code === 404 || code === '404';
}

function sizeOf(metadata: FileMetadata): number {
  const size = typeof metadata.size === 'number' ? metadata.size : Number(metadata.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('Google Cloud Storage returned an invalid object size.');
  }
  return size;
}

function modifiedAt(metadata: FileMetadata): Date {
  const value = metadata.updated ?? metadata.timeCreated;
  const date = new Date(value ?? Number.NaN);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Google Cloud Storage returned an invalid object timestamp.');
  }
  return date;
}

function metadataFor(file: File, metadata: FileMetadata): GcsStoredObject {
  return {
    name: toObjectKey(file.name),
    sizeBytes: sizeOf(metadata),
    contentType: metadata.contentType ?? null,
    contentTypeKnown: metadata.metadata?.[CONTENT_TYPE_KNOWN_METADATA_KEY] === 'true',
    lastModified: modifiedAt(metadata),
    etag: String(metadata.generation ?? ''),
  };
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}

/** A generation is a positive decimal; anything else (including '0', "create only") can never match. */
function generationFromEtag(etag: string): number {
  const generation = Number(etag);
  if (!/^[1-9]\d*$/u.test(etag) || !Number.isSafeInteger(generation)) {
    throw new ObjectConflictError();
  }
  return generation;
}

/**
 * A GCS SDK error can keep its request, including the bearer token minted from the store's
 * credential. Like `safeAzureProviderError`, keep only the HTTP status and drop the request; the
 * store's own domain errors pass through unchanged.
 */
function safeGcsError(operation: string, error: unknown): unknown {
  if (
    error instanceof ObjectConflictError ||
    error instanceof RangeNotSatisfiableError ||
    error instanceof UnsafeObjectKeyError
  ) {
    return error;
  }
  const code = Number(errorCode(error));
  const cause = new Error(
    Number.isInteger(code) && code > 0
      ? `Google Cloud Storage returned HTTP ${String(code)}.`
      : 'Google Cloud Storage request failed.',
  );
  cause.name = 'GcsServiceError';
  return new Error(`Google Cloud Storage ${operation} failed.`, { cause });
}

async function gcsProviderCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw safeGcsError(operation, error);
  }
}

function safeGcsClient(client: GcsClient): GcsClient {
  const signUrl = client.signUrl?.bind(client);
  return {
    write: (name, input) => gcsProviderCall('write', () => client.write(name, input)),
    read: (name) => gcsProviderCall('read', () => client.read(name)),
    delete: (name) => gcsProviderCall('delete', () => client.delete(name)),
    list: (prefix) => gcsProviderCall('list', () => client.list(prefix)),
    copy: (source, destination) => gcsProviderCall('copy', () => client.copy(source, destination)),
    head: (name) => gcsProviderCall('head', () => client.head(name)),
    readStream: (name, range) => gcsProviderCall('read', () => client.readStream(name, range)),
    writeStream: (name, body, options) =>
      gcsProviderCall('write', () => client.writeStream(name, body, options)),
    listPage: (prefix, options) =>
      gcsProviderCall('list page', () => client.listPage(prefix, options)),
    ...(signUrl === undefined
      ? {}
      : { signUrl: (name, request) => gcsProviderCall('sign', () => signUrl(name, request)) }),
  };
}

/** Adapt the official client to the small protocol above; authentication stays ADC-owned. */
export function createNativeGcsClient(bucket: Bucket): GcsClient {
  return safeGcsClient({
    async write(name, input): Promise<void> {
      await bucket.file(toObjectKey(name)).save(input.body, {
        resumable: false,
        validation: 'crc32c',
        metadata:
          input.contentType === undefined || input.contentType === null
            ? {}
            : {
                contentType: input.contentType,
                metadata: { [CONTENT_TYPE_KNOWN_METADATA_KEY]: 'true' },
              },
      });
    },

    async read(name): Promise<GcsObjectContent | null> {
      const file = bucket.file(toObjectKey(name));
      try {
        // File#download does not populate File.metadata in @google-cloud/storage 8.x. Fetch the
        // bytes and metadata concurrently so a successful read never fabricates missing headers.
        const [[body], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
        return { ...metadataFor(file, metadata), body };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async head(name): Promise<GcsStoredObject | null> {
      const file = bucket.file(toObjectKey(name));
      try {
        const [metadata] = await file.getMetadata();
        return metadataFor(file, metadata);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async readStream(name, range) {
      const objectName = toObjectKey(name);
      let object: GcsStoredObject;
      try {
        const [metadata] = await bucket.file(objectName).getMetadata();
        object = metadataFor(bucket.file(objectName), metadata);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      const served = resolveRange(range, object.sizeBytes);
      // Pinned to the generation just described, so `meta.etag` and the bytes are one version.
      // `end` is inclusive in createReadStream, as in `ByteRange`.
      const source = bucket
        .file(objectName, { generation: object.etag })
        .createReadStream(served === null ? {} : { start: served.start, end: served.end });
      return { object, body: toWebStream(source) };
    },

    async writeStream(name, body, options): Promise<GcsStoredObject> {
      const file = bucket.file(toObjectKey(name));
      const source = toNodeReadable(body);
      try {
        const generation =
          options.ifNoneMatch === '*'
            ? 0
            : options.ifMatch === undefined
              ? undefined
              : generationFromEtag(options.ifMatch);
        const hasContentType = options.contentType !== undefined && options.contentType !== null;
        await pipeline(
          source,
          // MD5, not CRC32C: the SDK's CRC32C transform grew the process RSS by about 25 MiB more
          // over a 1 GiB stream to a slow server (61 MiB against 35 MiB without validation; MD5 39),
          // which broke the 64 MiB flat-memory budget on CI (the storage design, §07 "Load test").
          // A single-request upload is a non-composite object, so GCS returns its md5Hash to check.
          // Resumable is no better: 8 MiB chunks measured 178 MiB.
          file.createWriteStream({
            resumable: false,
            validation: 'md5',
            ...(generation === undefined
              ? {}
              : { preconditionOpts: { ifGenerationMatch: generation } }),
            metadata: hasContentType
              ? {
                  contentType: options.contentType,
                  metadata: { [CONTENT_TYPE_KNOWN_METADATA_KEY]: 'true' },
                }
              : {},
          }),
        );
        // The simple upload's response, so the generation is this write's, not a later writer's.
        return metadataFor(file, file.metadata);
      } catch (error) {
        const code = errorCode(error);
        throw code === 412 || code === '412' ? new ObjectConflictError() : error;
      } finally {
        source.destroy(); // cancels the source stream if it was not read to the end
      }
    },

    async listPage(prefix, options) {
      const [files, next, response] = await bucket.getFiles({
        prefix: nativeListingPrefix(prefix),
        autoPaginate: false,
        maxResults: options.limit,
        ...(options.delimiter ? { delimiter: '/' } : {}),
        ...(options.cursor === undefined ? {} : { pageToken: options.cursor }),
      });
      const prefixes: unknown =
        typeof response === 'object' && response !== null
          ? Reflect.get(response, 'prefixes')
          : undefined;
      return {
        objects: files
          .filter((file) => addressableObjectName(file.name) !== null)
          .map((file) => metadataFor(file, file.metadata)),
        folders: Array.isArray(prefixes)
          ? prefixes.filter((folder): folder is string => typeof folder === 'string')
          : [],
        cursor: next?.pageToken ?? null,
      };
    },

    async delete(name): Promise<void> {
      try {
        await bucket.file(toObjectKey(name)).delete({ ignoreNotFound: true });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },

    async list(prefix): Promise<readonly GcsStoredObject[]> {
      const [files] = await bucket.getFiles({ prefix: nativeListingPrefix(prefix) });
      const objects: GcsStoredObject[] = [];
      for (const file of files) {
        if (addressableObjectName(file.name) === null) continue;
        objects.push(metadataFor(file, file.metadata));
      }
      return objects;
    },

    async signUrl(name, request): Promise<SignedUrl> {
      const writes = request.method === 'PUT';
      const hasContentType =
        writes && request.contentType !== undefined && request.contentType !== null;
      const extensionHeaders: Record<string, string> = {
        ...(hasContentType ? { [`x-goog-meta-${CONTENT_TYPE_KNOWN_METADATA_KEY}`]: 'true' } : {}),
        ...(writes && request.contentLength !== undefined
          ? { 'x-goog-content-length-range': `${request.contentLength},${request.contentLength}` }
          : {}),
      };
      const now = request.now ?? new Date();
      const [url] = await bucket.file(toObjectKey(name)).getSignedUrl({
        version: 'v4',
        action: writes ? 'write' : 'read',
        expires:
          now.getTime() + (request.expiresInSeconds ?? PRESIGNED_URL_DEFAULT_TTL_SECONDS) * 1_000,
        extensionHeaders,
        ...(hasContentType ? { contentType: request.contentType } : {}),
        ...(request.responseContentType === undefined
          ? {}
          : { responseType: request.responseContentType }),
        ...(request.responseDisposition === undefined
          ? {}
          : { responseDisposition: request.responseDisposition }),
      });
      return {
        url,
        headers: hasContentType
          ? { 'content-type': request.contentType ?? '', ...extensionHeaders }
          : extensionHeaders,
      };
    },

    async copy(sourceName, destinationName): Promise<void> {
      try {
        await bucket.file(toObjectKey(sourceName)).copy(bucket.file(toObjectKey(destinationName)));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  });
}

export class GcsBucketUnavailableError extends Error {
  public readonly reason: 'missing' | 'unreachable';

  public constructor(bucket: string, reason: 'missing' | 'unreachable', cause?: unknown) {
    super(
      `Google Cloud Storage bucket "${bucket}" is missing or not reachable by the deployment identity.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'GcsBucketUnavailableError';
    this.reason = reason;
  }
}

/** Construct a scoped native GCS provider and fail readiness when the bucket is unavailable. */
export async function createGcsObjectStoreProviderFromConfig(
  config: GcsObjectStoreConfig,
): Promise<ObjectStoreProviderV2> {
  return scopedObjectStoreProvider(await createGcsObjectStoreFromConfig(config));
}

/** The same store, unscoped: workspace-agnostic names under `config.keyPrefix`. */
export async function createGcsObjectStoreFromConfig(
  config: GcsObjectStoreConfig,
): Promise<ObjectStoreV2> {
  const bucketName = config.bucket.trim();
  if (bucketName === '') throw new Error('A GCS object store requires a non-empty bucket name.');
  if (config.accessToken !== undefined && (config.projectId?.trim() ?? '') === '') {
    throw new Error('A GCS access token requires a project id.');
  }
  if (config.accessToken !== undefined && config.credentials !== undefined) {
    throw new Error('A GCS object store takes either credentials or an access token, not both.');
  }
  const { Storage } = await import('@google-cloud/storage');
  const storage = new Storage(await gcsStorageOptions(config));
  const bucket = storage.bucket(bucketName);
  try {
    // List one object instead of `bucket.exists()`: that call is `storage.buckets.get`, which the
    // roles a customer grants (Object Viewer, Object User) and the platform's objectAdmin lack.
    // `storage.objects.list` is in all of them.
    const prefix = storeKeyPrefix(config.keyPrefix);
    await bucket.getFiles({
      maxResults: 1,
      autoPaginate: false,
      ...(prefix === '' ? {} : { prefix }),
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === 404) {
      throw new GcsBucketUnavailableError(bucketName, 'missing');
    }
    throw new GcsBucketUnavailableError(bucketName, 'unreachable', error);
  }
  const client = createNativeGcsClient(bucket);
  // A token is no key to sign with: the SDK would ask the metadata server for the deployment's own
  // service account and have iamcredentials sign as it, with the customer's token.
  if (config.accessToken !== undefined) delete client.signUrl;
  return createGcsObjectStore({
    client,
    ...(config.keyPrefix === undefined ? {} : { keyPrefix: config.keyPrefix }),
  });
}
