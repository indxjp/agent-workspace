import {
  isUnresolvableModelConnection,
  json,
  parseProjectPatch,
  problem,
  projectConnectorKindRefusal,
  requireProjectAccess,
  withProjects,
} from '../../../../server/projects/http';
import { toProjectResource } from '../../../../server/projects/resource';
import { errorResponse } from '../../../../server/http/error-response';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withProjects(request, async ({ projects, files, mcpServers, actor }) => {
    const p = await projects.get(id);
    if (p) {
      const access = await requireProjectAccess(request, actor, p.ownerPrincipalId);
      if (!access.ok) return access.response;
    }
    return p
      ? Response.json(toProjectResource(p, await files.list(id), await mcpServers.list(id)))
      : problem(404, 'project_not_found', 'Project not found.');
  });
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return await withProjects(request, async ({ projects, files, mcpServers, actor }) => {
      const existing = await projects.get(id);
      if (existing) {
        const access = await requireProjectAccess(request, actor, existing.ownerPrincipalId);
        if (!access.ok) return access.response;
      }
      const input = parseProjectPatch(await json(request));
      const p = await projects.updateWithAssociations(
        id,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          ...(input.defaultAgentId === undefined ? {} : { defaultAgentId: input.defaultAgentId }),
          ...(input.defaultModelConnectionId === undefined
            ? {}
            : { defaultModelConnectionId: input.defaultModelConnectionId }),
          ...(input.defaultModel === undefined ? {} : { defaultModel: input.defaultModel }),
          ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
        },
        input.fileIds,
        input.mcpServerIds,
      );
      return p
        ? Response.json(
            toProjectResource(
              p,
              input.fileIds ?? (await files.list(id)),
              input.mcpServerIds ?? (await mcpServers.list(id)),
            ),
          )
        : problem(404, 'project_not_found', 'Project not found.');
    });
  } catch (error) {
    const kindRefusal = projectConnectorKindRefusal(error);
    if (kindRefusal !== null) return kindRefusal;
    // issue #153 §25: a cross-workspace defaultModelConnectionId and a nonexistent one hit the
    // identical composite foreign key, and answer identically here — never the generic 500
    // `errorResponse` would otherwise give an unclassified persistence failure, which would both
    // hide the real cause from an operator and (worse) reveal, by its different shape, that the
    // two cases are not the same rejection.
    if (isUnresolvableModelConnection(error)) {
      return problem(
        400,
        'unknown_model_connection',
        'defaultModelConnectionId does not name a model connection in this workspace.',
      );
    }
    return errorResponse(error, { component: 'projects', operation: 'update' });
  }
}
