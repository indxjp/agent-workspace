import { ProjectResourceSchema, type ProjectResource } from '../../contracts/projects';

interface StoredProject {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly instructions: string | null;
  readonly defaultAgentId: string | null;
  readonly defaultModelConnectionId: string | null;
  readonly defaultModel: string | null;
  readonly visibility: 'private' | 'workspace' | 'public';
  readonly createdBy: string | null;
  readonly ownerPrincipalId: string;
  /** issue #183: the lifecycle column `#182` added, published so archiving is observable. */
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Convert a persistence record into the validated public HTTP representation. */
export function toProjectResource(
  project: StoredProject,
  fileIds: readonly string[],
  mcpServerIds: readonly string[],
): ProjectResource {
  return ProjectResourceSchema.parse({
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    instructions: project.instructions,
    defaultAgentId: project.defaultAgentId,
    defaultModelConnectionId: project.defaultModelConnectionId,
    defaultModel: project.defaultModel,
    visibility: project.visibility,
    createdBy: project.createdBy,
    ownerPrincipalId: project.ownerPrincipalId,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    fileIds,
    mcpServerIds,
  });
}
