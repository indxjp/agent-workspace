/** Reading a template workspace's whole file catalog, which the copy and the seed both do. */
import type { ResourceCatalogStoreProvider } from '../../storage-and-sharing';

/** A workspace's file catalog, as the files domain hands it out. */
export type Catalog = Awaited<ReturnType<ResourceCatalogStoreProvider['forWorkspace']>>;
/** One row of it: a file, or a folder. */
export type CatalogFile = NonNullable<Awaited<ReturnType<Catalog['get']>>>;

/** Rows read from the catalog per page. */
const CATALOG_PAGE_LIMIT = 500;

/** Every ready row (file or folder) of the workspace, page by page. */
export async function allCatalogRows(
  catalogs: (workspaceId: string) => Promise<Pick<Catalog, 'list'>>,
  workspaceId: string,
): Promise<readonly CatalogFile[]> {
  const catalog = await catalogs(workspaceId);
  const rows: CatalogFile[] = [];
  let cursor: string | undefined;
  do {
    const page = await catalog.list('', {
      limit: CATALOG_PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    rows.push(...page.rows);
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return rows;
}
