/**
 * `GET /api/workspaces` and `POST /api/workspaces` — issue #119.
 *
 * Neither is printed by spec §34 (`tests/route-declarations/W9-WS-119.ts` carries the mandate).
 * Both are `own`-grant, `not-applicable`-ownership requests — see
 * `apps/web/server/rbac/permissions.ts`'s `WORKSPACE_MEMBER_SCOPED` comment — which `decide()`
 * allows for every one of §21's four roles: #119 puts no role gate on who may create a workspace
 * or list their own memberships, only on who may administer one that already exists.
 *
 * `resolveActorUserIdForWorkspace` resolves the caller's real `users.id` from their *session*
 * workspace's membership list — reliably, because `identify()` already required that membership to
 * exist to build a `Principal` at all — and that id is what both handlers key on: `listWorkspaces`
 * reads every CURRENT membership across every workspace, and `createWorkspace` stamps it as the
 * new workspace's sole Owner.
 *
 * That reliability is exactly what fails for an API-key principal: `identify()` builds one from an
 * `api_keys` row, which names no email and therefore resolves no membership at all —
 * `resolveActorUserIdForWorkspace` would otherwise fall back to issue #117's `created_by` STAMPING
 * default (the workspace's oldest Owner), authorising the request as that OTHER person across
 * every workspace they belong to. `withIdentity` refuses `via === 'api-key'` before that
 * resolution ever runs — see `apps/web/server/workspaces/access.ts`'s `apiKeyRefusal` and
 * `docs/adr/W9-WS-119-api-key-callers-are-refused.md` (verification round 1, finding 1).
 */
import { createWorkspace, listWorkspaces } from '../../../server/workspaces/handlers';
import { apiKeyRefusal } from '../../../server/workspaces/access';
import type { WorkspaceRepositoryPort } from '../../../server/workspaces/runtime';
import { applicationContext } from '../../../server/application-context';
import { readJsonBody, type ApiResult } from '../../../server/http/result';
import { problem, toResponse } from '../../../server/rbac/http';
import { resolveSessionActorUserIdForWorkspace } from '../../../server/rbac/ownership';
import { requireResourceAccess, type ResourceAccess } from '../../../server/resources/authorise';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The two collection routes share this shape exactly: authenticate, require the runtime, resolve
 * the caller's own `users.id`, then hand both to `then`. Factored out so `GET` and `POST` differ
 * only in the one call each actually makes.
 */
async function withIdentity(
  request: Request,
  then: (repository: WorkspaceRepositoryPort, userId: string) => Promise<ApiResult>,
): Promise<Response> {
  const access: ResourceAccess = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  // An API-key principal has no human Membership with which to list or create workspace records;
  // `apiKeyRefusal` keeps this membership-administration surface session-only.
  const refusal = apiKeyRefusal(access.principal);
  if (refusal !== null) return toResponse(refusal);
  const workspaces = applicationContext()?.workspaces ?? null;
  if (workspaces === null) {
    return toResponse(
      problem(503, 'workspaces_runtime_not_configured', 'The workspaces API is not configured.'),
    );
  }
  // Revalidate the session principal against its exact current Membership. A missing Membership
  // or unavailable RBAC runtime makes authorization undecidable, so the request fails closed.
  const userId = await resolveSessionActorUserIdForWorkspace(
    access.principal.workspaceId,
    access.principal,
  );
  if (userId === null) {
    return toResponse(
      problem(
        500,
        'authorisation_undecidable',
        'The caller’s own membership could not be resolved, so this request cannot be answered ' +
          'for it.',
      ),
    );
  }
  return toResponse(await then(workspaces.repository, userId));
}

/** `GET /api/workspaces` — exactly the workspaces the caller currently belongs to. */
export async function GET(request: Request): Promise<Response> {
  return withIdentity(request, (repository, userId) => listWorkspaces(repository, userId));
}

/**
 * The new workspace's Builder (#1848). `provisionBuilder` re-reads the `builder` switch inside the
 * workspace's lock and never throws; `createWorkspace` still logs, not raises, anything that does.
 */
function provisionBuilder(workspaceId: string): Promise<void> {
  const application = applicationContext();
  if (application === null) return Promise.resolve();
  return application.workspaceFeatures.provisionBuilder(workspaceId);
}

/**
 * `POST /api/workspaces` — create a workspace with the caller as its sole Owner. The body is read
 * inside the authorised callback, after `requireResourceAccess` allows — never before it, so an
 * unauthenticated `POST` with a malformed body still answers `401`, not `400`. After the commit it
 * ensures the new workspace's Builder; a failure there does not fail the create.
 */
export async function POST(request: Request): Promise<Response> {
  return withIdentity(request, async (repository, userId) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.result;
    return createWorkspace(repository, userId, body.value, provisionBuilder);
  });
}
