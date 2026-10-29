/**
 * `GET` and `PUT` on `/api/workspaces/:id/features` — ADR-0160 D6–D8, issue #1496.
 *
 * `GET` uses {@link memberOwnershipResolver}: any current member of `:id` may read which features
 * are on. `PUT` uses {@link ownerOwnershipResolver}: only the workspace's own Owner may replace the
 * off set, and a lesser member gets a genuine `403`. A non-member and a non-UUID id get the same
 * `404 workspace_not_found` `GET /api/workspaces/:id` gives, and both resolvers refuse an API key
 * with `403 api_key_not_permitted`, as every `/api/workspaces` route does.
 *
 * Both routes are `core`: a workspace can never switch off the means to switch features back on.
 * The switches are opened for the workspace the path names, never for the session's own; the
 * resolvers have already proved the caller's membership of it.
 */
import { applicationContext } from '../../../../../server/application-context';
import { readJsonBody } from '../../../../../server/http/result';
import { route } from '../../../../../server/http/route';
import { authorise, problem, readIdParam, toResponse } from '../../../../../server/rbac/http';
import { requireResourceAccess } from '../../../../../server/resources/authorise';
import {
  memberOwnershipResolver,
  ownerOwnershipResolver,
  workspaceNotFound,
} from '../../../../../server/workspaces/access';
import {
  listWorkspaceFeatures,
  updateWorkspaceFeatures,
} from '../../../../../server/workspaces/features';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type FeaturesRouteContext = { params: Promise<{ id: string }> };

function notConfigured(): Response {
  return toResponse(
    problem(503, 'workspaces_runtime_not_configured', 'The workspaces API is not configured.'),
  );
}

/** `GET /api/workspaces/:id/features` — one row per feature: installed, and on for this workspace. */
async function serveGet(request: Request, context: FeaturesRouteContext): Promise<Response> {
  const id = await readIdParam(context);
  const application = applicationContext();
  if (application === null) return notConfigured();
  const { workspaces, workspaceFeatures } = application;
  const result = await authorise(
    request,
    memberOwnershipResolver(workspaces.repository, id),
    async () => {
      const repository = await workspaceFeatures.repositoryFor(id as string);
      if (repository === null) return workspaceNotFound();
      const disabled = await repository.listDisabled();
      return { status: 200, body: listWorkspaceFeatures(workspaceFeatures.deployment, disabled) };
    },
  );
  return toResponse(result);
}

/** `PUT /api/workspaces/:id/features` — replace the whole off set. Owner only. */
async function servePut(request: Request, context: FeaturesRouteContext): Promise<Response> {
  const id = await readIdParam(context);
  const application = applicationContext();
  if (application === null) return notConfigured();
  const { workspaces, workspaceFeatures } = application;
  const access = await requireResourceAccess(
    request,
    ownerOwnershipResolver(workspaces.repository, id),
  );
  if (!access.ok) return access.response;
  const body = await readJsonBody(request);
  if (!body.ok) return toResponse(body.result);

  const workspaceId = id as string;
  // The caller's own Membership in the path workspace: the audit row's actor is a principal of
  // `workspaceId`, which need not be the session's workspace. A miss fails closed with the 404.
  // Its label is the member's display name (`users.name`), as `setPublicSharingPolicy` records
  // `Principal.label`; never the session email.
  const { userId } = access.principal;
  const memberships = await application.rbac.directory.forWorkspace(workspaceId).listMemberships();
  const membership = memberships.find((member) => member.userId === userId);
  const repository = await workspaceFeatures.repositoryFor(workspaceId);
  if (userId === null || membership === undefined || repository === null) {
    return toResponse(workspaceNotFound());
  }
  return toResponse(
    await updateWorkspaceFeatures({
      deployment: workspaceFeatures.deployment,
      repository,
      recordAudit: (event) => workspaceFeatures.recordAuditEvent(event),
      provisionBuilder: () => workspaceFeatures.provisionBuilder(workspaceId),
      workspaceId,
      actor: {
        principalId: membership.principalId,
        userId: membership.userId,
        label: membership.name,
      },
      body: body.value,
    }),
  );
}

export const GET = route({ component: 'workspaces', operation: 'features.list' }, serveGet);
export const PUT = route({ component: 'workspaces', operation: 'features.set' }, servePut);
