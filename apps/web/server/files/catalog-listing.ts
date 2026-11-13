import { listCatalogFiles, type CatalogFile } from '../storage/store';
import type { FilesRuntime } from './runtime';

/**
 * Every catalog row of one workspace, for a page that must name files by id (the home chat's
 * "+ Files" picker, RF-502). The storage design, §07 rule 2: a page calls a server domain service,
 * never the storage adapter itself. `null` when the files runtime has no catalog.
 */
export async function workspaceCatalogFiles(
  files: Pick<FilesRuntime, 'catalog'>,
  workspaceId: string,
): Promise<readonly CatalogFile[] | null> {
  if (files.catalog === undefined) return null;
  return listCatalogFiles(await files.catalog.forWorkspace(workspaceId));
}
