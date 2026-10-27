/**
 * `POST /api/secrets` and `GET /api/secrets` — spec §23, §26. Neither is printed in spec §34's
 * example list, so both carry a `mandate` in `tests/route-declarations/W2-CP-02.ts` (ADR-0026).
 *
 * These functions are deliberately trivial; see `apps/web/server/secrets/`, which a test can
 * import without the framework. Imports are relative, not `@/…`, for the reason
 * `apps/web/app/api/agents/route.ts`'s header gives: the alias is a bundler setting Vitest does
 * not resolve, and a relative specifier is what lets `routes.test.ts` exercise this file directly.
 */
import { createSecret, listSecrets } from '../../../server/secrets/handlers';
import { requireResourceAccess } from '../../../server/resources/authorise';
import { readJsonBody, withWorkspaceStore } from '../../../server/secrets/http';
import { apiResultResponse } from '../../../server/http/json-transport';

// The repository-wide route invariant (`tests/route-inventory.test.ts`): every route runs on the
// Node runtime and is never prerendered. These handlers read the session cookie through
// `withWorkspaceStore`, so prerendering is never correct, and 'edge' cannot hold what this route
// needs — the underlying secrets service uses `pg` and `node:crypto`, neither available there.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Issue #388: both methods are gated by the shared decision table first. §21 makes secrets
// Owner-only (`permissions.ts`: every other role falls to `NOTHING`); `withWorkspaceStore`'s own
// resolution answers only "which workspace", never "may this role", so without the gate any
// member or API key of the workspace could list and create secrets.

/** `GET /api/secrets` — this workspace's secret metadata, and no other workspace's (§25). Never a value (§23). */
export async function GET(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceStore(
    request,
    (store) => listSecrets(store, new URL(request.url).searchParams.get('name')),
    access.principal.workspaceId,
  );
  return apiResultResponse(result);
}

/**
 * `POST /api/secrets` — create one secret in the caller's workspace.
 *
 * The body is read only after the role gate and inside `withWorkspaceStore`, so the gate runs first — the same
 * ordering `apps/web/app/api/agents/route.ts` uses, for the same reason: a caller who fails the
 * gate must not learn this route's body format.
 */
export async function POST(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceStore(
    request,
    async (store) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      return createSecret(store, body.value);
    },
    access.principal.workspaceId,
  );
  return apiResultResponse(result);
}
