import {
  AgentCreatedAuditDetailsSchema,
  type AgentCreatedAuditDetails,
} from '@indx-workspace/contracts/observability';
import { type CreateAgentOutcome, type UpdateAgentOutcome } from '../../agents/store';
import type { MaterialisedAssignments, RecordedPointerAudit, SeededReferences } from './model';
import {
  narrowFileGrants,
  narrowStorageGrants,
  type AgentDefinitionReferenceKind,
  type MaterialisedAgent,
  type StorageGrantRef,
  type WorkspaceAgentVersionStore,
} from '../store';
/** A folder listed twice keeps one grant, as the table's unique key does. */
export function distinctFolders(grants: readonly StorageGrantRef[]): readonly StorageGrantRef[] {
  return [
    ...new Map(grants.map((grant) => [`${grant.connectionId}\n${grant.prefix}`, grant])).values(),
  ];
}

/** Core's `writeAssignments`: one row per id, file and storage grants under the #133 ceiling. */
export function toAssignments(agent: MaterialisedAgent): MaterialisedAssignments {
  return {
    skillIds: [...new Set(agent.references.skillIds)],
    skillRevisions: agent.references.skillRevisions,
    connectorIds: [...new Set(agent.references.connectorIds)],
    files: narrowFileGrants(agent.references.files, agent.permissions),
    storageGrants: narrowStorageGrants(agent.references.storageGrants ?? [], agent.permissions),
  };
}

/** `body.surfaces` read the way core's SQL does: a non-array is no surfaces, a nameless one skipped. */
export function surfacesOf(body: unknown): readonly StoredSurface[] {
  if (typeof body !== 'object' || body === null || !('surfaces' in body)) return [];
  const surfaces: unknown = body.surfaces;
  if (!Array.isArray(surfaces)) return [];
  return surfaces.flatMap((element: unknown) => {
    if (typeof element !== 'object' || element === null || !('name' in element)) return [];
    const name: unknown = element.name;
    return typeof name === 'string' ? [{ name, element }] : [];
  });
}

/** The seeded rows, with the skills being deleted moved out of `skill` (they do not resolve). */
export function deletingSkillsApart(seeded: SeededReferences) {
  const skills = seeded.skill ?? [];
  return {
    ...seeded,
    skill: skills.filter((row) => row.deleting !== true),
    deletingSkill: skills.filter((row) => row.deleting === true),
  };
}

/** Translate agent-store refusals to version-write outcomes. */
export function agentWriteRefusal(
  outcome: Exclude<
    UpdateAgentOutcome | CreateAgentOutcome,
    { readonly kind: 'updated' | 'created' }
  >,
):
  | { readonly kind: 'not-found' }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'reference-gone'; readonly referenceKind: AgentDefinitionReferenceKind } {
  switch (outcome.kind) {
    case 'not-found':
      return { kind: 'not-found' };
    case 'name-conflict':
      return { kind: 'name-conflict', name: outcome.name };
    case 'unknown-model-connection':
      return { kind: 'reference-gone', referenceKind: 'model-connection' };
    case 'unknown-runtime-profile':
      return { kind: 'reference-gone', referenceKind: 'runtime-profile' };
  }
}

/** The agent-row columns a materialisation sets, in the agent store's patch shape. */
export function rowOf(agent: MaterialisedAgent): {
  readonly name: string;
  readonly instructions: string;
  readonly model: string | null;
  readonly modelConnectionId: string | null;
  readonly runtimeProfileId: string | null;
  readonly permissions: MaterialisedAgent['permissions'];
} {
  return {
    name: agent.name,
    instructions: agent.instructions,
    model: agent.model,
    modelConnectionId: agent.references.modelConnectionId,
    runtimeProfileId: agent.references.runtimeProfileId,
    permissions: { ...agent.permissions },
  };
}

/**
 * The `agent-created` row of a create, parsed before the create writes anything; the new agent's id
 * does not exist yet, so the caller replaces the `PENDING` ids once it does. Null without the input.
 */
const PENDING = 'pending';

export function createdAuditRow(
  workspaceId: string,
  input: Parameters<WorkspaceAgentVersionStore['createAgentWithFirstVersion']>[0],
): (RecordedPointerAudit & { readonly details: AgentCreatedAuditDetails }) | null {
  if (input.agentCreatedAudit === undefined) return null;
  const { details, ...actor } = input.agentCreatedAudit;
  return {
    ...actor,
    workspaceId,
    action: 'agent-created',
    subjectId: PENDING,
    subjectLabel: input.agent.name,
    details: AgentCreatedAuditDetailsSchema.parse({
      ...details,
      agentId: PENDING,
      version: 1,
      via: input.version.via,
    }),
  };
}
interface StoredSurface {
  readonly name: string;
  readonly element: unknown;
}
