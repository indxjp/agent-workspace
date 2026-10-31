/**
 * `DELETE /api/webhooks/:id` — N-3 (issue #250, ADR-SDK-18-N3-250). Removes the webhook, its
 * pending deliveries and its signing secret; answers `204`.
 */
import { route } from '../../../../server/http/route';
import { readIdParam, toResponse } from '../../../../server/rbac/http';
import { remove } from '../../../../server/webhooks/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function serveRemove(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return toResponse(await remove(request, await readIdParam(context)));
}

export const DELETE = route({ component: 'webhooks', operation: 'remove' }, serveRemove);
