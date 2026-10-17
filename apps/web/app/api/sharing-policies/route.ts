import {
  isPublicSharingEnabled,
  setPublicSharingPolicy,
} from '../../../server/shares/policy/service';
import { shareJson, shareProblem, withShares } from '../../../server/shares/core/http';
import { requireResourceAccess } from '../../../server/resources/authorise';
import { DomainError } from '../../../server/errors';
import { errorResponse } from '../../../server/http/error-response';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return withShares(request, async ({ actor, sharing }) => {
    const access = await requireResourceAccess(request, 'not-applicable');
    if (!access.ok) return access.response;
    if (access.principal.workspaceId !== actor.workspaceId)
      return shareProblem(
        403,
        'forbidden',
        'The authorisation identity resolved another workspace.',
      );
    return Response.json({ publicSharing: await isPublicSharingEnabled(sharing) });
  });
}
export async function PATCH(request: Request) {
  try {
    return await withShares(request, async ({ actor, sharing }) => {
      const access = await requireResourceAccess(request, 'not-applicable');
      if (!access.ok) return access.response;
      if (access.principal.workspaceId !== actor.workspaceId)
        return shareProblem(
          403,
          'forbidden',
          'The authorisation identity resolved another workspace.',
        );
      const body = await shareJson(request);
      if (
        !body ||
        typeof body !== 'object' ||
        typeof (body as { publicSharing?: unknown }).publicSharing !== 'boolean'
      ) {
        throw new DomainError({
          category: 'validation',
          code: 'invalid_policy',
          publicMessage: 'publicSharing must be boolean.',
        });
      }
      const enabled = (body as { publicSharing: boolean }).publicSharing;
      await setPublicSharingPolicy(enabled, actor.role, sharing, actor);
      return Response.json({ publicSharing: enabled });
    });
  } catch (error) {
    return errorResponse(error, { component: 'shares', operation: 'update-public-policy' });
  }
}
