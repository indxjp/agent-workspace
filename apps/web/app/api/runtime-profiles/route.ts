/**
 * `POST /api/runtime-profiles` and `GET /api/runtime-profiles` — spec §34's own examples list
 * these two verbatim. The other three (`GET`/`PATCH`/`DELETE /:id`) live in `[id]/route.ts`.
 *
 * Imports are relative, not `@/…`: the alias is a bundler setting Vitest does not resolve, and
 * `apps/web/server/runtimes/routes.test.ts` needs to import this file directly.
 */
import { createRuntimeProfile, listRuntimeProfiles } from '../../../server/runtimes/handlers';
import { readJsonBody, toResponse, withWorkspaceProfileStore } from '../../../server/runtimes/http';
import { enforceableNetworkPoliciesFromRegistry } from '../../../server/runtimes/registry';
import { requireResourceAccess } from '../../../server/resources/authorise';

// The repository-wide route invariant (`tests/route-inventory.test.ts`): every route runs on the
// Node runtime and is never prerendered — these handlers read the session cookie, so prerendering
// is never correct.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Every method is gated by the shared decision table before anything else runs (#388):
// `resolveWorkspace` alone answers only "which workspace", never "may this role". §21 gives
// runtimes to Owner and Admin, who read and write profiles (`permissions.ts`: `MANAGE`). A Builder
// reads them (`READ_ONLY`), because the agent editor and SDK agent definitions choose a profile,
// and writes none; a Viewer reaches nothing (ADR-0088).

/** `GET /api/runtime-profiles` — the caller's workspace's profiles, and no other's (§25). */
export async function GET(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceProfileStore(
    request,
    (store) => listRuntimeProfiles(store),
    access.principal.workspaceId,
  );
  return toResponse(result);
}

/** `POST /api/runtime-profiles` — create one profile in the caller's workspace (§15.1). */
export async function POST(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceProfileStore(
    request,
    async (store) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      return createRuntimeProfile(store, body.value, enforceableNetworkPoliciesFromRegistry);
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}
