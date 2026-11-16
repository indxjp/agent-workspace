// An in-memory GcsClient for the offline GCS tests. It imports no `@google-cloud/*` module: the
// SDK-boundary rule exempts `.test.` files, not `*.test-support.ts`.
import type { GcsClient, GcsStoredObject } from './gcs-safe-client.js';
import { ObjectConflictError, type ByteRange, type WriteOptions } from './object-store.js';
import { bytesToStream, resolveRange, streamToBytes } from './streams.js';

export interface FakeObject {
  readonly body: Uint8Array;
  readonly contentType: string | null;
  readonly contentTypeKnown: boolean;
  readonly lastModified: Date;
  readonly generation: number;
}

type ListPageOptions = Parameters<GcsClient['listPage']>[1];
type ListedPage = Awaited<ReturnType<GcsClient['listPage']>>;

/** The fake bucket: its objects, and a clock that stamps each write's time and generation. */
interface FakeBucket {
  readonly objects: Map<string, FakeObject>;
  clock: number;
}

// Like a GCS page token, the cursor does not expose the object name it resumes after.
const encodeCursor = (name: string): string => Buffer.from(name).toString('base64url');
const decodeCursor = (cursor: string): string => Buffer.from(cursor, 'base64url').toString();

const metadata = (name: string, object: FakeObject): GcsStoredObject => ({
  name,
  sizeBytes: object.body.byteLength,
  contentType: object.contentType,
  contentTypeKnown: object.contentTypeKnown,
  lastModified: object.lastModified,
  etag: String(object.generation),
});

/** Advances the clock and returns the time and generation of the next stored object. */
function nextStamp(bucket: FakeBucket): Pick<FakeObject, 'lastModified' | 'generation'> {
  bucket.clock += 1;
  return { lastModified: new Date(bucket.clock * 1_000), generation: bucket.clock };
}

function copyObject(bucket: FakeBucket, sourceName: string, destinationName: string): void {
  const source = bucket.objects.get(sourceName);
  if (source === undefined) return;
  bucket.objects.set(destinationName, {
    ...source,
    body: Uint8Array.from(source.body),
    ...nextStamp(bucket),
  });
}

function readObject(
  bucket: FakeBucket,
  name: string,
  range: ByteRange | undefined,
): Awaited<ReturnType<GcsClient['readStream']>> {
  const object = bucket.objects.get(name);
  if (object === undefined) return null;
  const served = resolveRange(range, object.body.byteLength);
  const bytes = served === null ? object.body : object.body.slice(served.start, served.end + 1);
  return { object: metadata(name, object), body: bytesToStream(bytes) };
}

async function writeObject(
  bucket: FakeBucket,
  name: string,
  body: ReadableStream<Uint8Array> | Uint8Array,
  options: WriteOptions,
): Promise<GcsStoredObject> {
  const bytes = body instanceof Uint8Array ? body : await streamToBytes(body);
  const current = bucket.objects.get(name);
  if (options.ifNoneMatch === '*' && current !== undefined) throw new ObjectConflictError();
  if (options.ifMatch !== undefined && String(current?.generation) !== options.ifMatch) {
    throw new ObjectConflictError();
  }
  const stored: FakeObject = {
    body: Uint8Array.from(bytes),
    contentType: options.contentType ?? null,
    contentTypeKnown: options.contentType !== undefined && options.contentType !== null,
    ...nextStamp(bucket),
  };
  bucket.objects.set(name, stored);
  return metadata(name, stored);
}

/** The files directly listed under `prefix`, and the folders a delimited listing rolls up. */
function partitionUnder(
  objects: ReadonlyMap<string, FakeObject>,
  prefix: string,
  delimiter: boolean,
): { files: Map<string, FakeObject>; folders: Set<string> } {
  const files = new Map<string, FakeObject>();
  const folders = new Set<string>();
  for (const [name, object] of objects) {
    if (!name.startsWith(prefix)) continue;
    const slash = name.slice(prefix.length).indexOf('/');
    if (delimiter && slash >= 0) {
      folders.add(`${prefix}${name.slice(prefix.length, prefix.length + slash)}/`);
    } else {
      files.set(name, object);
    }
  }
  return { files, folders };
}

function listObjectPage(bucket: FakeBucket, prefix: string, options: ListPageOptions): ListedPage {
  const { files, folders } = partitionUnder(bucket.objects, prefix, options.delimiter);
  // Pages hold files and folders together, ordered by name; the cursor resumes after one name.
  const after = options.cursor === undefined ? '' : decodeCursor(options.cursor);
  const rows = [...files.keys(), ...folders].sort().filter((row) => row > after);
  const page = rows.slice(0, options.limit);
  const last = page[page.length - 1];
  return {
    objects: page.flatMap((row) => {
      const object = files.get(row);
      return object === undefined ? [] : [metadata(row, object)];
    }),
    folders: page.filter((row) => !files.has(row)),
    cursor: rows.length > options.limit && last !== undefined ? encodeCursor(last) : null,
  };
}

export function createFakeGcsClient(): GcsClient & { readonly objects: Map<string, FakeObject> } {
  const bucket: FakeBucket = { objects: new Map<string, FakeObject>(), clock: 0 };
  return {
    objects: bucket.objects,
    delete(name: string): Promise<void> {
      bucket.objects.delete(name);
      return Promise.resolve();
    },
    copy(sourceName: string, destinationName: string): Promise<void> {
      copyObject(bucket, sourceName, destinationName);
      return Promise.resolve();
    },
    head(name) {
      const object = bucket.objects.get(name);
      return Promise.resolve(object === undefined ? null : metadata(name, object));
    },
    readStream: (name, range) => Promise.resolve(readObject(bucket, name, range)),
    writeStream: (name, body, options) => writeObject(bucket, name, body, options),
    listPage: (prefix, options) => Promise.resolve(listObjectPage(bucket, prefix, options)),
  };
}
