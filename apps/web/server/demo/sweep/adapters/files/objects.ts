/**
 * Every object a workspace has in object storage, whatever its catalog row says: a ready file, a
 * pending upload, a row already `deleting`, and a session-state blob (its rows live in their own
 * table, not the catalog, so the catalog's listing never names them). For a workspace that is about
 * to be deleted: its rows cascade away with it, and the cleanup job skips the objects of a
 * workspace that no longer exists (`storage/cleanup.ts`), so an object left now is never reclaimed.
 */

/** The part of the files domain's object store (`files/store.ts`, `storage/objects.ts`) the wipe reads and writes. */
export interface DemoObjectStore {
  listPage(
    prefix: string,
    options: { readonly recursive: boolean; readonly limit: number },
  ): Promise<{ readonly entries: readonly { readonly kind: string; readonly key: string }[] }>;
  delete(key: string): Promise<unknown>;
}

/** Objects per listing page. */
const PAGE_SIZE = 1000;

/**
 * Delete every object under the workspace the store is scoped to; the number deleted. Absent
 * objects are not an error (`ObjectStore.delete`). The listing is read again after each page is
 * deleted, so it needs no cursor and ends when nothing is left.
 */
export async function discardWorkspaceObjects(objects: DemoObjectStore): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await objects.listPage('', { recursive: true, limit: PAGE_SIZE });
    const keys = page.entries.flatMap((entry) => (entry.kind === 'file' ? [entry.key] : []));
    if (keys.length === 0) return deleted;
    for (const key of keys) await objects.delete(key);
    deleted += keys.length;
  }
}
