import { deletingSkillsApart, surfacesOf } from './rows';
import type { LatestEvaluation } from '../release';
import {
  resolveFromRows,
  type AgentDefinitionReferenceKind,
  type AgentPointerMoveRecord,
  type AgentVersionListing,
  type AgentVersionRecord,
  type PointedSurface,
  type ReferenceNames,
  type ResolveDefinitionOutcome,
  type StorageGrantRef,
  type WorkspaceAgentVersionStore,
} from '../store';

import type { MemoryVersionWorkspace } from './workspace';
export function createMemoryVersionQueries(
  workspace: MemoryVersionWorkspace,
): Pick<
  WorkspaceAgentVersionStore,
  | 'list'
  | 'find'
  | 'resolveDefinition'
  | 'agentsByName'
  | 'subagentParents'
  | 'namesOf'
  | 'stdioConnectorNames'
  | 'mcpConnectorIdsByName'
  | 'storageGrantsOf'
  | 'isConnectionGranted'
  | 'agentsCreatedSince'
  | 'listMoves'
  | 'findPointedSurface'
  | 'latestEvaluation'
> {
  const {
    versions,
    pointers,
    moves,
    assignments,
    versionGrants,
    evaluations,
    writtenFrom,
    countCreatedSince,
    options,
    workspaceId,
    agents,
    agentExists,
    versionsOf,
    versionById,
    parentsOf,
    pointedIn,
    agentsByName,
  } = workspace;
  return {
    async list(agentId): Promise<AgentVersionListing | null> {
      const agent = await agents.get(agentId);
      if (agent === null) return null;
      const written = writtenFrom.get(agentId);
      return {
        materialisedVersionId:
          written?.agentUpdatedAt === agent.updatedAt.getTime() ? written.versionId : null,
        versions: versionsOf(agentId).sort((left, right) => left.number - right.number),
        pointers: pointers
          .filter((row) => row.workspaceId === workspaceId && row.agentId === agentId)
          .map((row) => ({
            agentId: row.agentId,
            environment: row.environment,
            versionId: row.versionId,
            number: row.number,
            updatedAt: row.updatedAt,
          })),
      };
    },

    find(agentId, number): Promise<AgentVersionRecord | null> {
      return Promise.resolve(versionsOf(agentId).find((row) => row.number === number) ?? null);
    },

    resolveDefinition(references): Promise<ResolveDefinitionOutcome> {
      return Promise.resolve(
        resolveFromRows(
          references,
          deletingSkillsApart(options.references?.[workspaceId] ?? {}),
          options.defaultRuntimeProfiles?.[workspaceId] ?? null,
        ),
      );
    },

    agentsByName,

    subagentParents(name, excludeAgentId): Promise<readonly string[]> {
      return parentsOf(name, excludeAgentId);
    },

    namesOf(ids): Promise<ReferenceNames> {
      const seeded = options.references?.[workspaceId] ?? {};
      const byId = (kind: AgentDefinitionReferenceKind): ReadonlyMap<string, string> => {
        const wanted = new Set(ids[kind] ?? []);
        return new Map(
          (seeded[kind] ?? [])
            .filter((row) => wanted.has(row.id) && row.deleting !== true)
            .map((row) => [row.id, row.name]),
        );
      };
      return Promise.resolve({
        skill: byId('skill'),
        connector: byId('connector'),
        file: byId('file'),
        'model-connection': byId('model-connection'),
        'runtime-profile': byId('runtime-profile'),
      });
    },

    stdioConnectorNames(names): Promise<readonly string[]> {
      const wanted = new Set(names);
      return Promise.resolve(
        (options.references?.[workspaceId]?.connector ?? [])
          .filter((row) => row.stdio === true && wanted.has(row.name))
          .map((row) => row.name)
          .sort(),
      );
    },

    mcpConnectorIdsByName(names): Promise<ReadonlyMap<string, string>> {
      const wanted = new Set(names);
      return Promise.resolve(
        new Map(
          (options.references?.[workspaceId]?.connector ?? [])
            .filter((row) => row.tool !== true && wanted.has(row.name))
            .map((row) => [row.name, row.id]),
        ),
      );
    },

    async storageGrantsOf(versionId): Promise<readonly StorageGrantRef[]> {
      const own = versions.some((row) => row.id === versionId && row.workspaceId === workspaceId);
      const grants = own ? (versionGrants.get(versionId) ?? []) : [];
      const exists = options.connectionExists;
      if (exists === undefined) return grants;
      const live = await Promise.all(
        grants.map((grant) => exists(workspaceId, grant.connectionId)),
      );
      return grants.filter((_grant, index) => live[index] === true);
    },

    async isConnectionGranted(connectionId): Promise<boolean> {
      for (const [agentId, row] of assignments) {
        if (
          row.storageGrants.some((grant) => grant.connectionId === connectionId) &&
          (await agentExists(agentId))
        ) {
          return true;
        }
      }
      return false;
    },

    agentsCreatedSince: (since) => countCreatedSince(agents, since),

    listMoves(agentId, environment, limit): Promise<readonly AgentPointerMoveRecord[]> {
      return Promise.resolve(
        moves
          .filter(
            (row) =>
              row.workspaceId === workspaceId &&
              row.agentId === agentId &&
              (environment === null || row.environment === environment),
          )
          .reverse()
          .slice(0, limit)
          .map(({ environment: env, number, reason, movedByPrincipalId, movedAt }) => ({
            environment: env,
            number,
            reason,
            movedByPrincipalId,
            movedAt,
          })),
      );
    },

    findPointedSurface(environment, name): Promise<PointedSurface | null> {
      for (const pointer of pointedIn(environment)) {
        const version = versionById(pointer.versionId);
        const surface = surfacesOf(version?.body).find((candidate) => candidate.name === name);
        if (version !== undefined && surface !== undefined) {
          return Promise.resolve({
            agentId: pointer.agentId,
            versionId: version.id,
            number: version.number,
            surface: surface.element,
          });
        }
      }
      return Promise.resolve(null);
    },

    latestEvaluation(versionId): Promise<LatestEvaluation | null> {
      const owned = versions.some((row) => row.workspaceId === workspaceId && row.id === versionId);
      return Promise.resolve(owned ? (evaluations.get(versionId) ?? null) : null);
    },
  };
}
