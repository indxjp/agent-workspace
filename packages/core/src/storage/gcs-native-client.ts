/**
 * The adapter from the official `@google-cloud/storage` bucket to the small protocol in
 * `gcs-safe-client.ts`: one function per operation, each reading or writing through the SDK and
 * mapping its metadata and failures to that protocol's.
 */
import type { Bucket, File, FileMetadata } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  CONTENT_TYPE_KNOWN_METADATA_KEY,
  errorCode,
  GcsBucketUnavailableError,
  GcsIntegrityError,
  gcsExtensionHeaders,
  generationPrecondition,
  isMissingBucket,
  isNotFound,
  listedPrefixes,
  md5Tap,
  nativeListingPrefix,
  safeGcsClient,
  signedContentType,
  uploadMetadata,
  writeFailure,
  type GcsClient,
  type GcsStoredObject,
} from './gcs-safe-client.js';
import { addressableObjectName, toObjectKey } from './key-safety.js';
import {
  PRESIGNED_URL_DEFAULT_TTL_SECONDS,
  SignedUrlUnsupportedError,
  type ByteRange,
  type SignedUrl,
  type SignedUrlRequest,
  type WriteOptions,
} from './object-store.js';
import { resolveRange, toNodeReadable, toWebStream } from './streams.js';

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

async function headObject(bucket: Bucket, name: string): Promise<GcsStoredObject | null> {
  const file = bucket.file(toObjectKey(name));
  try {
    const [metadata] = await file.getMetadata();
    return metadataFor(file, metadata);
  } catch (error) {
    if (objectNotFound(bucket, error)) return null;
    throw error;
  }
}

/** The SDK's stream takes no signal; destroying it ends the media request. */
function destroyOnAbort(source: Readable, signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  const stop = (): void => {
    source.destroy();
  };
  signal.addEventListener('abort', stop, { once: true });
  source.once('close', () => signal.removeEventListener('abort', stop));
}

async function readObjectStream(
  bucket: Bucket,
  name: string,
  range: ByteRange | undefined,
  signal: AbortSignal | undefined,
): Promise<{ object: GcsStoredObject; body: ReadableStream<Uint8Array> } | null> {
  const object = await headObject(bucket, name);
  if (object === null) return null;
  const served = resolveRange(range, object.sizeBytes);
  // Pinned to the generation just described, so `meta.etag` and the bytes are one version.
  // `end` is inclusive in createReadStream, as in `ByteRange`. `decompress: false` keeps a
  // gzip-encoded object's stored bytes: the SDK would gunzip them, so the stream would no longer
  // match the `sizeBytes` the head reported (delivery then fails as "changed size").
  const source = bucket.file(toObjectKey(name), { generation: object.etag }).createReadStream({
    decompress: false,
    ...(served === null ? {} : { start: served.start, end: served.end }),
  });
  destroyOnAbort(source, signal);
  return { object, body: toWebStream(source) };
}

async function writeObjectStream(
  bucket: Bucket,
  name: string,
  body: ReadableStream<Uint8Array> | Uint8Array,
  options: WriteOptions,
): Promise<GcsStoredObject> {
  const file = bucket.file(toObjectKey(name));
  const source = toNodeReadable(body);
  try {
    const generation = generationPrecondition(options);
    // MD5, not CRC32C: the SDK's CRC32C transform grew the process RSS by about 25 MiB more
    // over a 1 GiB stream to a slow server (61 MiB against 35 MiB without validation; MD5 39),
    // which broke the 64 MiB flat-memory budget on CI (the storage design, §07 "Load test").
    // A single-request upload is a non-composite object, so GCS returns its md5Hash to check.
    // Resumable is no better: 8 MiB chunks measured 178 MiB. The hash is taken here, not by
    // the SDK's `validation`, because the SDK deletes a mismatch with no precondition.
    const md5 = createHash('md5');
    await pipeline(
      source,
      md5Tap(md5),
      file.createWriteStream({
        resumable: false,
        validation: false,
        ...(generation === undefined
          ? {}
          : { preconditionOpts: { ifGenerationMatch: generation } }),
        metadata: uploadMetadata(options),
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
    throw writeFailure(source, error);
  } finally {
    source.destroy(); // cancels the source stream if it was not read to the end
  }
}

async function listObjectPage(
  bucket: Bucket,
  prefix: string,
  options: Parameters<GcsClient['listPage']>[1],
): ReturnType<GcsClient['listPage']> {
  const [files, next, response] = await bucket.getFiles({
    prefix: nativeListingPrefix(prefix),
    autoPaginate: false,
    maxResults: options.limit,
    ...(options.delimiter ? { delimiter: '/' } : {}),
    ...(options.cursor === undefined ? {} : { pageToken: options.cursor }),
  });
  return {
    objects: files
      .filter((file) => addressableObjectName(file.name) !== null)
      .map((file) => metadataFor(file, file.metadata)),
    folders: listedPrefixes(response),
    cursor: next?.pageToken ?? null,
  };
}

async function signObjectUrl(
  bucket: Bucket,
  name: string,
  request: SignedUrlRequest,
): Promise<SignedUrl> {
  const contentType = signedContentType(request);
  const extensionHeaders = gcsExtensionHeaders(request, contentType);
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
    action: request.method === 'PUT' ? 'write' : 'read',
    // The window starts at the requested instant, as on S3 and Azure, not at this host's clock.
    accessibleAt: now,
    expires,
    extensionHeaders,
    ...(contentType === undefined ? {} : { contentType }),
    ...(request.responseContentType === undefined
      ? {}
      : { responseType: request.responseContentType }),
    ...(request.responseDisposition === undefined
      ? {}
      : { responseDisposition: request.responseDisposition }),
  });
  return {
    url,
    headers:
      contentType === undefined
        ? extensionHeaders
        : { 'content-type': contentType, ...extensionHeaders },
  };
}

async function deleteObject(bucket: Bucket, name: string): Promise<void> {
  try {
    await bucket.file(toObjectKey(name)).delete({ ignoreNotFound: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function copyObject(
  bucket: Bucket,
  sourceName: string,
  destinationName: string,
): Promise<void> {
  try {
    await bucket.file(toObjectKey(sourceName)).copy(bucket.file(toObjectKey(destinationName)));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/** Adapt the official client to the small protocol in `gcs-safe-client.ts`; authentication stays ADC-owned. */
export function createNativeGcsClient(bucket: Bucket): GcsClient {
  return safeGcsClient({
    head: (name) => headObject(bucket, name),
    readStream: (name, range, signal) => readObjectStream(bucket, name, range, signal),
    writeStream: (name, body, options) => writeObjectStream(bucket, name, body, options),
    listPage: (prefix, options) => listObjectPage(bucket, prefix, options),
    delete: (name) => deleteObject(bucket, name),
    signUrl: (name, request) => signObjectUrl(bucket, name, request),
    copy: (sourceName, destinationName) => copyObject(bucket, sourceName, destinationName),
  });
}
