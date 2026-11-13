import { toObjectPrefix, UnsafeObjectKeyError } from '@agent-workspace/core/storage/keys';
import type { StorageContext, StorageService } from '../storage/service';
import type { CatalogPort, CatalogFile } from '../storage/store';
import { encodeFileId } from './file-id';
import { isUnderSkillRows } from './file-path-policy';
import { downloadContentType, type FileResource, lastModifiedOf } from './file-resource';
import { type FileResult, json, problem } from './file-result';

/**
 * `GET /api/files?path=…` from the catalog: the ready files of the area one level under `path`, and
 * the folders between (an explicit folder row, or one implied by a file beneath it). Pending and
 * removed rows are not ready, so they never appear. A catalog row carries no timestamp, so
 * `lastModified` is `null`.
 *
 * ponytail: reads every ready row at or under `path` to build one level (twice: files through the
 * service, folder rows through the catalog); a one-level `list` on the catalog port if a folder
 * holds many.
 */
// @story US-STO-01
export async function listCatalogFolder(
  storage: StorageService,
  catalog: CatalogPort,
  ctx: StorageContext,
  rawPath: string | null,
): Promise<FileResult> {
  let folder: string;
  try {
    folder = toObjectPrefix(rawPath ?? '');
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) {
      return problem(
        400,
        'invalid_path',
        `The "path" query parameter is not valid: ${error.message}`,
      );
    }
    throw error;
  }
  const base = folder === '' ? '' : `${folder}/`;
  const entries = new Map<string, FileResource>();

  await addReadyFiles({ storage, ctx, folder, base, entries });
  await addCatalogFolders({ catalog, folder, base, entries });

  const files = [...entries.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return json(200, { files });
}

/**
 * `GET /api/files/:id` from the catalog: the ready file's object as a stream, or a folder's
 * metadata. A pending, removed or other-area row answers `404`, as does a row whose object is gone.
 */
// @story US-STO-05
export async function downloadCatalogRow(
  storage: StorageService,
  catalog: CatalogPort,
  ctx: StorageContext,
  path: string,
): Promise<FileResult> {
  const notFound = () => problem(404, 'file_not_found', 'No file has that id.');
  const row = await storage.get(ctx, 'files', path);
  if (row === null) {
    const folder = await catalog.get(path);
    if (folder?.kind !== 'folder') return notFound();
    return json(200, {
      file: folderResource(folder.path, folder.id),
    });
  }
  const opened = await storage.open(ctx, row);
  if (opened === null) return notFound();
  return {
    status: 200,
    kind: 'stream',
    body: opened.body,
    sizeBytes: opened.meta.sizeBytes,
    contentType: downloadContentType(row.contentType),
    filename: path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path,
  };
}

function folderResource(path: string, id: string): FileResource {
  return {
    id,
    path,
    kind: 'folder',
    sizeBytes: null,
    contentType: null,
    lastModified: null,
  };
}

function addFileEntry(entries: Map<string, FileResource>, base: string, row: CatalogFile): void {
  if (!row.path.startsWith(base)) return;
  const rest = row.path.slice(base.length);
  const slash = rest.indexOf('/');
  if (slash === -1) {
    entries.set(row.path, {
      id: row.id,
      path: row.path,
      kind: 'file',
      sizeBytes: row.sizeBytes,
      contentType: row.contentType,
      lastModified: lastModifiedOf(row),
    });
  } else {
    const directory = `${base}${rest.slice(0, slash)}`;
    if (!entries.has(directory))
      entries.set(directory, folderResource(directory, encodeFileId(directory)));
  }
}

function addExplicitFolder(
  entries: Map<string, FileResource>,
  base: string,
  row: CatalogFile,
): void {
  if (row.kind !== 'folder' || !row.path.startsWith(base)) return;
  // Saving a skill adds folder rows above it; a user's file under `.skills/` still implies its
  // folder through the files loop above.
  // @story US-STO-08
  if (isUnderSkillRows(row.path)) return;
  const rest = row.path.slice(base.length);
  if (rest !== '' && !rest.includes('/')) entries.set(row.path, folderResource(row.path, row.id));
}

interface FolderListing {
  readonly folder: string;
  readonly base: string;
  readonly entries: Map<string, FileResource>;
}

async function addReadyFiles({
  storage,
  ctx,
  folder,
  base,
  entries,
}: FolderListing & {
  readonly storage: StorageService;
  readonly ctx: StorageContext;
}) {
  let cursor: string | undefined;
  do {
    const page = await storage.list(
      ctx,
      'files',
      folder,
      cursor === undefined ? undefined : { cursor },
    );
    for (const row of page.rows) addFileEntry(entries, base, row);
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
}

async function addCatalogFolders({
  catalog,
  folder,
  base,
  entries,
}: FolderListing & {
  readonly catalog: CatalogPort;
}) {
  let cursor: string | undefined;
  do {
    const page = await catalog.list(folder, cursor === undefined ? undefined : { cursor });
    for (const row of page.rows) addExplicitFolder(entries, base, row);
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
}
