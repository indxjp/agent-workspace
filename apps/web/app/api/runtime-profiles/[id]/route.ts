/**
 * `GET`, `PATCH` and `DELETE` on `/api/runtime-profiles/:id` — the shape rule's dynamic-segment
 * form (ADR-0026), completing this task's CRUD over spec §34's `/api/runtime-profiles`.
 */
import {
  deleteRuntimeProfile,
  getRuntimeProfile,
  updateRuntimeProfile,
} from '../../../../server/runtimes/handlers';
import {
  readIdParam,
  readJsonBody,
  withWorkspaceProfileStore,
} from '../../../../server/runtimes/http';
import { apiResultResponse } from '../../../../server/http/json-transport';
import { enforceableNetworkPoliciesFromRegistry } from '../../../../server/runtimes/registry';
import { requireResourceAccess } from '../../../../server/resources/authorise';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Every method is gated by the shared decision table before anything else runs (#388):
// `resolveWorkspace` alone answers only "which workspace", never "may this role". §21 gives
// runtimes to Owner and Admin, who read and write profiles (`permissions.ts`: `MANAGE`). A Builder
// reads them (`READ_ONLY`), because the agent editor and SDK agent definitions choose a profile,
// and writes none; a Viewer reaches nothing (ADR-0088).

type RuntimeProfileRouteContext = { params: Promise<{ id: string }> };

/** `GET /api/runtime-profiles/:id` — 404 for an id this workspace does not have, never 403 (§25). */
export async function GET(
  request: Request,
  context: RuntimeProfileRouteContext,
): Promise<Response> {
  const id = await readIdParam(context);
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceProfileStore(
    request,
    (store) => getRuntimeProfile(store, id),
    access.principal.workspaceId,
  );
  return apiResultResponse(result);
}

/** `PATCH /api/runtime-profiles/:id` — apply a partial update, validated against §15.1's schema. */
export async function PATCH(
  request: Request,
  context: RuntimeProfileRouteContext,
): Promise<Response> {
  const id = await readIdParam(context);
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceProfileStore(
    request,
    async (store) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.result;
      return updateRuntimeProfile(store, id, body.value, enforceableNetworkPoliciesFromRegistry);
    },
    access.principal.workspaceId,
  );
  return apiResultResponse(result);
}

/** `DELETE /api/runtime-profiles/:id` — 204 on success, 404 if the workspace has no such profile. */
export async function DELETE(
  request: Request,
  context: RuntimeProfileRouteContext,
): Promise<Response> {
  const id = await readIdParam(context);
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceProfileStore(
    request,
    (store) => deleteRuntimeProfile(store, id),
    access.principal.workspaceId,
  );
  return apiResultResponse(result);
}
