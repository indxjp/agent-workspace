/**
 * `POST /api/files/:id/download-urls` — a short-lived `GET` URL on the object store, so a holder reads
 * the bytes without the control plane relaying them (SDK-19, N-4). Gated as `GET /api/files/:id` is.
 * The URL forces the relay's inert delivery: a closed content type and `Content-Disposition:
 * attachment`. It signs the catalog row's own object and comes from the storage domain, never the
 * app's (the storage design, §05).
 */
// @story US-STO-05
import { CreateDownloadUrlRequestSchema } from '@indx-workspace/contracts/files';

import {
  attachmentsRefusal,
  concealOutsideSession,
  presignCatalogDownload,
  requireFilePath,
} from '../../../../../server/files/handlers';
import {
  readContractBody,
  readIdParam,
  storageContextOf,
  toPresignedResponse,
  toResponse,
  withCatalogService,
} from '../../../../../server/files/http';
import { ownershipOfPath } from '../../../../../server/files/ownership';
import { refuseLinkRequest } from '../../../../../server/files/uploads';
import { requireResourceAccess } from '../../../../../server/resources/authorise';
import { route } from '../../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function mintDownloadUrl(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const parsed = requireFilePath(await readIdParam(context));
  if (!parsed.ok) return toResponse(parsed.result);
  const access = await requireResourceAccess(request, ownershipOfPath(parsed.path));
  if (!access.ok) return access.response;
  const limited = refuseLinkRequest(access.principal.workspaceId);
  if (limited !== null) return limited;
  const concealed = concealOutsideSession(access.principal.scope, parsed.path);
  if (concealed !== null) return toResponse(concealed);
  const reserved = attachmentsRefusal(access.principal.scope, parsed.path, 'read');
  if (reserved !== null) return toResponse(reserved);
  const body = await readContractBody(request, CreateDownloadUrlRequestSchema);
  if (!body.ok) return toResponse(body.result);

  const result = await withCatalogService(
    request,
    (storage) =>
      presignCatalogDownload(storage, storageContextOf(access.principal), parsed.path, body.value),
    access.principal.workspaceId,
  );
  return toPresignedResponse(result);
}

export const POST = route({ component: 'files', operation: 'presign-download' }, mintDownloadUrl);
