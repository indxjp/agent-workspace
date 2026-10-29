/**
 * `POST /api/files/:id/upload-urls` — a short-lived `PUT` URL on the object store, so a holder moves
 * the bytes without the control plane relaying them (SDK-19, N-4). `:id` is the target path's
 * `fileRouteId`, so a file that does not exist yet already has one. The link is minted together
 * with a pending catalog row that no list, search or grant shows until the upload is completed (the
 * storage design, §04). A session-scoped browser token never reaches this route: `decide()` refuses
 * it, so a visitor's upload goes through `POST /api/sessions/:id/attachments` and its rules (#1574).
 */
// @story US-STO-02
import { CreateUploadUrlRequestSchema } from '@indx-workspace/contracts/files';

import { attachmentsRefusal, requireFilePath } from '../../../../../server/files/handlers';
import { refuseLinkRequest, reserveCatalogUpload } from '../../../../../server/files/uploads';
import {
  readContractBody,
  readIdParam,
  storageContextOf,
  toPresignedResponse,
  toResponse,
  withCatalogService,
} from '../../../../../server/files/http';
import {
  ownershipOfFileOwner,
  ownershipOfWriteTarget,
} from '../../../../../server/files/ownership';
import {
  recheckResourceAccess,
  requireResourceAccess,
} from '../../../../../server/resources/authorise';
import { route } from '../../../../../server/http/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function mintUploadUrl(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const parsed = requireFilePath(await readIdParam(context));
  if (!parsed.ok) return toResponse(parsed.result);
  const access = await requireResourceAccess(request, ownershipOfWriteTarget(parsed.path));
  if (!access.ok) return access.response;
  const limited = refuseLinkRequest(access.principal.workspaceId);
  if (limited !== null) return limited;
  const reserved = attachmentsRefusal(access.principal.scope, parsed.path, 'write');
  if (reserved !== null) return toResponse(reserved);
  const body = await readContractBody(request, CreateUploadUrlRequestSchema);
  if (!body.ok) return toResponse(body.result);

  const result = await withCatalogService(
    request,
    (storage) => {
      // The file the link would replace, as the reservation read it under its lock (#1991 C1).
      const recheck = async (replaced: { readonly ownerPrincipalId: string }) => {
        const denied = await recheckResourceAccess(
          request,
          access.principal,
          ownershipOfFileOwner(replaced),
        );
        return denied === null ? null : ({ ...denied, kind: 'json' } as const);
      };
      return reserveCatalogUpload(
        storage,
        storageContextOf(access.principal),
        parsed.path,
        body.value,
        recheck,
      );
    },
    access.principal.workspaceId,
  );
  return toPresignedResponse(result);
}

export const POST = route({ component: 'files', operation: 'presign-upload' }, mintUploadUrl);
