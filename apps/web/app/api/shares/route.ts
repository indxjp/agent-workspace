import {
  requireShareAccess,
  shareJson,
  shareProblem,
  withShares,
} from '../../../server/shares/core/http';
import { ownerPrincipalIdOf } from '../../../server/rbac/owner-principal';
import { parsePublishShareRequest } from '../../../server/shares/core/input';
import {
  publishedSnapshot,
  toShareResource,
  visibleShares,
} from '../../../server/shares/core/resource';
import { requireResourceAccess } from '../../../server/resources/authorise';
import { errorResponse } from '../../../server/http/error-response';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    return await withShares(request, async ({ sharing, actor }) => {
      const access = await requireShareAccess(request, actor);
      if (!access.ok) return access.response;
      const visible = visibleShares(await sharing.shares.list(), {
        role: access.principal.role,
        ownerPrincipalId: ownerPrincipalIdOf(actor),
      });
      return Response.json({
        shares: await Promise.all(
          visible.map(async (share) => toShareResource(share, await sharing.views.count(share.id))),
        ),
      });
    });
  } catch (error) {
    return errorResponse(error, { component: 'shares', operation: 'list' });
  }
}
export async function POST(request: Request) {
  try {
    return await withShares(request, async (context) => {
      const body = parsePublishShareRequest(await shareJson(request));
      const ownership = await context.subjectOwnership(body.subjectType, body.subjectId);
      const access = await requireResourceAccess(request, ownership);
      if (!access.ok) return access.response;
      if (access.principal.workspaceId !== context.actor.workspaceId)
        return shareProblem(
          403,
          'forbidden',
          'The authorisation identity resolved another workspace.',
        );
      const snapshot = await publishedSnapshot(
        body,
        await context.sharingMaterials(),
        context.sessionRuns,
      );
      const share = await context.service.publish({ ...body, snapshot }, context.actor);
      return Response.json(toShareResource(share), { status: 201 });
    });
  } catch (error) {
    return errorResponse(error, { component: 'shares', operation: 'publish' });
  }
}
