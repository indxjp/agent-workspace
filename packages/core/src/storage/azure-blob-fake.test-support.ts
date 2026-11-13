/**
 * What the Azure Blob store tests share: an in-memory {@link AzureBlobContainer} that keeps the
 * protocol's semantics (etags, conditions, Azure's listing order), and a paging helper.
 */
import type { ObjectContent, ObjectMeta, ObjectStore } from './object-store.js';
import type {
  AzureBlobContainer,
  AzureBlobEntry,
  AzureBlobListOptions,
} from './azure-blob-protocol.js';
import { bytesToStream, streamToBytes } from './streams.js';

type FakeBlob = ObjectContent & { readonly etag: string };

/** Rows keyed by Azure's listing name (a folder as `name/`), so paging follows Azure's order. */
function fakeListRows(
  values: ReadonlyMap<string, FakeBlob>,
  prefix: string,
  delimiter: boolean,
): Map<string, AzureBlobEntry> {
  // A file and a folder of one name both survive.
  const rows = new Map<string, AzureBlobEntry>();
  for (const [name, value] of values) {
    if (!name.startsWith(prefix) || name === prefix) continue;
    const separator = delimiter ? name.indexOf('/', prefix.length) : -1;
    if (separator >= 0) {
      const folder = name.slice(0, separator);
      rows.set(`${folder}/`, { kind: 'folder', name: folder });
    } else {
      rows.set(name, {
        kind: 'file',
        name,
        sizeBytes: value.sizeBytes,
        contentType: value.contentType,
        lastModified: value.lastModified,
      });
    }
  }
  return rows;
}

function fakeListPage(
  values: ReadonlyMap<string, FakeBlob>,
  prefix: string,
  { delimiter, cursor, limit }: AzureBlobListOptions,
): { entries: AzureBlobEntry[]; cursor: string | null } {
  const rows = fakeListRows(values, prefix, delimiter);
  const after = cursor === undefined ? '' : Buffer.from(cursor, 'base64url').toString();
  const rest = [...rows.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .filter(([id]) => cursor === undefined || id > after);
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return {
    entries: page.map(([, entry]) => entry),
    cursor:
      rest.length > limit && last !== undefined ? Buffer.from(last[0]).toString('base64url') : null,
  };
}

export function fakeAzureBlobContainer(): AzureBlobContainer {
  const values = new Map<string, FakeBlob>();
  let version = 0;
  const store = (name: string, body: Uint8Array, contentType: string | null): FakeBlob => {
    version += 1;
    const blob = {
      body: Buffer.from(body),
      contentType,
      sizeBytes: body.byteLength,
      lastModified: new Date('2026-09-23T00:00:00.000Z'),
      etag: `"${String(version)}"`,
    };
    values.set(name, blob);
    return blob;
  };
  const metaOf = (blob: FakeBlob): ObjectMeta => ({
    sizeBytes: blob.sizeBytes,
    contentType: blob.contentType,
    etag: blob.etag,
    lastModified: blob.lastModified,
  });
  return {
    assertReady: () => Promise.resolve(),
    head(name) {
      const blob = values.get(name);
      return Promise.resolve(blob === undefined ? null : metaOf(blob));
    },
    readStream(name, range) {
      const blob = values.get(name);
      if (blob === undefined) return Promise.resolve(null);
      const served =
        range === undefined ? null : { start: range.start, end: range.end ?? blob.sizeBytes - 1 };
      const bytes = served === null ? blob.body : blob.body.subarray(served.start, served.end + 1);
      return Promise.resolve({
        meta: metaOf(blob),
        range: served,
        body: bytesToStream(Uint8Array.from(bytes)),
      });
    },
    async writeStream(name, body, options) {
      const bytes = body instanceof Uint8Array ? body : await streamToBytes(body);
      const current = values.get(name);
      if (options.ifNoneMatch === '*' && current !== undefined) return null;
      if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) return null;
      return metaOf(store(name, bytes, options.contentType ?? null));
    },
    listPage: (prefix, options) => Promise.resolve(fakeListPage(values, prefix, options)),
    copy(sourceName: string, destinationName: string): Promise<void> {
      const source = values.get(sourceName);
      if (source !== undefined) store(destinationName, source.body, source.contentType);
      return Promise.resolve();
    },
    delete(name: string): Promise<void> {
      values.delete(name);
      return Promise.resolve();
    },
  };
}

/** Every `kind:key` under `o`, read `limit` entries per page. */
export async function drain(store: ObjectStore, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listPage('o', {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    seen.push(...page.entries.map((entry) => `${entry.kind}:${entry.key}`));
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return seen;
}
