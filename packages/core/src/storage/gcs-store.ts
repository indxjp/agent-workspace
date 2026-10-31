import type { Bucket, File, FileMetadata } from '@google-cloud/storage';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
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
  SignedUrlUnsupportedError,
  validatedWriteKey,
  PRESIGNED_URL_DEFAULT_TTL_SECONDS,
  type ByteRange,
  type EmulatorObjectStore,
  type ObjectListEntry,
  type ObjectMeta,
  type ObjectStore,
  type ObjectStoreProvider,
  type SignedUrl,
  type SignedUrlRequest,
  type WriteOptions,
  compareListingNames,
} from './object-store.js';
import { abortableBody, resolveRange, toNodeReadable, toWebStream } from './streams.js';

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

/** The narrow Google Storage protocol used by the backend; tests provide an offline fake. */
export interface GcsClient {
  delete(name: string): Promise<void>;
  copy(sourceName: string, destinationName: string): Promise<void>;
  head(name: string): Promise<GcsStoredObject | null>;
  /**
   * The whole object's metadata and the bytes of `range` (all of them when omitted). `signal`
   * stops the media request; the metadata request takes none.
   */
  readStream(
    name: string,
    range: ByteRange | undefined,
    signal?: AbortSignal,
  ): Promise<{ object: GcsStoredObject; body: ReadableStream<Uint8Array> } | null>;
  /**
   * Rejects with {@link ObjectConflictError} when a precondition fails. `options.signal` stops the
   * upload, including a request still waiting for its response after the body was sent.
   */
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
  /**
   * `false` skips the one-object listing an open otherwise makes. A connection store sets it, so
   * the bucket's refusal shows, with its status, at the connection's first listing of an allowed
   * folder, as it does on S3.
   */
  readonly checkBucketOnOpen?: boolean;
  /**
   * The JSON API origin the client dials, such as `http://127.0.0.1:4443`; absent means Google's.
   * Tests point a store at a local server with it. Requests keep the config's credentials.
   */
  readonly apiEndpoint?: string;
  /**
   * `true` refuses the open with {@link GcsEndpointForbiddenError} when the client the SDK builds
   * would dial anything but `apiEndpoint`, or Google's own API host without one. The SDK reads
   * `STORAGE_EMULATOR_HOST` by itself, so a connection store sets it: a customer connection must
   * never reach an unchecked host.
   */
  readonly requireApiEndpoint?: boolean;
}

/** Google's JSON API host in the default universe, which a GCS config dials without `apiEndpoint`. */
const GOOGLE_API_ENDPOINT = 'https://storage.googleapis.com';

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
    // A custom endpoint drops auth unless asked to keep it.
    ...(config.apiEndpoint === undefined
      ? {}
      : { apiEndpoint: config.apiEndpoint, useAuthWithCustomEndpoint: true }),
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
export function createGcsObjectStore(options: GcsObjectStoreOptions): ObjectStore {
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
      const signal = readOptions?.signal;
      signal?.throwIfAborted();
      const found = await options.client.readStream(
        prefixedObjectKey(prefix, key),
        readOptions?.range,
        signal,
      );
      // `getMetadata` takes no signal: an abort while it ran is honoured once it answers.
      signal?.throwIfAborted();
      if (found === null) return null;
      return {
        meta: metaOf(found.object),
        body: abortableBody(found.body, signal),
        range: resolveRange(readOptions?.range, found.object.sizeBytes),
      };
    },

    async write(key, body, writeOptions): Promise<ObjectMeta> {
      const name = await validatedWriteKey(body, writeOptions, () =>
        prefixedObjectKey(prefix, key),
      );
      return metaOf(
        await options.client.writeStream(
          name,
          abortableBody(body, writeOptions.signal),
          writeOptions,
        ),
      );
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
      // GCS pages by native name, so folder `a` (`a/`) comes after file `a.txt`.
      return { entries: entries.sort(compareListingNames), cursor: page.cursor };
    },

    delete(key): Promise<void> {
      return options.client.delete(prefixedObjectKey(prefix, key));
    },

    copy(sourceKey, destinationKey): Promise<void> {
      return options.client.copy(
        prefixedObjectKey(prefix, sourceKey),
        prefixedObjectKey(prefix, destinationKey),
      );
    },
  };
}

export function createGcsObjectStoreProvider(options: GcsObjectStoreOptions): ObjectStoreProvider {
  return scopedObjectStoreProvider(createGcsObjectStore(options));
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'code');
  return code === 404 || code === '404';
}

/**
 * `objects.get` answers 404 for a missing bucket too, told apart only by its message. A bucket
 * deleted under a store is an outage, not an absent object: a caller must never treat it as one.
 */
function isMissingBucket(error: unknown): boolean {
  if (!isNotFound(error)) return false;
  const message: unknown = Reflect.get(error as object, 'message');
  return typeof message === 'string' && /^The specified bucket does not exist/iu.test(message);
}

/** {@link isNotFound} for an object, rethrowing a missing bucket as its own safe error. */
function objectNotFound(bucket: Bucket, error: unknown): boolean {
  if (isMissingBucket(error)) throw new GcsBucketUnavailableError(bucket.name, 'missing');
  return isNotFound(error);
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
    error instanceof SignedUrlUnsupportedError ||
    error instanceof UnsafeObjectKeyError ||
    error instanceof GcsBucketUnavailableError ||
    error instanceof GcsIntegrityError
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
  const failure = new Error(`Google Cloud Storage ${operation} failed.`, { cause });
  // The status alone, on the error itself, so a caller can tell a refusal from an outage.
  return Number.isInteger(code) && code >= 100 && code <= 599
    ? Object.assign(failure, { statusCode: code })
    : failure;
}

async function gcsProviderCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw safeGcsError(operation, error);
  }
}

/**
 * The body of a download, failing through {@link safeGcsError}: the media request starts on the
 * first read, after `readStream` resolved, so its refusal never passes `gcsProviderCall`. Read one
 * chunk per pull, as {@link toWebStream} does.
 */
function safeGcsBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await reader.read().catch((error: unknown) => {
          reader.releaseLock();
          throw safeGcsError('read', error);
        });
        if (next.done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(next.value);
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } catch (error) {
          throw safeGcsError('read', error);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

/** `body`, passed through one chunk per pull, remembering the error the caller's stream failed with. */
function watchedBody(body: ReadableStream<Uint8Array> | Uint8Array): {
  readonly body: ReadableStream<Uint8Array> | Uint8Array;
  readonly failure: () => { readonly error: unknown } | undefined;
} {
  if (body instanceof Uint8Array) return { body, failure: () => undefined };
  let failure: { readonly error: unknown } | undefined;
  const reader = body.getReader();
  return {
    body: new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          let next: Awaited<ReturnType<typeof reader.read>>;
          try {
            next = await reader.read();
          } catch (error) {
            failure = { error };
            throw error;
          }
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    ),
    failure: () => failure,
  };
}

function safeGcsClient(client: GcsClient): GcsClient {
  const signUrl = client.signUrl?.bind(client);
  return {
    delete: (name) => gcsProviderCall('delete', () => client.delete(name)),
    copy: (source, destination) => gcsProviderCall('copy', () => client.copy(source, destination)),
    head: (name) => gcsProviderCall('head', () => client.head(name)),
    readStream: async (name, range, signal) => {
      const found = await gcsProviderCall('read', () => client.readStream(name, range, signal));
      return found === null ? null : { ...found, body: safeGcsBody(found.body) };
    },
    writeStream: async (name, body, options) => {
      const watched = watchedBody(body);
      try {
        return await client.writeStream(name, watched.body, options);
      } catch (error) {
        // The caller's own body failed: report that, not the provider error it caused. Only a
        // provider error can carry the request and its bearer token, so only it is sanitised.
        const failure = watched.failure();
        if (failure !== undefined) throw failure.error;
        throw safeGcsError('write', error);
      }
    },
    listPage: (prefix, options) =>
      gcsProviderCall('list page', () => client.listPage(prefix, options)),
    ...(signUrl === undefined
      ? {}
      : { signUrl: (name, request) => gcsProviderCall('sign', () => signUrl(name, request)) }),
  };
}

/**
 * GCS stored other bytes than the ones sent. The message is fixed and a failed cleanup is kept
 * as a sanitised cause, so the client's safe-error wrapper passes it on unchanged.
 */
class GcsIntegrityError extends Error {
  public constructor(cleanup: unknown) {
    super(
      'Google Cloud Storage stored bytes that differ from the ones sent.',
      cleanup === undefined ? undefined : { cause: safeGcsError('integrity cleanup', cleanup) },
    );
    this.name = 'GcsIntegrityError';
  }
}

/**
 * Remove a mismatched upload only while it is still the generation this write made: a concurrent
 * writer's newer generation fails the precondition (412) and stays. With no generation to pin,
 * nothing is deleted. Answers the delete's own failure, for the mismatch error to carry as its cause.
 */
async function deleteOwnGeneration(file: File, generation: unknown): Promise<unknown> {
  const pinned = Number(generation);
  if (!Number.isSafeInteger(pinned) || pinned <= 0) return undefined;
  try {
    await file.delete({ ifGenerationMatch: pinned });
    return undefined;
  } catch (error) {
    const code = Number(errorCode(error));
    return code === 412 || code === 404 ? undefined : error;
  }
}

/** Adapt the official client to the small protocol above; authentication stays ADC-owned. */
export function createNativeGcsClient(bucket: Bucket): GcsClient {
  return safeGcsClient({
    async head(name): Promise<GcsStoredObject | null> {
      const file = bucket.file(toObjectKey(name));
      try {
        const [metadata] = await file.getMetadata();
        return metadataFor(file, metadata);
      } catch (error) {
        if (objectNotFound(bucket, error)) return null;
        throw error;
      }
    },

    async readStream(name, range, signal) {
      const objectName = toObjectKey(name);
      let object: GcsStoredObject;
      try {
        const [metadata] = await bucket.file(objectName).getMetadata();
        object = metadataFor(bucket.file(objectName), metadata);
      } catch (error) {
        if (objectNotFound(bucket, error)) return null;
        throw error;
      }
      const served = resolveRange(range, object.sizeBytes);
      // Pinned to the generation just described, so `meta.etag` and the bytes are one version.
      // `end` is inclusive in createReadStream, as in `ByteRange`.
      const source = bucket
        .file(objectName, { generation: object.etag })
        .createReadStream(served === null ? {} : { start: served.start, end: served.end });
      // The SDK's stream takes no signal; destroying it ends the media request.
      if (signal !== undefined) {
        const stop = (): void => {
          source.destroy();
        };
        signal.addEventListener('abort', stop, { once: true });
        source.once('close', () => signal.removeEventListener('abort', stop));
      }
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
        // MD5, not CRC32C: the SDK's CRC32C transform grew the process RSS by about 25 MiB more
        // over a 1 GiB stream to a slow server (61 MiB against 35 MiB without validation; MD5 39),
        // which broke the 64 MiB flat-memory budget on CI (the storage design, §07 "Load test").
        // A single-request upload is a non-composite object, so GCS returns its md5Hash to check.
        // Resumable is no better: 8 MiB chunks measured 178 MiB. The hash is taken here, not by
        // the SDK's `validation`, because the SDK deletes a mismatch with no precondition.
        const md5 = createHash('md5');
        await pipeline(
          source,
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              md5.update(chunk);
              callback(null, chunk);
            },
          }),
          file.createWriteStream({
            resumable: false,
            validation: false,
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
          options.signal === undefined ? {} : { signal: options.signal },
        );
        // The simple upload's response, so the generation is this write's, not a later writer's.
        const written = file.metadata;
        if (written.md5Hash !== md5.digest('base64')) {
          throw new GcsIntegrityError(await deleteOwnGeneration(file, written.generation));
        }
        return metadataFor(file, written);
      } catch (error) {
        // The caller's own body failed: report that, not the upload error it caused.
        if (source.errored !== null) throw source.errored;
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
      const expires =
        now.getTime() + (request.expiresInSeconds ?? PRESIGNED_URL_DEFAULT_TTL_SECONDS) * 1_000;
      // The SDK refuses an expiry before this host's clock, so a window that is already over gets
      // the typed refusal rather than an SDK error; S3 and Azure sign it and the provider refuses
      // the fetch instead.
      if (expires <= Date.now()) {
        throw new SignedUrlUnsupportedError('The signed link would already have expired.');
      }
      const [url] = await bucket.file(toObjectKey(name)).getSignedUrl({
        version: 'v4',
        action: writes ? 'write' : 'read',
        // The window starts at the requested instant, as on S3 and Azure, not at this host's clock.
        accessibleAt: now,
        expires,
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

/** The client the SDK built would dial a host other than Google's; no request was made. */
export class GcsEndpointForbiddenError extends Error {
  public constructor() {
    super('The Google Cloud Storage client is not pointed at its configured API endpoint.');
    this.name = 'GcsEndpointForbiddenError';
  }
}

/**
 * Tests only, through `@agent-workspace/core/storage/backends` (the storage design, §07 "Load
 * test"): a new, empty bucket on the fake-gcs-server at `apiEndpoint`, such as
 * `http://127.0.0.1:4443`, so a caller outside this package needs no Google Cloud dependency of
 * its own.
 */
export async function createFakeGcsObjectStore(apiEndpoint: string): Promise<EmulatorObjectStore> {
  const { Storage } = await import('@google-cloud/storage');
  const storage = new Storage({ apiEndpoint, projectId: 'aw-emulator' });
  const [bucket] = await storage.createBucket(`aw-${randomUUID()}`);
  return {
    provider: createGcsObjectStoreProvider({ client: createNativeGcsClient(bucket) }),
    teardown: async () => {
      await bucket.deleteFiles({ force: true });
      await bucket.delete();
    },
    plantRaw: async (name, bytes) => {
      await bucket.file(name).save(Buffer.from(bytes), { resumable: false });
    },
  };
}

/** Construct a scoped native GCS provider and fail readiness when the bucket is unavailable. */
export async function createGcsObjectStoreProviderFromConfig(
  config: GcsObjectStoreConfig,
): Promise<ObjectStoreProvider> {
  return scopedObjectStoreProvider(await createGcsObjectStoreFromConfig(config));
}

/** The same store, unscoped: workspace-agnostic names under `config.keyPrefix`. */
export async function createGcsObjectStoreFromConfig(
  config: GcsObjectStoreConfig,
): Promise<ObjectStore> {
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
  const endpoint = config.apiEndpoint ?? GOOGLE_API_ENDPOINT;
  if (
    config.requireApiEndpoint === true &&
    (storage.apiEndpoint !== endpoint || storage.baseUrl !== `${endpoint}/storage/v1`)
  ) {
    throw new GcsEndpointForbiddenError();
  }
  const bucket = storage.bucket(bucketName);
  if (config.checkBucketOnOpen !== false) {
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
      // The SDK error keeps its request and bearer token; only its HTTP status is kept as the cause.
      throw new GcsBucketUnavailableError(
        bucketName,
        'unreachable',
        safeGcsError('bucket check', error),
      );
    }
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
