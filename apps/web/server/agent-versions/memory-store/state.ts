import { type WorkspaceAgentStore } from '../../agents/store';
import type {
  InMemoryAgentVersionStoreOptions,
  MaterialisedAssignments,
  RecordedPointerAudit,
  SeededPointer,
} from './model';
import type { LatestEvaluation } from '../release';
import {
  type AgentPointerMoveReason,
  type AgentPointerMoveRecord,
  type AgentVersionPointerRecord,
  type AgentVersionRecord,
  type StorageGrantRef,
} from '../store';

export function createMemoryVersionState(options: InMemoryAgentVersionStoreOptions) {
  const versions: AgentVersionRecord[] = [];

  const pointers: SeededPointer[] = [];

  const audits: RecordedPointerAudit[] = [];

  /** The pointer history, oldest first. */
  const moves: (AgentPointerMoveRecord & {
    readonly workspaceId: string;
    readonly agentId: string;
  })[] = [];

  const assignments = new Map<string, MaterialisedAssignments>();

  /** Each version's own storage grants, by version id (`agent_version_storage_grants`). */
  const versionGrants = new Map<string, readonly StorageGrantRef[]>();

  /** The newest evaluation of each version id; a version id is unique across workspaces. */
  const evaluations = new Map<string, LatestEvaluation>();

  // The memory agent store has no materialised_version_id: an updatedAt change invalidates it.
  const writtenFrom = new Map<string, { versionId: string; agentUpdatedAt: number }>();

  const now = options.now ?? ((): Date => new Date());

  const countCreatedSince = async (
    workspaceAgents: Pick<WorkspaceAgentStore, 'list'>,
    since: Date,
  ): Promise<number> =>
    (await workspaceAgents.list()).filter(
      (agent) => agent.builtin === undefined && agent.createdAt >= since,
    ).length;

  const newId = options.newId ?? ((): string => crypto.randomUUID());

  const principalIsUnknown = (principalId: string): boolean =>
    options.knownPrincipalIds !== undefined && !options.knownPrincipalIds.has(principalId);

  /** Insert or move the pointer of one agent and environment, and append the move (core's). */
  const movePointer = (
    pointer: SeededPointer,
    reason: AgentPointerMoveReason,
    movedByPrincipalId: string | null,
  ): AgentVersionPointerRecord => {
    const index = pointers.findIndex(
      (row) =>
        row.workspaceId === pointer.workspaceId &&
        row.agentId === pointer.agentId &&
        row.environment === pointer.environment,
    );
    if (index === -1) pointers.push(pointer);
    else pointers.splice(index, 1, pointer);
    moves.push({
      workspaceId: pointer.workspaceId,
      agentId: pointer.agentId,
      environment: pointer.environment,
      number: pointer.number,
      reason,
      movedByPrincipalId,
      movedAt: pointer.updatedAt,
    });
    return {
      agentId: pointer.agentId,
      environment: pointer.environment,
      versionId: pointer.versionId,
      number: pointer.number,
      updatedAt: pointer.updatedAt,
    };
  };
  return {
    options,
    versions,
    pointers,
    audits,
    moves,
    assignments,
    versionGrants,
    evaluations,
    writtenFrom,
    now,
    countCreatedSince,
    newId,
    principalIsUnknown,
    movePointer,
  };
}
export type MemoryVersionState = ReturnType<typeof createMemoryVersionState>;
