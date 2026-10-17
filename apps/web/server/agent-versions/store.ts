/**
 * The version store as the version routes see it (S1-05, issue #443; ADR-0101): one workspace's
 * agent versions, behind a port so a route test can run on {@link ./memory-store.ts} and the
 * deployment on `packages/core/src/db/repositories/agent-versions.ts` (S1-04).
 *
 * The port speaks core's own record and outcome types, imported as types, so the two halves cannot
 * drift in what a `create` or a `resolveDefinition` can answer. Like `../agents/store.ts`, no method
 * takes a workspace id: the store is bound to one when it is handed out.
 */
import type {
  AgentPointerMoveRecord,
  AgentSubagentCandidate,
  AgentVersionEvaluationRepositoryProvider,
  AgentVersionEnvironment,
  AgentVersionListing,
  AgentVersionRecord,
  AgentVersionRepositoryProvider,
  ApplyAndPointInput,
  ApplyAndPointOutcome,
  CreateAgentVersionInput,
  CreateAgentVersionOutcome,
  CreateAgentWithFirstVersionInput,
  CreateAgentWithFirstVersionOutcome,
  DefinitionReferences,
  PointedSurface,
  ReferenceIds,
  ReferenceNames,
  ResolveDefinitionOutcome,
  WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { EvaluationCaseResultSchema } from '@indx-workspace/contracts/evaluations';
import { z } from 'zod';

import type { LatestEvaluation } from './release';

/**
 * One workspace's agent versions: the operations the version routes (S1-05) and the pointer and
 * create-from-version routes (S1-06) need, and nothing more.
 */
export interface WorkspaceAgentVersionStore {
  /** Save the next numbered version of `agentId`. `not-found` covers another workspace's id. */
  create(agentId: string, input: CreateAgentVersionInput): Promise<CreateAgentVersionOutcome>;
  /** Every version of `agentId`, oldest first, and its pointers; `null` when there is no agent. */
  list(agentId: string): Promise<AgentVersionListing | null>;
  /** Resolve a definition's names inside this workspace (C7 lives here, not in the caller). */
  resolveDefinition(references: DefinitionReferences): Promise<ResolveDefinitionOutcome>;
  /** The names of the ids this workspace has, by kind; another workspace's id is absent. */
  namesOf(ids: ReferenceIds): Promise<ReferenceNames>;
  /** Which of the connector `names` are `stdio` MCP connectors of this workspace, sorted (issue #793). */
  stdioConnectorNames(names: readonly string[]): Promise<readonly string[]>;
  /** The id of each of this workspace's MCP connectors named one of `names`, by name (#1109). */
  mcpConnectorIdsByName(names: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * The agents of this workspace named `names`, by name; a name no agent has is absent.
   * `hasSubagents` reads the agent's materialised version body (ADR-0133 D14, one level).
   */
  agentsByName(names: readonly string[]): Promise<ReadonlyMap<string, AgentSubagentCandidate>>;
  /**
   * The other agents whose materialised version names `name` as a subagent, sorted;
   * `excludeAgentId` is the agent being saved (`null` before it exists).
   */
  subagentParents(name: string, excludeAgentId: string | null): Promise<readonly string[]>;
  /** Version `number` of `agentId`, or `null` when this workspace has no such version. */
  find(agentId: string, number: number): Promise<AgentVersionRecord | null>;
  /**
   * Materialise version `input.number` onto the agent row and its assignments, point
   * `input.environment` at it, check C9 and write the move's `agent-changed` audit row
   * (`input.audit`), in one transaction: a non-applied outcome writes nothing, and an audit row the
   * database refuses rejects and rolls the whole move back.
   */
  applyAndPoint(agentId: string, input: ApplyAndPointInput): Promise<ApplyAndPointOutcome>;
  /** Insert the agent, its assignments, version `1` and the pointer at it, in one transaction. */
  createAgentWithFirstVersion(
    input: CreateAgentWithFirstVersionInput,
  ): Promise<CreateAgentWithFirstVersionOutcome>;
  /**
   * The last `limit` pointer moves of `agentId`, newest first: of `environment`, or of every
   * environment when it is `null` (issue #615). Another workspace's agent has none.
   */
  listMoves(
    agentId: string,
    environment: AgentVersionEnvironment | null,
    limit: number,
  ): Promise<readonly AgentPointerMoveRecord[]>;
  /** The pointed version that serves surface `name` in `environment` (C9: at most one). */
  findPointedSurface(
    environment: AgentVersionEnvironment,
    name: string,
  ): Promise<PointedSurface | null>;
  /** The newest evaluation of the version with id `versionId`, or `null` (issue #619). */
  latestEvaluation(versionId: string): Promise<LatestEvaluation | null>;
}

/** Hands out a {@link WorkspaceAgentVersionStore}, or `null` when no workspace has that id. */
export interface AgentVersionStoreProvider {
  forWorkspace(workspaceId: string): Promise<WorkspaceAgentVersionStore | null>;
}

/** What {@link createRepositoryAgentVersionStoreProvider} needs: core's provider and scopes. */
export interface RepositoryAgentVersionStoreDependencies {
  readonly repositories: AgentVersionRepositoryProvider;
  /** The evaluations the promotion gate reads (issue #619). */
  readonly evaluations: AgentVersionEvaluationRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
}

const StoredResultsSchema = z.array(EvaluationCaseResultSchema);

/** The PostgreSQL {@link AgentVersionStoreProvider}: an adapter onto S1-04's repository. */
export function createRepositoryAgentVersionStoreProvider(
  dependencies: RepositoryAgentVersionStoreDependencies,
): AgentVersionStoreProvider {
  return {
    async forWorkspace(workspaceId: string): Promise<WorkspaceAgentVersionStore | null> {
      const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
      if (scope === null) return null;
      const repository = dependencies.repositories.forScope(scope);
      const evaluations = dependencies.evaluations.forScope(scope);
      return {
        create: (agentId, input) => repository.create(agentId, input),
        list: (agentId) => repository.list(agentId),
        resolveDefinition: (references) => repository.resolveDefinition(references),
        namesOf: (ids) => repository.namesOf(ids),
        stdioConnectorNames: (names) => repository.stdioConnectorNames(names),
        mcpConnectorIdsByName: (names) => repository.mcpConnectorIdsByName(names),
        agentsByName: (names) => repository.agentsByName(names),
        subagentParents: (name, excludeAgentId) => repository.subagentParents(name, excludeAgentId),
        find: (agentId, number) => repository.find(agentId, number),
        applyAndPoint: (agentId, input) => repository.applyAndPoint(agentId, input),
        createAgentWithFirstVersion: (input) => repository.createAgentWithFirstVersion(input),
        listMoves: (agentId, environment, limit) =>
          repository.listMoves(agentId, environment, limit),
        findPointedSurface: (environment, name) => repository.findPointedSurface(environment, name),
        async latestEvaluation(versionId) {
          const row = await evaluations.latest(versionId);
          if (row === null) return null;
          // The evaluation handler is the column's only writer, so a row that does not parse
          // throws (`500`).
          const results = StoredResultsSchema.parse(row.results);
          return {
            score: Number(row.score),
            passed: row.passed,
            total: row.total,
            failing: results.filter((result) => !result.passed).map((result) => result.name),
          };
        },
      };
    },
  };
}
