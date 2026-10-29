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
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { isHttpEndpoint } from '@indx-workspace/contracts/storage-url';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';

import {
  addressableObjectName,
  prefixedListPrefix,
  prefixedObjectKey,
  storeKeyPrefix,
} from './key-safety.js';
import {
  scopedObjectStoreProvider,
  type ObjectListEntry,
  type ObjectMeta,
  type ObjectStore,
  type ObjectStoreProvider,
  type SignedUrl,
  clampListLimit,
  compareEntryKeys,
  compareListingNames,
  ObjectConflictError,
  validatedWriteKey,
  PRESIGNED_URL_DEFAULT_TTL_SECONDS,
  RangeNotSatisfiableError,
} from './object-store.js';
import { presignS3Url } from './s3-presign.js';
import { countedBody, resolveRange, toNodeReadable, toWebStream } from './streams.js';

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

type S3ListingOrder = 'bare-key' | 'native';

export interface S3ObjectStoreConfig {
  readonly endpoint?: string;
  /** The host signed links name; the server's own calls keep `endpoint`. */
  readonly publicEndpoint?: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  /** Temporary (STS) credentials only: sent with the key pair above, ignored without it. */
  readonly sessionToken?: string;
  readonly forcePathStyle?: boolean;
  readonly keyPrefix?: string;
  /** Development endpoints may provision their bucket; native cloud deployments must not. */
  readonly createBucketIfMissing?: boolean;
  /**
   * `false` skips the one-key listing an open otherwise sends when `createBucketIfMissing` is
   * false. A connection store sets it: its key may list only under an allowed folder, which the
   * store's own prefix need not be, so the connection's first listing of that folder is the check.
   */
  readonly checkBucketOnOpen?: boolean;
  /** Resolves every hostname the client dials; a connection store answers only with checked addresses. */
  readonly lookup?: LookupFunction;
  /**
   * See {@link S3ObjectStoreOptions.listingOrder}. Left out, it follows `endpoint`: none, or an
   * `amazonaws.com` host, is AWS (`native`); any other endpoint is `bare-key`.
   */
  readonly listingOrder?: S3ListingOrder;
}

const AWS_HOST = /(?:^|\.)amazonaws\.com(?:\.cn)?$/u;

function listingOrderFor(endpoint: string | undefined): S3ListingOrder {
  if (endpoint === undefined) return 'native';
  return AWS_HOST.test(new URL(endpoint).hostname) ? 'native' : 'bare-key';
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorName(error) === 'NoSuchKey' || httpStatus(error) === 404;
}

/**
 * A 404 for the object, not for its bucket. A bucket deleted under a store is an outage a caller
 * must see, never an absent object. A HEAD has no body to name the bucket, so only a request that
 * carries an error body (GET, copy, delete) can tell the two apart.
 */
function isMissingObject(error: unknown): boolean {
  return isNotFound(error) && errorName(error) !== 'NoSuchBucket';
}

function isRangeRefused(error: unknown): boolean {
  return httpStatus(error) === 416 || errorName(error) === 'InvalidRange';
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    httpStatus(error) === 412 ||
    errorName(error) === 'PreconditionFailed' ||
    errorName(error) === 'ConditionalRequestConflict'
  );
}

function knownType(
  metadata: Record<string, string> | undefined,
  contentType: string | undefined,
): string | null {
  return metadata?.['aw-content-type-known'] === 'true' ? (contentType ?? null) : null;
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

// One part in flight keeps a write's memory near UPLOAD_PART_BYTES whatever the object size.
// The S3 minimum part size: at 8 MiB the 256 MiB load case reached 64.6 MiB of RSS growth on CI.
const UPLOAD_PART_BYTES = 5 * 1024 * 1024;
const UPLOAD_QUEUE_SIZE = 1;

/** The scheme, host and path a presigned URL names: the public endpoint when set, else where the client sends requests. */
async function objectLocation(
  client: S3Client,
  bucket: string,
  objectKey: string,
  publicEndpoint: URL | undefined,
): Promise<{ scheme: 'http' | 'https'; host: string; path: string }> {
  const region = await client.config.region();
  const endpoint =
    publicEndpoint !== undefined
      ? {
          protocol: publicEndpoint.protocol,
          hostname: publicEndpoint.hostname,
          port: publicEndpoint.port === '' ? undefined : Number(publicEndpoint.port),
          path: publicEndpoint.pathname,
        }
      : client.config.endpoint === undefined
        ? undefined
        : await client.config.endpoint();
  const pathStyle =
    client.config.forcePathStyle === true || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket);
  const scheme =
    endpoint === undefined ? 'https' : endpoint.protocol === 'http:' ? 'http' : 'https';
  const baseHost =
    endpoint === undefined
      ? `s3.${region}.amazonaws.com`
      : `${endpoint.hostname}${endpoint.port === undefined ? '' : `:${endpoint.port}`}`;
  const basePath = (endpoint?.path ?? '').replace(/\/+$/u, '');
  return pathStyle
    ? { scheme, host: baseHost, path: `${basePath}/${bucket}/${objectKey}` }
    : { scheme, host: `${bucket}.${baseHost}`, path: `${basePath}/${objectKey}` };
}

function parsePublicEndpoint(value: string): URL {
  // The value itself is never repeated in the message.
  if (!isHttpEndpoint(value)) {
    throw new Error(
      'publicEndpoint must be an http or https URL without credentials, query, or fragment.',
    );
  }
  return new URL(value);
}

/** Raw S3-compatible backend. Tenant scoping is added by {@link createS3ObjectStoreProvider}. */
export function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStore {
  const bucket = options.bucket.trim();
  if (bucket === '') throw new Error('An S3 object store requires a non-empty bucket name.');
  const prefix = storeKeyPrefix(options.keyPrefix);
  const publicEndpoint =
    options.publicEndpoint === undefined ? undefined : parsePublicEndpoint(options.publicEndpoint);

  recordResponseDates(options.client);
  // After a HEAD 404: throws for a missing bucket, which only a GET's error body names. An object
  // written since the HEAD leaves its answer standing, and the one byte served is discarded.
  const confirmMissingObject = async (key: string): Promise<void> => {
    try {
      const response = await options.client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: prefixedObjectKey(prefix, key),
          Range: 'bytes=0-0',
        }),
      );
      (response.Body as Readable | undefined)?.destroy();
    } catch (error) {
      // An empty object written since the HEAD refuses even the first byte.
      if (isMissingObject(error) || isRangeRefused(error)) return;
      throw error;
    }
  };
  const backend: ObjectStore = {
    capabilities: {
      sign: true,
      boundLengthSign: true,
      range: true,
      conditionalPut: true,
      fileAndFolderShareKey: true,
    },

    async head(key): Promise<ObjectMeta | null> {
      try {
        const response = await options.client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: prefixedObjectKey(prefix, key) }),
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
    },

    async read(key, readOptions) {
      // A ranged read checks the object's size first, so a bad range fails the same way on every
      // backend and the `Range` header always carries two valid numbers.
      let range: { readonly start: number; readonly end: number } | null = null;
      if (readOptions?.range !== undefined) {
        const meta = await backend.head(key);
        if (meta === null) {
          // A HEAD 404 has no body to name a missing bucket; a one-byte GET's error body does.
          await confirmMissingObject(key);
          return null;
        }
        range = resolveRange(readOptions.range, meta.sizeBytes);
      }
      try {
        const response = await options.client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: prefixedObjectKey(prefix, key),
            ...(range === null ? {} : { Range: `bytes=${range.start}-${range.end}` }),
          }),
        );
        if (response.Body === undefined) return null;
        const source = response.Body as Readable;
        // `Content-Range: bytes 2-5/10` carries both the served range and the whole size.
        const served = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.ContentRange ?? '');
        if (range !== null && served === null) {
          source.destroy();
          throw new Error('S3 ignored the requested byte range.');
        }
        return {
          meta: {
            sizeBytes: served === null ? (response.ContentLength ?? 0) : Number(served[3]),
            contentType: knownType(response.Metadata, response.ContentType),
            etag: response.ETag ?? '',
            lastModified: response.LastModified ?? new Date(0),
          },
          range: served === null ? null : { start: Number(served[1]), end: Number(served[2]) },
          body: toWebStream(source),
        };
      } catch (error) {
        if (isMissingObject(error)) return null;
        // The object changed between the size check and the read.
        if (isRangeRefused(error)) throw new RangeNotSatisfiableError();
        throw error;
      }
    },

    // The AWS upload library, not this code, splits a big body into parts (the storage design,
    // §03 and §08): one PutObject up to a part, a multipart upload above it, the preconditions
    // forwarded to the final request. The library aborts the upload when a part fails; this code
    // aborts it when CompleteMultipartUpload itself fails (a precondition), which the library does
    // not.
    async write(key, body, writeOptions): Promise<ObjectMeta> {
      const objectKey = await validatedWriteKey(body, writeOptions, () =>
        prefixedObjectKey(prefix, key),
      );
      const counted = countedBody(body);
      const source = toNodeReadable(counted.body);
      const upload = new Upload({
        client: options.client,
        queueSize: UPLOAD_QUEUE_SIZE,
        partSize: UPLOAD_PART_BYTES,
        leavePartsOnError: false,
        params: {
          Bucket: bucket,
          Key: objectKey,
          Body: source,
          ...(writeOptions.contentType === undefined || writeOptions.contentType === null
            ? {}
            : {
                ContentType: writeOptions.contentType,
                Metadata: { 'aw-content-type-known': 'true' },
              }),
          ...(writeOptions.ifNoneMatch === undefined ? {} : { IfNoneMatch: '*' }),
          ...(writeOptions.ifMatch === undefined ? {} : { IfMatch: writeOptions.ifMatch }),
        },
      });
      try {
        const done = await upload.done();
        const etag = done.ETag ?? '';
        return {
          sizeBytes: counted.sizeBytes(),
          contentType: writeOptions.contentType ?? null,
          etag,
          lastModified: responseDateOf(done) ?? new Date(),
        };
      } catch (error) {
        if (upload.uploadId !== undefined) {
          // After a failed part the library has already aborted, so this abort may fail with
          // NoSuchUpload; the write's own error is the one to report.
          await options.client
            .send(
              new AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: objectKey,
                UploadId: upload.uploadId,
              }),
            )
            .catch(() => undefined);
        }
        // The caller's own body failed: report that, not the library error it caused.
        if (source.errored) throw source.errored;
        // A failed If-Match on a missing key is a 404 on S3; to the caller it is the same conflict.
        // A missing bucket or upload is a deployment fault, not a stale etag.
        const missingKey =
          isNotFound(error) &&
          errorName(error) !== 'NoSuchBucket' &&
          errorName(error) !== 'NoSuchUpload';
        if (isPreconditionFailure(error) || (writeOptions.ifMatch !== undefined && missingKey)) {
          throw new ObjectConflictError();
        }
        throw error;
      } finally {
        source.destroy(); // cancels the source stream if it was not read to the end
      }
    },

    async listPage(listPrefix, listOptions) {
      const requestedPrefix = prefixedListPrefix(prefix, listPrefix);
      const response = await options.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: requestedPrefix,
          ...(listOptions?.recursive === true ? {} : { Delimiter: '/' }),
          MaxKeys: clampListLimit(listOptions?.limit),
          ...(listOptions?.cursor === undefined ? {} : { ContinuationToken: listOptions.cursor }),
        }),
        listOptions?.signal === undefined ? {} : { abortSignal: listOptions.signal },
      );
      const entries: ObjectListEntry[] = [];
      for (const folder of response.CommonPrefixes ?? []) {
        if (folder.Prefix === undefined) continue;
        const key = folder.Prefix.slice(prefix.length).replace(/\/$/u, '');
        if (addressableObjectName(key) === null) continue;
        entries.push({ kind: 'folder', key });
      }
      for (const object of response.Contents ?? []) {
        if (object.Key === undefined || object.Key === requestedPrefix) continue;
        // Another tool's name (a console folder's `name/`): skip it before HEAD refuses it.
        if (addressableObjectName(object.Key.slice(prefix.length)) === null) continue;
        // ponytail: one HEAD per file for its content type; drop once the catalog is the
        // listing's source of truth.
        listOptions?.signal?.throwIfAborted();
        const meta = await backend.head(object.Key.slice(prefix.length));
        entries.push({
          kind: 'file',
          key: object.Key.slice(prefix.length),
          sizeBytes: object.Size ?? 0,
          contentType: meta?.contentType ?? null,
          lastModified: object.LastModified ?? new Date(0),
        });
      }
      const cursor =
        response.IsTruncated === true ? (response.NextContinuationToken ?? null) : null;
      if (response.IsTruncated === true && cursor === null) {
        throw new Error('S3 returned a truncated listing without a continuation token.');
      }
      // A recursive page keeps the server's order, which is the order its pages concatenate in;
      // SeaweedFS lists `a/b.txt` before `a-b/c.txt`, unlike AWS. One level, the two arrays are
      // merged in the order the server pages folders and files in.
      if (listOptions?.recursive === true) return { entries, cursor };
      return {
        entries: entries.sort(
          options.listingOrder === 'native' ? compareListingNames : compareEntryKeys,
        ),
        cursor,
      };
    },

    async createSignedUrl(key, request): Promise<SignedUrl> {
      const location = await objectLocation(
        options.client,
        bucket,
        prefixedObjectKey(prefix, key),
        publicEndpoint,
      );
      const hasContentType = request.contentType !== undefined && request.contentType !== null;
      const headers: Record<string, string> =
        request.method === 'PUT' && hasContentType
          ? { 'content-type': request.contentType, 'x-amz-meta-aw-content-type-known': 'true' }
          : {};
      const query: Record<string, string> = {};
      if (request.method === 'GET') {
        if (request.responseContentType !== undefined) {
          query['response-content-type'] = request.responseContentType;
        }
        if (request.responseDisposition !== undefined) {
          query['response-content-disposition'] = request.responseDisposition;
        }
      }
      const credentials = await options.client.config.credentials();
      const url = presignS3Url({
        method: request.method,
        ...location,
        region: await options.client.config.region(),
        credentials,
        expiresInSeconds: request.expiresInSeconds ?? PRESIGNED_URL_DEFAULT_TTL_SECONDS,
        // The length is signed but not returned: the HTTP client sets it from the body it sends.
        signedHeaders: {
          ...headers,
          ...(request.method === 'PUT' && request.contentLength !== undefined
            ? { 'content-length': String(request.contentLength) }
            : {}),
        },
        query,
        now: request.now ?? new Date(),
      });
      return { url, headers };
    },

    async delete(key): Promise<void> {
      await options.client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: prefixedObjectKey(prefix, key) }),
      );
    },

    async copy(sourceKey, destinationKey): Promise<void> {
      const sourceFullKey = prefixedObjectKey(prefix, sourceKey);
      const destinationFullKey = prefixedObjectKey(prefix, destinationKey);
      try {
        await options.client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            // The source bucket and key, percent-encoded, per the `CopySource` shape the S3 API
            // itself requires — it is not an ordinary key parameter.
            CopySource: `${bucket}/${sourceFullKey.split('/').map(encodeURIComponent).join('/')}`,
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
    },
  };
  return backend;
}

export function createS3ObjectStoreProvider(options: S3ObjectStoreOptions): ObjectStoreProvider {
  return scopedObjectStoreProvider(createS3ObjectStore(options));
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
  const hasAccessKey = config.accessKeyId !== undefined && config.accessKeyId.trim() !== '';
  const hasSecret = config.secretAccessKey !== undefined && config.secretAccessKey.trim() !== '';
  if (hasAccessKey !== hasSecret) {
    throw new Error('S3 access key id and secret access key must be configured together.');
  }
  const client =
    clientOverride ??
    new S3Client({
      region: config.region,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
      ...(config.lookup === undefined
        ? {}
        : {
            requestHandler: {
              httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 50, lookup: config.lookup }),
              httpsAgent: new HttpsAgent({
                keepAlive: true,
                maxSockets: 50,
                lookup: config.lookup,
              }),
            },
          }),
      ...(hasAccessKey && hasSecret
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
              ...(config.sessionToken === undefined || config.sessionToken.trim() === ''
                ? {}
                : { sessionToken: config.sessionToken }),
            },
          }
        : {}),
    });
  if (config.createBucketIfMissing === false) {
    if (config.checkBucketOnOpen !== false) {
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
  } else {
    await ensureS3Bucket(client, config.bucket);
  }
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
