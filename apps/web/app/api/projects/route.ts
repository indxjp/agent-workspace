import { log } from '../../../server/telemetry/logger';
import {
  json,
  parseProject,
  parseProjectListFilter,
  projectConnectorKindRefusal,
  requireProjectAccess,
  withProjects,
} from '../../../server/projects/http';
import { ownerPrincipalIdOf } from '../../../server/rbac/owner-principal';
import { toProjectResource } from '../../../server/projects/resource';
import { ProjectListResponseSchema } from '../../../contracts/projects';
import { InfrastructureError } from '../../../server/errors';
import { errorResponse } from '../../../server/http/error-response';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    return await listProjects(request);
  } catch (error) {
    return errorResponse(error, { component: 'projects', operation: 'list' });
  }
}
function listProjects(request: Request) {
  return withProjects(request, async ({ projects, files, mcpServers, actor }) => {
    const access = await requireProjectAccess(request, actor);
    if (!access.ok) return access.response;
    // issue #183: `active` unless the caller asks otherwise, so this response is unchanged for
    // every existing caller while an archived project stays reachable through the same route.
    const visible = (await projects.list(parseProjectListFilter(request))).filter(
      (project) =>
        access.principal.role === 'owner' ||
        access.principal.role === 'admin' ||
        project.ownerPrincipalId === ownerPrincipalIdOf(actor),
    );
    const response = {
      projects: await Promise.all(
        visible.map(async (project) =>
          toProjectResource(
            project,
            await files.list(project.id),
            await mcpServers.list(project.id),
          ),
        ),
      ),
    };
    return Response.json(ProjectListResponseSchema.parse(response));
  });
}
export async function POST(request: Request) {
  try {
    return await withProjects(request, async ({ projects, audit, actor }) => {
      const access = await requireProjectAccess(request, actor);
      if (!access.ok) return access.response;
      const input = parseProject(await json(request));
      const created = await projects.createWithAssociations(
        {
          name: input.name,
          instructions: input.instructions,
          defaultAgentId: input.defaultAgentId,
          visibility: input.visibility,
          ownerPrincipalId: ownerPrincipalIdOf(actor),
          createdBy: actor.userId,
        },
        input.fileIds,
        input.mcpServerIds,
      );
      try {
        await audit.write({
          actorPrincipalId: actor.principalId,
          actorUserId: actor.userId,
          actorLabel: actor.userLabel,
          action: 'project-created',
          subjectId: created.id,
          subjectLabel: created.name,
        });
      } catch (error) {
        // The project and its associations have already committed atomically. Reporting a 4xx
        // here would invite a retry that creates a duplicate project; auditing is best effort at
        // this boundary until it can participate in the repository transaction.
        log.error('[projects] project-created audit write failed', {
          error: new InfrastructureError({
            component: 'projects',
            operation: 'write-create-audit',
            cause: error,
          }),
        });
      }
      return Response.json(toProjectResource(created, input.fileIds, input.mcpServerIds), {
        status: 201,
      });
    });
  } catch (error) {
    return (
      projectConnectorKindRefusal(error) ??
      errorResponse(error, { component: 'projects', operation: 'create' })
    );
  }
}
