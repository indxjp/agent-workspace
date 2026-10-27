/**
 * `GET`, `DELETE` and `PATCH /api/files/:id` — download, delete and rename. None of the three is
 * printed in spec §34's own list (only bare `GET`/`POST /api/files` are), so each carries a
 * `mandate` citing §16, per ADR-0026 decision 2. `:id` is a base64url encoding of the file's
 * workspace-relative path — see `apps/web/server/files/file-id.ts` for why.
 */
import { MoveFileRequestSchema } from '@indx-workspace/contracts/files';

import {
  attachmentsRefusal,
  downloadCatalogRow,
  removeCatalogPath,
  renameCatalogPath,
  requireFilePath,
} from '../../../../server/files/handlers';
import {
  readContractBody,
  readIdParam,
  storageContextOf,
  toResponse,
  withCatalogService,
} from '../../../../server/files/http';
import { ownershipOfPath } from '../../../../server/files/ownership';
import { requireResourceAccess } from '../../../../server/resources/authorise';
import { route } from '../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** spec §16: "download". */
async function downloadFileById(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const rawId = await readIdParam(context);
  const parsed = requireFilePath(rawId);
  if (!parsed.ok) return toResponse(parsed.result);
  const access = await requireResourceAccess(request, ownershipOfPath(parsed.path));
  if (!access.ok) return access.response;
  const concealed = attachmentsRefusal(access.principal.scope, parsed.path, 'read');
  if (concealed !== null) return toResponse(concealed);
  const result = await withCatalogService(
    request,
    // @story US-STO-05
    (storage, catalog) =>
      downloadCatalogRow(storage, catalog, storageContextOf(access.principal), parsed.path),
    access.principal.workspaceId,
  );
  return toResponse(result);
}

/**
 * spec §16: "delete". `?recursive=true` is issue #131's fix for the bug of the same name: a plain
 * file (or a genuinely nonexistent path — the idempotent-204 case R-15 §1c already established)
 * still goes through the single-object path below unchanged; a folder with descendants refuses
 * with `409` unless `recursive` is set, in which case the whole subtree is removed and the catalog
 * is cleaned up under the same prefix, in one call, once every object is confirmed gone. A partial
 * delete drops only the rows of the objects it did delete, so a retry finishes the rest.
 */
async function deleteFileById(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const rawId = await readIdParam(context);
  const parsed = requireFilePath(rawId);
  if (!parsed.ok) return toResponse(parsed.result);
  const access = await requireResourceAccess(request, ownershipOfPath(parsed.path));
  if (!access.ok) return access.response;
  // ADR-0146 D6: renaming out is the only operation `.attachments/` admits, so a member deletes
  // neither a visitor's file nor its folder; retention removes them with their session.
  const reserved = attachmentsRefusal(access.principal.scope, parsed.path, 'delete');
  if (reserved !== null) return toResponse(reserved);
  const recursive = new URL(request.url).searchParams.get('recursive') === 'true';
  const result = await withCatalogService(
    request,
    // @story US-STO-04
    (storage, catalog) =>
      removeCatalogPath(
        storage,
        catalog,
        storageContextOf(access.principal),
        parsed.path,
        recursive,
      ),
    access.principal.workspaceId,
  );
  return toResponse(result);
}

/** spec §16: "rename". Body: `{"newPath": "new/relative/path.txt"}`. */
async function renameFileById(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const rawId = await readIdParam(context);
  const parsed = requireFilePath(rawId);
  if (!parsed.ok) return toResponse(parsed.result);
  const access = await requireResourceAccess(request, ownershipOfPath(parsed.path));
  if (!access.ok) return access.response;
  const body = await readContractBody(request, MoveFileRequestSchema);
  if (!body.ok) return toResponse(body.result);
  const { newPath } = body.value;
  const reserved = attachmentsRefusal(access.principal.scope, newPath, 'write');
  if (reserved !== null) return toResponse(reserved);

  const result = await withCatalogService(
    request,
    // @story US-STO-03
    (storage, catalog) =>
      renameCatalogPath(storage, catalog, storageContextOf(access.principal), parsed.path, newPath),
    access.principal.workspaceId,
  );
  return toResponse(result);
}

export const GET = route({ component: 'files', operation: 'download' }, downloadFileById);
export const DELETE = route({ component: 'files', operation: 'delete' }, deleteFileById);
export const PATCH = route({ component: 'files', operation: 'rename' }, renameFileById);
