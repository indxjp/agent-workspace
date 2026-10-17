/**
 * `GET`, `DELETE` and `PATCH /api/files/:id` — download, delete and rename. None of the three is
 * printed in spec §34's own list (only bare `GET`/`POST /api/files` are), so each carries a
 * `mandate` citing §16, per ADR-0026 decision 2. `:id` is a base64url encoding of the file's
 * workspace-relative path — see `apps/web/server/files/file-id.ts` for why.
 */
import {
  deleteFile,
  deleteSubtree,
  downloadFile,
  moveSubtree,
  problem,
  renameFile,
  requireFilePath,
} from '../../../../server/files/handlers';
import { readIdParam, toResponse, withWorkspaceObjectStore } from '../../../../server/files/http';
import { currentFilesRuntime } from '../../../../server/files/runtime';
import { requireResourceAccess } from '../../../../server/resources/authorise';
import type { OwnershipResolver } from '../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Issue #117: load the file's catalog row within the caller's workspace and compare its
 * `created_by` against the caller. A path with no catalog row — the object exists only in the
 * `ObjectStore`, e.g. because it predates the catalog or its sync failed — answers `unknown`
 * rather than `other`: this route cannot prove who created it, and an undetermined owner denies
 * rather than passes (ADR-0031), the same rule this route applied to every row before this task.
 *
 * A folder's recursive delete and its move act on every descendant too, so the path is `own` only
 * when every catalog row at or under it is the caller's: owning a shared folder must not let an
 * `own` grant delete or move other members' files inside it. A plain file has no descendants, so
 * this is the same single-row comparison for it.
 */
function ownershipOfPath(path: string): OwnershipResolver {
  return async (principal) => {
    const runtime = currentFilesRuntime();
    const catalog = runtime === null || runtime.catalog === undefined ? null : runtime.catalog;
    if (catalog === null) return { kind: 'ownership', ownership: 'unknown' };
    const files = await (await catalog.forWorkspace(principal.workspaceId)).listFiles();
    if (!files.some((file) => file.path === path))
      return { kind: 'ownership', ownership: 'unknown' };
    const subtree = files.filter((file) => file.path === path || file.path.startsWith(`${path}/`));
    const allOwn = subtree.every((file) => file.ownerPrincipalId === principal.ownerPrincipalId);
    return { kind: 'ownership', ownership: allOwn ? 'own' : 'other' };
  };
}

/** spec §16: "download". */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const rawId = await readIdParam(context);
  const parsed = requireFilePath(rawId);
  if (!parsed.ok) return toResponse(parsed.result);
  const access = await requireResourceAccess(request, ownershipOfPath(parsed.path));
  if (!access.ok) return access.response;
  const result = await withWorkspaceObjectStore(
    request,
    (store) => downloadFile(store, parsed.path),
    access.principal.workspaceId,
  );
  return toResponse(result);
}

/**
 * spec §16: "delete". `?recursive=true` is issue #131's fix for the bug of the same name: a plain
 * file (or a genuinely nonexistent path — the idempotent-204 case R-15 §1c already established)
 * still goes through the single-object path below unchanged; a folder with descendants refuses
 * with `409` unless `recursive` is set, in which case the whole subtree is removed and the catalog
 * is cleaned up under the same prefix, in one call, only once every object is confirmed gone.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const rawId = await readIdParam(context);
  const parsed = requireFilePath(rawId);
  if (!parsed.ok) return toResponse(parsed.result);
  const access = await requireResourceAccess(request, ownershipOfPath(parsed.path));
  if (!access.ok) return access.response;
  const recursive = new URL(request.url).searchParams.get('recursive') === 'true';
  const result = await withWorkspaceObjectStore(
    request,
    async (store, catalog) => {
      const isFile = (await store.get(parsed.path)) !== null;
      if (isFile) {
        const deleted = await deleteFile(store, parsed.path);
        if (deleted.kind === 'empty') {
          await catalog?.deleteFile(parsed.path);
        }
        return deleted;
      }
      const subtree = await deleteSubtree(store, parsed.path, recursive);
      if (subtree === null) {
        // Nothing exists at or under this path at all — the same idempotent "already gone"
        // answer a single-object delete already gives.
        await catalog?.deleteFile(parsed.path);
        return { status: 204, kind: 'empty' } as const;
      }
      if (subtree.kind === 'json' && catalog !== null) {
        const body = subtree.body as { status: 'ok' | 'partial' };
        if (body.status === 'ok') await catalog.deleteFilesByPrefix?.(parsed.path);
      }
      return subtree;
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}

/** spec §16: "rename". Body: `{"newPath": "new/relative/path.txt"}`. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const rawId = await readIdParam(context);
  const parsed = requireFilePath(rawId);
  if (!parsed.ok) return toResponse(parsed.result);
  const access = await requireResourceAccess(request, ownershipOfPath(parsed.path));
  if (!access.ok) return access.response;

  const result = await withWorkspaceObjectStore(
    request,
    async (store, catalog) => {
      const contentType = request.headers.get('content-type');
      if (contentType === null || !contentType.toLowerCase().startsWith('application/json')) {
        return problem(415, 'unsupported_media_type', 'This route accepts application/json.');
      }
      let body: unknown;
      try {
        body = JSON.parse(await request.text());
      } catch {
        return problem(400, 'malformed_body', 'The request body is not valid JSON.');
      }
      if (
        typeof body !== 'object' ||
        body === null ||
        typeof (body as Record<string, unknown>)['newPath'] !== 'string'
      ) {
        return problem(400, 'malformed_body', 'The request body must be {"newPath": string}.');
      }
      const newPath = (body as { newPath: string }).newPath;

      const isFile = (await store.get(parsed.path)) !== null;
      if (!isFile) {
        // Not a plain file: either a folder (empty or with descendants) or genuinely nothing at
        // that path. `moveSubtree` tells the two apart itself (404 for the latter) and does its
        // own catalog rewrite between the copy and delete phases — see its header for why that
        // ordering, not "after", is what issue #131 asks for.
        return moveSubtree(store, catalog, parsed.path, { newPath });
      }

      const renamed = await renameFile(store, parsed.path, { newPath });
      if (catalog !== null && renamed.kind === 'json' && renamed.status === 200) {
        const file = (
          renamed.body as { file: { kind: 'file'; sizeBytes: number; contentType: string | null } }
        ).file;
        try {
          const row = await catalog.renameFile(parsed.path, {
            path: newPath,
            kind: file.kind,
            storageKey: newPath,
            sizeBytes: file.sizeBytes,
            contentType: file.contentType,
          });
          if (row === null) {
            // A legacy object without a catalog row has no assignment id to preserve, and no
            // recorded creator either — attributed to the renaming caller (issue #117), the same
            // reading `GET /api/files`'s own legacy-sync path takes.
            const inserted = await catalog.putFile({
              path: newPath,
              kind: file.kind,
              storageKey: newPath,
              sizeBytes: file.sizeBytes,
              contentType: file.contentType,
              ownerPrincipalId: access.principal.ownerPrincipalId,
              createdBy: access.principal.userId,
            });
            return { ...renamed, body: { file: { ...file, id: inserted.id, path: newPath } } };
          }
          return { ...renamed, body: { file: { ...file, id: row.id, path: newPath } } };
        } catch (error) {
          // Object storage moved first. Restore it before surfacing a catalog failure so a retry
          // never sees a completed move reported as failed.
          const rolledBack = await renameFile(store, newPath, { newPath: parsed.path });
          if (rolledBack.kind !== 'json' || rolledBack.status !== 200) {
            return problem(
              500,
              'rename_inconsistent',
              'The catalog update failed and object storage could not restore the original path.',
            );
          }
          throw error;
        }
      }
      return renamed;
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}
