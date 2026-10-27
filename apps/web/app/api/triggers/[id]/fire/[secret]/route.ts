/**
 * `POST /api/triggers/:id/fire/:secret` — issue #1293, ADR-0144. Public: the secret in the path is
 * the authentication, and `apps/web/proxy.ts` exempts exactly this route from the session gate.
 */
import { readRouteParam } from '../../../../../../server/http/json-transport';
import { fire } from '../../../../../../server/triggers/fire';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; secret: string }> },
): Promise<Response> {
  return fire(
    request,
    await readRouteParam(context, 'id'),
    await readRouteParam(context, 'secret'),
  );
}
