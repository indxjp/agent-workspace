/**
 * `GET` and `PATCH` on `/api/workspaces/:id` — issue #119.
 *
 * No `DELETE`: archive (`PATCH` with `{"archived": true}`) is the whole lifecycle this wave
 * builds; the card's "Deliberately not built" is explicit that a permanent purge is out of scope.
 *
 * `GET` uses {@link memberOwnershipResolver} — any current membership of `:id` may read it,
 * archived or not (issue #119: "Archived workspaces remain readable"). `PATCH` uses the stricter
 * {@link ownerOwnershipResolver} — only the workspace's own Owner may rename or (re)archive it —
 * so a Builder or Viewer who IS a member gets a genuine `403` and a caller with no membership at
 * all, or a random id, gets the identical `404` `GET` would give them (issue #117's concealment
 * rule, verified by this task's own PR under `## Acceptance`).
 *
 * Both resolvers refuse an API-key principal outright (`access.ts`'s `apiKeyRefusal`) because an
 * API key has no human Membership with which to administer workspace records; see
 * `docs/adr/W9-WS-119-api-key-callers-are-refused.md`.
 */
import { getWorkspace, updateWorkspace } from '../../../../server/workspaces/handlers';
import {
  memberOwnershipResolver,
  ownerOwnershipResolver,
  workspaceNotFound,
} from '../../../../server/workspaces/access';
import { currentWorkspacesRuntime } from '../../../../server/workspaces/runtime';
import {
  authorise,
  problem,
  readIdParam,
  readJsonBody,
  toResponse,
} from '../../../../server/rbac/http';
import { resolveSessionActorUserId } from '../../../../server/rbac/ownership';
import { requireResourceAccess } from '../../../../server/resources/authorise';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type WorkspaceRouteContext = { params: Promise<{ id: string }> };

/** `GET /api/workspaces/:id`. */
export async function GET(request: Request, context: WorkspaceRouteContext): Promise<Response> {
  const id = await readIdParam(context);
  const workspaces = currentWorkspacesRuntime();
  if (workspaces === null) {
    return toResponse(
      problem(503, 'workspaces_runtime_not_configured', 'The workspaces API is not configured.'),
    );
  }
  // `authorise` directly, not `requireResourceAccess`: this handler needs the same
  // `WorkspaceDirectory` the resolver used, to resolve the caller's `users.id` a second time
  // without a further round trip through the RBAC runtime registry.
  const result = await authorise(
    request,
    memberOwnershipResolver(workspaces.repository, id),
    async ({ principal, directory }) => {
      // This second Membership read revalidates the exact session caller after the resolver's
      // lookup. If the Membership disappeared between the two reads, preserve concealment with the
      // same 404 rather than continuing with stale authorization.
      const userId = resolveSessionActorUserId(await directory.listMemberships(), principal.actor);
      if (userId === null) return workspaceNotFound();
      return getWorkspace(workspaces.repository, id as string, userId);
    },
  );
  return toResponse(result);
}

/** `PATCH /api/workspaces/:id` — rename and/or archive/restore. Owner only. */
export async function PATCH(request: Request, context: WorkspaceRouteContext): Promise<Response> {
  const id = await readIdParam(context);
  const workspaces = currentWorkspacesRuntime();
  if (workspaces === null) {
    return toResponse(
      problem(503, 'workspaces_runtime_not_configured', 'The workspaces API is not configured.'),
    );
  }
  const access = await requireResourceAccess(
    request,
    ownerOwnershipResolver(workspaces.repository, id),
  );
  if (!access.ok) return access.response;
  const body = await readJsonBody(request);
  if (!body.ok) return toResponse(body.result);
  return toResponse(await updateWorkspace(workspaces.repository, id as string, body.value));
}
