import { seedCatalogFile } from '@agent-workspace/core/db';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import { createHash } from 'node:crypto';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import type { CatalogFile } from '../storage/store';
import { type FileTextStore } from './store';
export const EMPTY_SHA256 = createHash('sha256').digest('hex');

interface FakeFile {
  id: string;
  path: string;
  contentType: string | null;
  body: string;
  version: number;
}

const WORKSPACE_ID = '99999999-9999-4999-8999-999999999999';

const OWNER_ID = '88888888-8888-4888-8888-888888888888';

export async function createSearchFixture(files: FakeFile[]) {
  const store = createInMemoryObjectStore();
  const catalog = createInMemoryCatalogStore().forWorkspaceSync(WORKSPACE_ID);
  for (const file of files) {
    const row = await seedCatalogFile(catalog, {
      path: file.path,
      kind: 'file',
      sizeBytes: file.body.length,
      contentType: file.contentType,
      ownerPrincipalId: OWNER_ID,
    });
    file.id = row.id;
  }
  const cached = new Map<
    string,
    { version: number; passages: { page: number | null; text: string; terms: string }[] }
  >();
  const texts = createTextStore(files, cached);
  const put = async () => {
    for (const file of files) {
      await store.write(file.path, Buffer.from(file.body), { contentType: file.contentType });
    }
  };
  // The fixture writes each file at its path; a row's own key names an object nobody wrote.
  const open = (row: CatalogFile) => store.read(row.path);
  return { open, texts, put, catalog, cached };
}

type TextCache = Map<
  string,
  { version: number; passages: { page: number | null; text: string; terms: string }[] }
>;

function createTextStore(files: FakeFile[], cached: TextCache): FileTextStore {
  return {
    listStale: () =>
      Promise.resolve(
        files
          .filter((file) => cached.get(file.path)?.version !== file.version)
          .map((file) => ({
            id: file.id,
            path: file.path,
            storageKey: file.path,
            contentType: file.contentType,
            sizeBytes: file.body.length,
            updatedAt: String(file.version),
          })),
      ),
    replace: (fileId, source, passages) => {
      const path = files.find((file) => file.id === fileId)?.path;
      if (path === undefined) throw new Error(`replace called with an unseeded id ${fileId}`);
      cached.set(path, { version: Number(source.updatedAt), passages: [...passages] });
      return Promise.resolve(true);
    },
    search: (tsquery, limit, allowed) => {
      const wanted = [...tsquery.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
      const hits = files.flatMap((file) =>
        allowed !== null && !allowed.includes(file.id)
          ? []
          : (cached.get(file.path)?.passages ?? [])
              .filter(
                (p) => p.terms !== '' && wanted.every((term) => p.terms.split(' ').includes(term)),
              )
              .map((p) => ({
                fileId: file.id,
                path: file.path,
                page: p.page,
                text: p.text,
                score: 0.5,
              })),
      );
      return Promise.resolve(hits.slice(0, limit));
    },
  };
}

export const file = (
  path: string,
  body: string,
  contentType: string | null = 'text/plain',
): FakeFile => ({
  id: '',
  path,
  contentType,
  body,
  version: 1,
});
