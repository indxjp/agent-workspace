import {
  AbortMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { isHttpEndpoint } from '@indx-workspace/contracts/storage-url';
import type { Readable } from 'node:stream';

import { prefixedListPrefix, prefixedObjectKey, storeKeyPrefix } from './key-safety.js';
import {
  scopedObjectStoreProvider,
  type ByteRange,
  type ListPageOptions,
  type ObjectListEntry,
  type ObjectMeta,
  type ObjectPage,
  type ObjectStore,
  type ObjectStoreProvider,
  type ObjectStream,
  type SignedUrl,
  type SignedUrlRequest,
  type WriteOptions,
  clampListLimit,
  compareEntryKeys,
  compareListingNames,
  ObjectConflictError,
  validatedWriteKey,
  PRESIGNED_URL_DEFAULT_TTL_SECONDS,
  RangeNotSatisfiableError,
} from './object-store.js';
import { connectionAgents, type ConnectionTransport } from './connection-transport.js';
import {
  listingOrderFor,
  s3Credentials,
  type S3ListingOrder,
  type S3ObjectStoreConfig,
} from './s3-config.js';
import { isMissingObject, isNotFound, isRangeRefused, isWriteConflict } from './s3-errors.js';
import { fileRows, folderEntries, pageCursor, type FileRow } from './s3-listing.js';
import { presignLocation, presignS3Url, type PresignEndpoint } from './s3-presign.js';
import {
  abortableBody,
  countedBody,
  resolveRange,
  servedRange,
  toNodeReadable,
  toWebStream,
} from './streams.js';

export interface S3ObjectStoreOptions {
  readonly client: S3Client;
  readonly bucket: string;
  readonly keyPrefix?: string;
  /** The host signed links name, for a browser that cannot reach `client`'s endpoint. */
  readonly publicEndpoint?: string;
  /**
   * How a one-level `listPage` orders a page, which must match how the server pages folders and
   * files so pages concatenate into one order. `bare-key` (the default) is SeaweedFS, the bundled
   * server: folder `a` before file `a.txt`. `native` is AWS: by native name, where folder `a` is
   * `a/` and sorts after `a.txt`.
   */
  readonly listingOrder?: S3ListingOrder;
}

/** The bucket and key prefix one store addresses through its client, and how it signs and lists. */
interface S3Target {
  readonly client: S3Client;
  readonly bucket: string;
  readonly prefix: string;
  readonly publicEndpoint: PresignEndpoint | undefined;
  readonly listingOrder: S3ListingOrder | undefined;
}

type ReadOptions = Parameters<ObjectStore['read']>[1];

/** The user-metadata name that marks a stored content type as the writer's own. */
const CONTENT_TYPE_KNOWN = 'aw-content-type-known';

function knownType(
  metadata: Record<string, string> | undefined,
  contentType: string | undefined,
): string | null {
  return metadata?.[CONTENT_TYPE_KNOWN] === 'true' ? (contentType ?? null) : null;
}

const RESPONSE_DATE = Symbol('aw.s3.responseDate');

/**
 * Neither PutObject nor CompleteMultipartUpload answers the object's time, but every S3 response
 * carries the server's `Date`. This middleware copies it onto each command's output under a
 * symbol, which the upload library's result keeps (it spreads the PutObject output), so a write
 * learns the server's time without a second request. The fixed name with `override` registers it
 * once however many stores share the client.
 */
function recordResponseDates(client: S3Client): void {
  client.middlewareStack.add(
    (next) => async (args) => {
      const result = await next(args);
      const date = dateHeaderOf(result.response);
      if (date !== null && typeof result.output === 'object' && result.output !== null) {
        Object.assign(result.output, { [RESPONSE_DATE]: date });
      }
      return result;
    },
    // `high` runs it outside the SDK's deserializer, where the output already exists.
    { step: 'deserialize', priority: 'high', name: 'awResponseDate', override: true },
  );
}

function dateHeaderOf(response: unknown): Date | null {
  if (typeof response !== 'object' || response === null) return null;
  const headers: unknown = Reflect.get(response, 'headers');
  if (typeof headers !== 'object' || headers === null) return null;
  const value: unknown = Reflect.get(headers, 'date');
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The server's `Date` of the response that produced `output`; null when it sent none. */
function responseDateOf(output: object): Date | null {
  const value: unknown = Reflect.get(output, RESPONSE_DATE);
  return value instanceof Date ? value : null;
}

/** A listing that asks for content types sends at most this many HEADs at once. */
const LIST_HEAD_CONCURRENCY = 8;

// One part in flight keeps a write's memory near UPLOAD_PART_BYTES whatever the object size.
// The S3 minimum part size: at 8 MiB the 256 MiB load case reached 64.6 MiB of RSS growth on CI.
// At 5 MiB, the 1 GiB round trip (`tests/load/object-store-round-trip.test.ts`, AW_LOAD_TESTS=1,
// SeaweedFS, after the HTTP warm-up) measured 10.9, 13.5 and 18.8 MiB of RSS growth over three
// runs, with no new-space growth: at least 45 MiB under its 64 MiB bound (#1746).
const UPLOAD_PART_BYTES = 5 * 1024 * 1024;
const UPLOAD_QUEUE_SIZE = 1;

/** The scheme, host and path a presigned URL names: the public endpoint when set, else where the client sends requests. */
async function objectLocation(
  target: S3Target,
  objectKey: string,
): Promise<{ scheme: 'http' | 'https'; host: string; path: string }> {
  const { client } = target;
  const region = await client.config.region();
  const endpoint =
    target.publicEndpoint ??
    (client.config.endpoint === undefined ? undefined : await client.config.endpoint());
  return presignLocation({
    region,
    endpoint,
    forcePathStyle: client.config.forcePathStyle === true,
    bucket: target.bucket,
    objectKey,
  });
}

function parsePublicEndpoint(value: string): PresignEndpoint {
  // The value itself is never repeated in the message.
  if (!isHttpEndpoint(value)) {
    throw new Error(
      'publicEndpoint must be an http or https URL without credentials, query, or fragment.',
    );
  }
  const url = new URL(value);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port === '' ? undefined : Number(url.port),
    path: url.pathname,
  };
}

async function headObject(target: S3Target, key: string): Promise<ObjectMeta | null> {
  try {
    const response = await target.client.send(
      new HeadObjectCommand({ Bucket: target.bucket, Key: prefixedObjectKey(target.prefix, key) }),
    );
    return {
      sizeBytes: response.ContentLength ?? 0,
      contentType: knownType(response.Metadata, response.ContentType),
      etag: response.ETag ?? '',
      lastModified: response.LastModified ?? new Date(0),
    };
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
}

// After a HEAD 404: throws for a missing bucket, which only a GET's error body names. An object
// written since the HEAD leaves its answer standing, and the one byte served is discarded.
async function confirmMissingObject(target: S3Target, key: string): Promise<void> {
  try {
    const response = await target.client.send(
      new GetObjectCommand({
        Bucket: target.bucket,
        Key: prefixedObjectKey(target.prefix, key),
        Range: 'bytes=0-0',
      }),
    );
    (response.Body as Readable | undefined)?.destroy();
  } catch (error) {
    // An empty object written since the HEAD refuses even the first byte.
    if (isMissingObject(error) || isRangeRefused(error)) return;
    throw error;
  }
}

/** `range` resolved against the object's size, or `null` when there is no object. */
async function checkedRange(
  target: S3Target,
  key: string,
  range: ByteRange,
): Promise<{ readonly start: number; readonly end: number } | null> {
  const meta = await headObject(target, key);
  if (meta === null) {
    // A HEAD 404 has no body to name a missing bucket; a one-byte GET's error body does.
    await confirmMissingObject(target, key);
    return null;
  }
  return resolveRange(range, meta.sizeBytes);
}

function readResult(
  response: GetObjectCommandOutput,
  range: { readonly start: number; readonly end: number } | null,
  signal: AbortSignal | undefined,
): ObjectStream | null {
  if (response.Body === undefined) return null;
  const source = response.Body as Readable;
  // `Content-Range: bytes 2-5/10` carries both the served range and the whole size.
  const served = servedRange(response.ContentRange);
  if (range !== null && served === null) {
    source.destroy();
    throw new Error('S3 ignored the requested byte range.');
  }
  return {
    meta: {
      sizeBytes: served === null ? (response.ContentLength ?? 0) : served.size,
      contentType: knownType(response.Metadata, response.ContentType),
      etag: response.ETag ?? '',
      lastModified: response.LastModified ?? new Date(0),
    },
    range: served === null ? null : { start: served.start, end: served.end },
    body: abortableBody(toWebStream(source), signal),
  };
}

async function readObject(
  target: S3Target,
  key: string,
  readOptions: ReadOptions,
): Promise<ObjectStream | null> {
  const signal = readOptions?.signal;
  signal?.throwIfAborted();
  // A ranged read checks the object's size first, so a bad range fails the same way on every
  // backend and the `Range` header always carries two valid numbers.
  let range: { readonly start: number; readonly end: number } | null = null;
  if (readOptions?.range !== undefined) {
    range = await checkedRange(target, key, readOptions.range);
    if (range === null) return null;
  }
  try {
    const response = await target.client.send(
      new GetObjectCommand({
        Bucket: target.bucket,
        Key: prefixedObjectKey(target.prefix, key),
        ...(range === null ? {} : { Range: `bytes=${range.start}-${range.end}` }),
      }),
      signal === undefined ? {} : { abortSignal: signal },
    );
    return readResult(response, range, signal);
  } catch (error) {
    // An abort is the caller's stop, never a missing object.
    signal?.throwIfAborted();
    if (isMissingObject(error)) return null;
    // The object changed between the size check and the read.
    if (isRangeRefused(error)) throw new RangeNotSatisfiableError();
    throw error;
  }
}

function uploadParams(
  bucket: string,
  objectKey: string,
  source: Readable,
  writeOptions: WriteOptions,
) {
  return {
    Bucket: bucket,
    Key: objectKey,
    Body: source,
    ...(writeOptions.contentType === undefined || writeOptions.contentType === null
      ? {}
      : {
          ContentType: writeOptions.contentType,
          Metadata: { [CONTENT_TYPE_KNOWN]: 'true' },
        }),
    ...(writeOptions.ifNoneMatch === undefined ? {} : { IfNoneMatch: '*' }),
    ...(writeOptions.ifMatch === undefined ? {} : { IfMatch: writeOptions.ifMatch }),
  };
}

async function abortMultipart(
  target: S3Target,
  objectKey: string,
  uploadId: string | undefined,
): Promise<void> {
  if (uploadId === undefined) return;
  // After a failed part the library has already aborted, so this abort may fail with
  // NoSuchUpload; the write's own error is the one to report.
  await target.client
    .send(
      new AbortMultipartUploadCommand({
        Bucket: target.bucket,
        Key: objectKey,
        UploadId: uploadId,
      }),
    )
    .catch(() => undefined);
}

/** The error a failed write reports. */
function writeFailure(error: unknown, source: Readable, ifMatch: string | undefined): unknown {
  // The caller's own body failed: report that, not the library error it caused.
  if (source.errored) return source.errored;
  if (isWriteConflict(error, ifMatch)) return new ObjectConflictError();
  return error;
}

// The AWS upload library, not this code, splits a big body into parts (the storage design,
// §03 and §08): one PutObject up to a part, a multipart upload above it, the preconditions
// forwarded to the final request. The library aborts the upload when a part fails; this code
// aborts it when CompleteMultipartUpload itself fails (a precondition), which the library does
// not.
async function writeObject(
  target: S3Target,
  key: string,
  body: ReadableStream<Uint8Array> | Uint8Array,
  writeOptions: WriteOptions,
): Promise<ObjectMeta> {
  const objectKey = await validatedWriteKey(body, writeOptions, () =>
    prefixedObjectKey(target.prefix, key),
  );
  const counted = countedBody(abortableBody(body, writeOptions.signal));
  const source = toNodeReadable(counted.body);
  // The library takes a controller, not a signal: the caller's signal aborts it, so a part or
  // the completing request the SDK holds is stopped too, not only the body.
  const uploadAbort = new AbortController();
  const stopUpload = (): void => {
    uploadAbort.abort(writeOptions.signal?.reason);
  };
  writeOptions.signal?.addEventListener('abort', stopUpload, { once: true });
  const upload = new Upload({
    client: target.client,
    abortController: uploadAbort,
    queueSize: UPLOAD_QUEUE_SIZE,
    partSize: UPLOAD_PART_BYTES,
    leavePartsOnError: false,
    params: uploadParams(target.bucket, objectKey, source, writeOptions),
  });
  try {
    const done = await upload.done();
    return {
      sizeBytes: counted.sizeBytes(),
      contentType: writeOptions.contentType ?? null,
      etag: done.ETag ?? '',
      lastModified: responseDateOf(done) ?? new Date(),
    };
  } catch (error) {
    await abortMultipart(target, objectKey, upload.uploadId);
    throw writeFailure(error, source, writeOptions.ifMatch);
  } finally {
    writeOptions.signal?.removeEventListener('abort', stopUpload);
    source.destroy(); // cancels the source stream if it was not read to the end
  }
}

/** Each key's stored content type (`null` when unknown or gone), in order, a few at a time. */
async function contentTypesOf(
  target: S3Target,
  keys: readonly string[],
  signal: AbortSignal | undefined,
): Promise<(string | null)[]> {
  const types: (string | null)[] = [];
  for (let from = 0; from < keys.length; from += LIST_HEAD_CONCURRENCY) {
    signal?.throwIfAborted();
    const batch = keys.slice(from, from + LIST_HEAD_CONCURRENCY);
    const metas = await Promise.all(batch.map((key) => headObject(target, key)));
    types.push(...metas.map((meta) => meta?.contentType ?? null));
  }
  return types;
}

async function withContentTypes(
  target: S3Target,
  files: readonly FileRow[],
  listOptions: ListPageOptions | undefined,
): Promise<ObjectListEntry[]> {
  // ListObjectsV2 carries no content type: a caller that reads it pays one HEAD per file, a
  // few at a time; every other listing (a run's delivery, a browse, the catalog's own
  // listings, which read types from their rows) sends none.
  const types =
    listOptions?.contentTypes === true
      ? await contentTypesOf(
          target,
          files.map((file) => file.key),
          listOptions.signal,
        )
      : null;
  return files.map((file, index) => ({
    kind: 'file',
    key: file.key,
    sizeBytes: file.size,
    contentType: types?.[index] ?? null,
    lastModified: file.lastModified,
  }));
}

async function listObjectPage(
  target: S3Target,
  listPrefix: string,
  listOptions: ListPageOptions | undefined,
): Promise<ObjectPage> {
  const requestedPrefix = prefixedListPrefix(target.prefix, listPrefix);
  const response = await target.client.send(
    new ListObjectsV2Command({
      Bucket: target.bucket,
      Prefix: requestedPrefix,
      ...(listOptions?.recursive === true ? {} : { Delimiter: '/' }),
      MaxKeys: clampListLimit(listOptions?.limit),
      ...(listOptions?.cursor === undefined ? {} : { ContinuationToken: listOptions.cursor }),
    }),
    listOptions?.signal === undefined ? {} : { abortSignal: listOptions.signal },
  );
  const entries = [
    ...folderEntries(response, target.prefix),
    ...(await withContentTypes(
      target,
      fileRows(response, target.prefix, requestedPrefix),
      listOptions,
    )),
  ];
  const cursor = pageCursor(response);
  // A recursive page keeps the server's order, which is the order its pages concatenate in;
  // SeaweedFS lists `a/b.txt` before `a-b/c.txt`, unlike AWS. One level, the two arrays are
  // merged in the order the server pages folders and files in.
  if (listOptions?.recursive === true) return { entries, cursor };
  return {
    entries: entries.sort(
      target.listingOrder === 'native' ? compareListingNames : compareEntryKeys,
    ),
    cursor,
  };
}

/** The headers a signed PUT must carry; a GET carries none. */
function signedUrlHeaders(request: SignedUrlRequest): Record<string, string> {
  if (request.method !== 'PUT' || request.contentType === undefined || request.contentType === null)
    return {};
  return { 'content-type': request.contentType, [`x-amz-meta-${CONTENT_TYPE_KNOWN}`]: 'true' };
}

/** The response overrides a signed GET asks the store for. */
function responseOverrides(request: SignedUrlRequest): Record<string, string> {
  const query: Record<string, string> = {};
  if (request.method !== 'GET') return query;
  if (request.responseContentType !== undefined) {
    query['response-content-type'] = request.responseContentType;
  }
  if (request.responseDisposition !== undefined) {
    query['response-content-disposition'] = request.responseDisposition;
  }
  return query;
}

async function signObjectUrl(
  target: S3Target,
  key: string,
  request: SignedUrlRequest,
): Promise<SignedUrl> {
  const location = await objectLocation(target, prefixedObjectKey(target.prefix, key));
  const headers = signedUrlHeaders(request);
  const credentials = await target.client.config.credentials();
  const url = presignS3Url({
    method: request.method,
    ...location,
    region: await target.client.config.region(),
    credentials,
    expiresInSeconds: request.expiresInSeconds ?? PRESIGNED_URL_DEFAULT_TTL_SECONDS,
    // The length is signed but not returned: the HTTP client sets it from the body it sends.
    signedHeaders: {
      ...headers,
      ...(request.method === 'PUT' && request.contentLength !== undefined
        ? { 'content-length': String(request.contentLength) }
        : {}),
    },
    query: responseOverrides(request),
    now: request.now ?? new Date(),
  });
  return { url, headers };
}

async function deleteObject(target: S3Target, key: string): Promise<void> {
  await target.client.send(
    new DeleteObjectCommand({ Bucket: target.bucket, Key: prefixedObjectKey(target.prefix, key) }),
  );
}

async function copyObject(
  target: S3Target,
  sourceKey: string,
  destinationKey: string,
): Promise<void> {
  const sourceFullKey = prefixedObjectKey(target.prefix, sourceKey);
  const destinationFullKey = prefixedObjectKey(target.prefix, destinationKey);
  try {
    await target.client.send(
      new CopyObjectCommand({
        Bucket: target.bucket,
        // The source bucket and key, percent-encoded, per the `CopySource` shape the S3 API
        // itself requires — it is not an ordinary key parameter.
        CopySource: `${target.bucket}/${sourceFullKey.split('/').map(encodeURIComponent).join('/')}`,
        Key: destinationFullKey,
        MetadataDirective: 'COPY',
      }),
    );
  } catch (error) {
    // A missing source is a no-op — see `object-store.ts`'s header for why this is what makes
    // a retried subtree move idempotent rather than an error the second time.
    if (isMissingObject(error)) return;
    throw error;
  }
}

/** Raw S3-compatible backend. Tenant scoping is added by {@link createS3ObjectStoreProvider}. */
export function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStore {
  const bucket = options.bucket.trim();
  if (bucket === '') throw new Error('An S3 object store requires a non-empty bucket name.');
  const target: S3Target = {
    client: options.client,
    bucket,
    prefix: storeKeyPrefix(options.keyPrefix),
    publicEndpoint:
      options.publicEndpoint === undefined
        ? undefined
        : parsePublicEndpoint(options.publicEndpoint),
    listingOrder: options.listingOrder,
  };
  recordResponseDates(options.client);
  return {
    capabilities: {
      sign: true,
      boundLengthSign: true,
      range: true,
      conditionalPut: true,
      fileAndFolderShareKey: true,
    },
    head: (key) => headObject(target, key),
    read: (key, readOptions) => readObject(target, key, readOptions),
    write: (key, body, writeOptions) => writeObject(target, key, body, writeOptions),
    listPage: (listPrefix, listOptions) => listObjectPage(target, listPrefix, listOptions),
    createSignedUrl: (key, request) => signObjectUrl(target, key, request),
    delete: (key) => deleteObject(target, key),
    copy: (sourceKey, destinationKey) => copyObject(target, sourceKey, destinationKey),
  };
}

export function createS3ObjectStoreProvider(options: S3ObjectStoreOptions): ObjectStoreProvider {
  return scopedObjectStoreProvider(createS3ObjectStore(options));
}

/** The S3 client's request handler options for a connection's transport. */
function s3RequestAgents(transport: ConnectionTransport) {
  const agents = connectionAgents(transport, { maxSockets: 50 });
  return { httpAgent: agents.http, httpsAgent: agents.https };
}

function s3ClientFor(
  config: S3ObjectStoreConfig,
  credentials: ReturnType<typeof s3Credentials>,
): S3Client {
  return new S3Client({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
    ...(config.transport === undefined
      ? {}
      : { requestHandler: s3RequestAgents(config.transport) }),
    ...(credentials === undefined ? {} : { credentials }),
  });
}

/** Provisions the bucket where the deployment may, else checks it is reachable unless told not to. */
async function prepareBucket(client: S3Client, config: S3ObjectStoreConfig): Promise<void> {
  if (config.createBucketIfMissing !== false) {
    await ensureS3Bucket(client, config.bucket);
    return;
  }
  if (config.checkBucketOnOpen === false) return;
  // List one key under the prefix instead of HeadBucket: the guide's policy grants s3:ListBucket
  // only with an `s3:prefix` condition, which HeadBucket (no prefix) fails, so a customer
  // following the guide would be refused. A missing bucket is still a 404 (NoSuchBucket).
  const prefix = storeKeyPrefix(config.keyPrefix);
  await client.send(
    new ListObjectsV2Command({
      Bucket: config.bucket,
      MaxKeys: 1,
      ...(prefix === '' ? {} : { Prefix: prefix }),
    }),
  );
}

/** Construct and provision a scoped S3-compatible provider from deployment configuration. */
export async function createS3ObjectStoreProviderFromConfig(
  config: S3ObjectStoreConfig,
  clientOverride?: S3Client,
): Promise<ObjectStoreProvider> {
  return scopedObjectStoreProvider(await createS3ObjectStoreFromConfig(config, clientOverride));
}

/** The same store, unscoped: workspace-agnostic names under `config.keyPrefix`. */
export async function createS3ObjectStoreFromConfig(
  config: S3ObjectStoreConfig,
  clientOverride?: S3Client,
): Promise<ObjectStore> {
  const credentials = s3Credentials(config);
  const client = clientOverride ?? s3ClientFor(config, credentials);
  await prepareBucket(client, config);
  return createS3ObjectStore({
    client,
    bucket: config.bucket,
    ...(config.keyPrefix === undefined ? {} : { keyPrefix: config.keyPrefix }),
    ...(config.publicEndpoint === undefined ? {} : { publicEndpoint: config.publicEndpoint }),
    listingOrder: config.listingOrder ?? listingOrderFor(config.endpoint),
  });
}

/** Idempotently make the configured bucket usable by a fresh Compose/CLI deployment. */
export async function ensureS3Bucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  }
}
