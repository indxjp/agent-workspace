/**
 * Server-side agent records and their serialization for the five agent routes of spec §34. The
 * request bodies are validated by `CreateAgentInputSchema` and `UpdateAgentPatchSchema` in
 * `@indx-workspace/contracts/agents`; persistence-only `AgentRecord` stays here so browser code
 * cannot acquire a server dependency.
 */
import type { AgentCreatedByAgent, BuiltinAgentKey } from '@indx-workspace/contracts/agents';
import { SkillRevisionPinsByIdSchema } from '@indx-workspace/contracts/skills';

import type {
  AgentPermissions,
  AgentPolicy,
  AgentResource,
  AgentResourceAssignmentsInput,
} from '../../contracts/agents';

export { isUuid } from '@indx-workspace/contracts';

/**
 * One agent as the store holds it — the `agents` table's columns, with timestamps as `Date`.
 *
 * `workspaceId` is present because the record is the store's, not the wire's; {@link toAgentResource}
 * decides what crosses the wire.
 */
export interface AgentRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly instructions: string;
  readonly modelConnectionId: string | null;
  readonly model: string | null;
  readonly runtimeProfileId: string | null;
  readonly permissions: AgentPermissions;
  /** `null` means "compile from `permissions` and the assigned resources" (S-13). */
  readonly policy: AgentPolicy | null;
  /** Legacy human creator attribution, or `null` when an API-key principal created the row. */
  readonly createdBy: string | null;
  readonly ownerPrincipalId: string;
  /** Which built-in agent this is; absent on every ordinary agent. */
  readonly builtin?: BuiltinAgentKey;
  /** Lineage of an agent made by an agent; absent on a person-made agent (issue #1851). */
  readonly createdByAgent?: AgentCreatedByAgent;
  /** When the agent was archived; absent while active (issue #1851). */
  readonly archivedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Serialise a stored agent for the wire. The only transformation is `Date` → ISO-8601. */
export function toAgentResource(agent: AgentRecord): AgentResource {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    name: agent.name,
    instructions: agent.instructions,
    modelConnectionId: agent.modelConnectionId,
    model: agent.model,
    runtimeProfileId: agent.runtimeProfileId,
    permissions: { ...agent.permissions },
    createdBy: agent.createdBy,
    ownerPrincipalId: agent.ownerPrincipalId,
    ...(agent.builtin === undefined ? {} : { builtin: agent.builtin }),
    ...(agent.createdByAgent === undefined ? {} : { createdByAgent: agent.createdByAgent }),
    ...(agent.archivedAt === undefined ? {} : { archivedAt: agent.archivedAt.toISOString() }),
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

/** The assignment arrays of `PUT /api/agents/:id/resources` and the compound create, or `null`. */
export function parseAssignments(raw: unknown): AgentResourceAssignmentsInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (
    !Array.isArray(body['files']) ||
    !Array.isArray(body['skillIds']) ||
    !Array.isArray(body['connectorIds'])
  )
    return null;
  const files = body['files'];
  if (
    !files.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>)['fileId'] === 'string' &&
        ((entry as Record<string, unknown>)['access'] === 'read' ||
          (entry as Record<string, unknown>)['access'] === 'read-write'),
    )
  )
    return null;
  const skillIds: unknown[] = body['skillIds'];
  if (
    !skillIds.every((id) => typeof id === 'string') ||
    !body['connectorIds'].every((id) => typeof id === 'string')
  )
    return null;
  const pins =
    body['skillRevisions'] === undefined
      ? null
      : SkillRevisionPinsByIdSchema.safeParse(body['skillRevisions']);
  if (
    pins !== null &&
    (!pins.success || Object.keys(pins.data).some((id) => !skillIds.includes(id)))
  )
    return null;
  return {
    files: files as unknown as AgentResourceAssignmentsInput['files'],
    skillIds: body['skillIds'],
    ...(pins?.success === true ? { skillRevisions: pins.data } : {}),
    connectorIds: body['connectorIds'],
  };
}
