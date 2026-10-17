/**
 * `GET /api/platforms` — the platform targets an agent can be exported to (issue #968). Static
 * code, the same for every caller, so `authorise` gets `'not-applicable'`, like `/api/engines`;
 * the `platforms` row of `server/rbac/permissions.ts` still decides who may read it.
 */
import { listPlatforms } from '../../../server/platforms/catalogue';
import { authorise, toResponse } from '../../../server/rbac/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return toResponse(
    await authorise(request, 'not-applicable', () => Promise.resolve(listPlatforms())),
  );
}
