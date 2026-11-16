/**
 * `GET /api/demo/allowance` — what the signed-in guest's demo has left. Authorised as reading the
 * caller's own principal; a workspace that is not a demo workspace is answered 404. See
 * `server/demo/storefront/transport/routes.ts`.
 */
import { demoAllowanceOf } from '../../../../server/demo/storefront/transport/routes';
import { route } from '../../../../server/http/route';
import { authorise, toResponse } from '../../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function read(request: Request): Promise<Response> {
  const result = await authorise(request, 'not-applicable', ({ principal, application }) =>
    demoAllowanceOf(principal, application.store),
  );
  return toResponse(result);
}

export const GET = route({ component: 'demo', operation: 'allowance' }, read);
