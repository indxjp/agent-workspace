/**
 * The narrow Google Storage protocol the GCS backend speaks, the layer that keeps a provider
 * failure from carrying the store's credentials out, how a store reads through the protocol, and
 * the JSON API rules the native client applies to its requests and responses. It imports no
 * Google Cloud SDK: only `gcs-store.ts` does
 * (the storage design, §07 rule 1).
 */
import type { Hash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';

import {
  addressableObjectName,
  prefixedListPrefix,
  prefixedObjectKey,
  toObjectPrefix,
  UnsafeObjectKeyError,
} from './key-safety.js';
import {
  clampListLimit,
  compareListingNames,
  ObjectConflictError,
  RangeNotSatisfiableError,
  SignedUrlUnsupportedError,
  type ByteRange,
  type ListPageOptions,
  type ObjectListEntry,
  type ObjectMeta,
  type ObjectPage,
  type ObjectStore,
  type ObjectStream,
  type SignedUrl,
  type SignedUrlRequest,
  type WriteOptions,
} from './object-store.js';
import { abortableBody, resolveRange } from './streams.js';

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

export function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'code');
  return code === 404 || code === '404';
}

/**
 * `objects.get` answers 404 for a missing bucket too, told apart only by its message. A bucket
 * deleted under a store is an outage, not an absent object: a caller must never treat it as one.
 */
export function isMissingBucket(error: unknown): boolean {
  if (!isNotFound(error)) return false;
  const message: unknown = Reflect.get(error as object, 'message');
  return typeof message === 'string' && /^The specified bucket does not exist/iu.test(message);
}

export function errorCode(error: unknown): unknown {
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
export function safeGcsError(operation: string, error: unknown): unknown {
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
 * chunk per pull, as `toWebStream` does.
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

export function safeGcsClient(client: GcsClient): GcsClient {
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
export class GcsIntegrityError extends Error {
  public constructor(cleanup: unknown) {
    super(
      'Google Cloud Storage stored bytes that differ from the ones sent.',
      cleanup === undefined ? undefined : { cause: safeGcsError('integrity cleanup', cleanup) },
    );
    this.name = 'GcsIntegrityError';
  }
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

// The store's side of the protocol: what an object store reads through a client.

function toFileEntry(object: GcsStoredObject, prefixLength: number): ObjectListEntry {
  return {
    kind: 'file',
    key: object.name.slice(prefixLength),
    sizeBytes: object.sizeBytes,
    contentType: object.contentTypeKnown ? object.contentType : null,
    lastModified: object.lastModified,
  };
}

export function metaOf(object: GcsStoredObject): ObjectMeta {
  return {
    sizeBytes: object.sizeBytes,
    contentType: object.contentTypeKnown ? object.contentType : null,
    etag: object.etag,
    lastModified: object.lastModified,
  };
}

/** A store's client and the key prefix its names live under. */
export interface GcsTarget {
  readonly client: GcsClient;
  readonly prefix: string;
}

export async function readObject(
  target: GcsTarget,
  key: string,
  readOptions: Parameters<ObjectStore['read']>[1],
): Promise<ObjectStream | null> {
  const signal = readOptions?.signal;
  signal?.throwIfAborted();
  const found = await target.client.readStream(
    prefixedObjectKey(target.prefix, key),
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
}

/** A page's addressable folders and files, in listing order. */
function listEntries(
  page: Awaited<ReturnType<GcsClient['listPage']>>,
  prefix: string,
  requestedPrefix: string,
): ObjectListEntry[] {
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
  return entries.sort(compareListingNames);
}

export async function listObjects(
  target: GcsTarget,
  listPrefix: string,
  listOptions: ListPageOptions | undefined,
): Promise<ObjectPage> {
  const requestedPrefix = prefixedListPrefix(target.prefix, listPrefix);
  // `getFiles` takes no AbortSignal: an abort is honoured before the one request, not during it.
  listOptions?.signal?.throwIfAborted();
  const page = await target.client.listPage(requestedPrefix, {
    delimiter: listOptions?.recursive !== true,
    limit: clampListLimit(listOptions?.limit),
    ...(listOptions?.cursor === undefined ? {} : { cursor: listOptions.cursor }),
  });
  return { entries: listEntries(page, target.prefix, requestedPrefix), cursor: page.cursor };
}

// The JSON API's side of the protocol, shared by the native client's requests and responses.

/** Set to `'true'` in an object's custom metadata when its content type was given, not guessed. */
export const CONTENT_TYPE_KNOWN_METADATA_KEY = 'aw-content-type-known';

/** Validate an SDK list prefix while preserving the delimiter the store adds internally. */
export function nativeListingPrefix(prefix: string): string {
  if (prefix === '') return '';
  if (!prefix.endsWith('/')) return toObjectPrefix(prefix);
  return `${toObjectPrefix(prefix.slice(0, -1))}/`;
}

/** The generation a write must match: 0 for create-only, none without a precondition. */
export function generationPrecondition(options: WriteOptions): number | undefined {
  if (options.ifNoneMatch === '*') return 0;
  return options.ifMatch === undefined ? undefined : generationFromEtag(options.ifMatch);
}

export function uploadMetadata(options: WriteOptions) {
  const hasContentType = options.contentType !== undefined && options.contentType !== null;
  return hasContentType
    ? {
        contentType: options.contentType,
        metadata: { [CONTENT_TYPE_KNOWN_METADATA_KEY]: 'true' },
      }
    : {};
}

/** A pass-through stage that feeds every chunk to `hash`. */
export function md5Tap(hash: Hash): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

/** What a failed upload rejects with. */
export function writeFailure(source: Readable, error: unknown): unknown {
  // The caller's own body failed: report that, not the upload error it caused.
  if (source.errored !== null) return source.errored;
  const code = errorCode(error);
  return code === 412 || code === '412' ? new ObjectConflictError() : error;
}

/** The folder prefixes a delimited `getFiles` response lists; none when it lists none. */
export function listedPrefixes(response: unknown): string[] {
  const prefixes: unknown =
    typeof response === 'object' && response !== null
      ? Reflect.get(response, 'prefixes')
      : undefined;
  return Array.isArray(prefixes)
    ? prefixes.filter((folder): folder is string => typeof folder === 'string')
    : [];
}

/** The content type a signed upload must carry; a read, or an upload without one, pins none. */
export function signedContentType(request: SignedUrlRequest): string | undefined {
  if (request.method !== 'PUT' || request.contentType === null) return undefined;
  return request.contentType;
}

/** The `x-goog-*` headers a signed request must send, bound into its signature. */
export function gcsExtensionHeaders(
  request: SignedUrlRequest,
  contentType: string | undefined,
): Record<string, string> {
  return {
    ...(contentType === undefined
      ? {}
      : { [`x-goog-meta-${CONTENT_TYPE_KNOWN_METADATA_KEY}`]: 'true' }),
    ...(request.method === 'PUT' && request.contentLength !== undefined
      ? { 'x-goog-content-length-range': `${request.contentLength},${request.contentLength}` }
      : {}),
  };
}
