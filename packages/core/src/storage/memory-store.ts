/**
 * An in-memory `ObjectStore` backend: a reference implementation, and the second backend the
 * shared contract suite runs against.
 *
 * ## Why this exists
 *
 * `contract.ts` claims to be backend-agnostic. Until this file existed that claim had exactly one
 * witness — the local filesystem — and a suite with one implementation behind it cannot tell
 * "backend-agnostic" apart from "written against the only backend there is". W2-CP-03's
 * verification round 1 said so in as many words. This module is a second, independent
 * implementation that shares no code with `local-fs-store.ts` (no `node:fs`, no sidecar file, no
 * directory entries — a `Map` and nothing else), so `defineObjectStoreContract` passing against
 * both is evidence the assertions are about the {@link ObjectStore} interface rather than about
 * one implementation's internals.
 *
 * **What this is not.** It is not the S3 backend W2-plan.md's first acceptance criterion
 * asks for, and it is not offered as a substitute for it: that half remains a declared gap, for
 * the reason `docs/adr/W2-CP-03-s3-minio-backend-blocked.md` records (its client dependency
 * cannot be added from inside this task's `Owns` globs). What this backend *does* discharge is
 * the narrower claim the suite itself makes — see `contract.ts`'s "Adding a backend" section,
 * which is the one documented entry point an integration task points a third implementation at.
 *
 * It is also a genuinely useful test double for callers above this package: a suite that needs an
 * `ObjectStore` but not a temporary directory can take this one and stay hermetic.
 *
 * ## The semantics it implements, and where they come from
 *
 * Keys are opaque strings in a flat map; a "folder" is a prefix, exactly as in S3 and exactly as
 * `object-store.ts` documents (`list` is one level, `Delimiter: '/'`-style, and `put` creates no
 * folder because there is nothing to create). Keys are validated by the same `key-safety.ts`
 * guard the other backend uses, on the full key — this is the same "second call site" role
 * `local-fs-store.ts`'s header describes, so a backend reached directly, bypassing
 * `createScopedObjectStore`, is not left unguarded here either.
 *
 * Bytes are copied in on `put` and copied out on `get`, so a caller mutating the array it handed
 * over — or the one it got back — cannot reach into the store. The local-filesystem backend gets
 * that property from the filesystem for free; a `Map` does not, and a contract assertion about
 * byte-identical round-trips would otherwise pass here for the wrong reason.
 */
import { toObjectKey, toObjectPrefix } from './key-safety.js';
import {
  scopedObjectStoreProvider,
  ObjectConflictError,
  validatedWriteKey,
  type ObjectListEntry,
  type ObjectMeta,
  type ObjectStore,
  type ObjectStoreProvider,
  type WriteOptions,
  compareEntryKeys,
} from './object-store.js';
import { abortableBody, listPageFrom, resolveRange, streamToBytes } from './streams.js';

interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string | null;
  readonly lastModified: Date;
  readonly etag: string;
}

/**
 * One in-memory {@link ObjectStore} over a fresh `Map`. `key` here is the *full* key, the same way
 * `createLocalFilesystemObjectStore`'s is — `createScopedObjectStore` is what adds a workspace
 * prefix, and {@link createInMemoryObjectStoreProvider} is the wrapped form to use in a fixture.
 */
export function createInMemoryObjectStore(): ObjectStore {
  const objects = new Map<string, StoredObject>();
  let version = 0;
  const metaOf = (object: StoredObject): ObjectMeta => ({
    sizeBytes: object.body.byteLength,
    contentType: object.contentType,
    etag: object.etag,
    lastModified: object.lastModified,
  });
  const store = (safeKey: string, body: Uint8Array, contentType: string | null): StoredObject => {
    version += 1;
    const object = {
      body: Uint8Array.from(body),
      contentType,
      lastModified: new Date(),
      etag: `"${version}"`,
    };
    objects.set(safeKey, object);
    return object;
  };

  const listing = {
    level(prefix): Promise<readonly ObjectListEntry[]> {
      const safePrefix = toObjectPrefix(prefix);
      // `''` means the root, and the root has no trailing separator to strip.
      const scan = safePrefix === '' ? '' : `${safePrefix}/`;
      const files: ObjectListEntry[] = [];
      const folders = new Set<string>();
      for (const [key, value] of objects) {
        if (!key.startsWith(scan)) continue;
        const remainder = key.slice(scan.length);
        const cut = remainder.indexOf('/');
        if (cut === -1) {
          files.push({
            kind: 'file',
            key,
            sizeBytes: value.body.byteLength,
            contentType: value.contentType,
            lastModified: value.lastModified,
          });
          continue;
        }
        // One level only: everything deeper is reported as the folder that contains it, once.
        folders.add(`${scan}${remainder.slice(0, cut)}`);
      }
      const entries: ObjectListEntry[] = [
        ...files,
        ...[...folders].map((key): ObjectListEntry => ({ kind: 'folder', key })),
      ];
      return Promise.resolve(entries.sort(compareEntryKeys));
    },

    tree(prefix): Promise<readonly ObjectListEntry[]> {
      const safePrefix = toObjectPrefix(prefix);
      const matches = (key: string): boolean =>
        safePrefix === '' || key === safePrefix || key.startsWith(`${safePrefix}/`);
      const entries: ObjectListEntry[] = [];
      for (const [key, value] of objects) {
        if (!matches(key)) continue;
        entries.push({
          kind: 'file',
          key,
          sizeBytes: value.body.byteLength,
          contentType: value.contentType,
          lastModified: value.lastModified,
        });
      }
      return Promise.resolve(entries.sort(compareEntryKeys));
    },
  } satisfies Parameters<typeof listPageFrom>[0];

  const backend: ObjectStore = {
    capabilities: {
      sign: false,
      boundLengthSign: false,
      range: true,
      conditionalPut: true,
      fileAndFolderShareKey: true,
    },

    head(key): Promise<ObjectMeta | null> {
      const found = objects.get(toObjectKey(key));
      return Promise.resolve(found === undefined ? null : metaOf(found));
    },

    read(key, options) {
      options?.signal?.throwIfAborted();
      const found = objects.get(toObjectKey(key));
      if (found === undefined) return Promise.resolve(null);
      const range = resolveRange(options?.range, found.body.byteLength);
      const bytes = range === null ? found.body : found.body.subarray(range.start, range.end + 1);
      return Promise.resolve({
        meta: metaOf(found),
        range,
        body: abortableBody(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Uint8Array.from(bytes));
              controller.close();
            },
          }),
          options?.signal,
        ),
      });
    },

    async write(key, body, options: WriteOptions): Promise<ObjectMeta> {
      const safeKey = await validatedWriteKey(body, options, () => toObjectKey(key));
      const source = abortableBody(body, options.signal);
      const bytes = source instanceof Uint8Array ? source : await streamToBytes(source);
      const current = objects.get(safeKey);
      if (options.ifNoneMatch === '*' && current !== undefined) throw new ObjectConflictError();
      if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) {
        throw new ObjectConflictError();
      }
      return metaOf(store(safeKey, bytes, options.contentType ?? null));
    },

    listPage: (prefix, options) => listPageFrom(listing, prefix, options),

    delete(key): Promise<void> {
      const safeKey = toObjectKey(key);
      // Deleting a missing key is success, not an error — R-15 §1c, asserted by the contract suite
      // against every backend.
      objects.delete(safeKey);
      return Promise.resolve();
    },

    copy(sourceKey, destinationKey): Promise<void> {
      const safeSource = toObjectKey(sourceKey);
      const safeDestination = toObjectKey(destinationKey);
      const found = objects.get(safeSource);
      // A missing source is a no-op — see `object-store.ts`'s header for why this is what makes a
      // retried subtree move idempotent rather than an error the second time.
      if (found === undefined) return Promise.resolve();
      store(safeDestination, found.body, found.contentType);
      return Promise.resolve();
    },
  };
  return backend;
}

/**
 * The in-memory {@link ObjectStoreProvider}: every workspace gets its own key prefix inside one
 * shared map, via {@link scopedObjectStoreProvider} — the same wrapper the local-filesystem
 * provider uses, so "which workspace this key belongs to" is decided in one place for both.
 */
export function createInMemoryObjectStoreProvider(): ObjectStoreProvider {
  return scopedObjectStoreProvider(createInMemoryObjectStore());
}
