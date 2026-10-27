/**
 * `POST /api/triggers/:id/secret` — issue #1293, ADR-0144. Rotates the URL secret of a webhook
 * trigger; the new secret is in this response and nowhere else.
 */
import { readIdParam, toResponse } from '../../../../../server/rbac/http';
import { rotateSecret } from '../../../../../server/triggers/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return toResponse(await rotateSecret(request, await readIdParam(context)));
}
