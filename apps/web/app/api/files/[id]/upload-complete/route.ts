/**
 * `POST /api/files/:id/upload-complete` — the second half of a signed-link upload (the storage
 * design, §04). It checks the object the `PUT` really wrote, deletes one over the limit, and marks
 * the pending row ready so the file is listed, searched, granted and served. The RBAC grammar goes
 * at most one level below `/api/<resource>/:id`, so this is a sibling of `upload-urls`. It takes
 * the same write grant and `attachmentsRefusal`; a session-scoped browser token never reaches it
 * (#1574).
 */
// @story US-STO-02
import { attachmentsRefusal, requireFilePath } from '../../../../../server/files/handlers';
import {
  readIdParam,
  storageContextOf,
  toResponse,
  withCatalogService,
} from '../../../../../server/files/http';
import { ownershipOfWriteTarget } from '../../../../../server/files/ownership';
import { completeCatalogUpload } from '../../../../../server/files/uploads';
import { requireResourceAccess } from '../../../../../server/resources/authorise';
import { route } from '../../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function completeSignedUpload(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const parsed = requireFilePath(await readIdParam(context));
  if (!parsed.ok) return toResponse(parsed.result);
  const access = await requireResourceAccess(request, ownershipOfWriteTarget(parsed.path));
  if (!access.ok) return access.response;
  const reserved = attachmentsRefusal(access.principal.scope, parsed.path, 'write');
  if (reserved !== null) return toResponse(reserved);

  return toResponse(
    await withCatalogService(
      request,
      (storage) => completeCatalogUpload(storage, storageContextOf(access.principal), parsed.path),
      access.principal.workspaceId,
    ),
  );
}

export const POST = route(
  { component: 'files', operation: 'complete-upload' },
  completeSignedUpload,
);
