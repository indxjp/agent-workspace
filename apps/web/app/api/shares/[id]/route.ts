import { isUuid } from '@indx-workspace/contracts';

import { errorResponse } from '../../../../server/http/error-response';
import { requireShareAccess, shareProblem, withShares } from '../../../../server/shares/core/http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return await withShares(request, async ({ actor, service, sharing }) => {
      // `shares.id` is a `uuid` column: anything else names no share, and must not reach it.
      if (!isUuid(id)) return shareProblem(404, 'share_not_found', 'Share not found.');
      const share = await sharing.shares.get(id);
      if (share) {
        const access = await requireShareAccess(request, actor, share.publisherPrincipalId);
        if (!access.ok) return access.response;
      }
      return (await service.revoke(id, actor))
        ? new Response(null, { status: 204 })
        : shareProblem(404, 'share_not_found', 'Share not found.');
    });
  } catch (error) {
    return errorResponse(error, { component: 'shares', operation: 'revoke' });
  }
}
