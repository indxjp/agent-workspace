/**
 * The one place the Builder's production adapters are built (issue #1846 slice 4). The composition
 * root hands this module the stores it already opened; `POST /api/builder/mcp` only reads the
 * ports from the application context and never constructs one.
 */
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import type { AgentVersionsRuntime } from '../../agent-versions/runtime';
import type { StorageConnectionLookup } from '../../agent-versions/storage-grants';
import type { AgentStoreProvider } from '../../agents/store';
import type { ConnectorsStoreProvider } from '../../connectors/store';
import type { ModelsStoreProvider } from '../../models/store';
import type { RuntimeProfileStoreProvider } from '../../runtimes/store';
import { enabledFeaturesFor } from '../../features/runtime';
import type { DirectoryRoot } from '../../rbac/directory';
import type { ToolBundleLookup } from '../../tool-bundles/handlers';
import type { ActorLabel } from '../adapters/actor-label';
import { createApproval, type ApprovalDependencies } from '../adapters/approval/production';
import { createAudit, type AuditDeps } from '../adapters/audit/store';
import { createAuthorization, type AuthorizationDeps } from '../adapters/authorization/production';
import { createCatalog, type CatalogDependencies } from '../adapters/catalog/production';
import { createChecker } from '../adapters/checker/production';
import { createPolicy } from '../adapters/policy/production';
import { createRunner, type RunnerDependencies } from '../adapters/runner/production';
import { createAgentStore } from '../adapters/store/production';
import type { CallContext } from '../ports';
import type { BuilderPorts } from '../tools/types';
import type { BuilderRunReader } from './call-context';

type Scope = NonNullable<Awaited<ReturnType<AuditDeps['scopes']['forWorkspaceId']>>>;

/** What the Builder's adapters read, as the composition root already holds it. */
export interface BuilderCompositionRoot {
  readonly agents: AgentStoreProvider;
  readonly agentGrants?: AuthorizationDeps['grants'];
  readonly versions: AgentVersionsRuntime;
  readonly connectors: ConnectorsStoreProvider;
  readonly models: ModelsStoreProvider;
  readonly runtimeProfiles: RuntimeProfileStoreProvider;
  readonly skills: CatalogDependencies['skills'];
  readonly storageConnections: (workspaceId: string) => StorageConnectionLookup | null;
  readonly toolBundles: (workspaceId: string) => ToolBundleLookup | null;
  readonly journal: Pick<AuditDeps, 'repositories' | 'scopes'>;
  readonly directory: Pick<DirectoryRoot, 'forWorkspace'>;
  /** The run records the gateway's approval backstop consumes. */
  readonly approvals: ApprovalDependencies<Scope>;
  readonly runApi: RunnerDependencies['runApi'];
  /** The deployment's `AW_DEPLOYMENT_POLICY`: the only ceiling that says which agents may build. */
  readonly deploymentPolicy: ProjectPolicy | null;
}

/**
 * The version pipeline's ceiling needs a request only to name the actor of a refusal's audit row,
 * which a dry run never writes. This one carries no credential, so if a row were ever attempted it
 * would find no actor and fail.
 */
const NO_ACTOR_REQUEST = new Request('http://builder.invalid/api/builder/mcp');

export function productionBuilderPorts(root: BuilderCompositionRoot): BuilderPorts {
  const { ceiling, toolHost, toolDomainsRefusal } = root.versions;
  const pipeline = (ctx: CallContext) => ({
    ceiling:
      ceiling.kind === 'enforced' ? ceiling.ceilingFor(NO_ACTOR_REQUEST, ctx.workspaceId) : null,
    toolBundles: root.toolBundles(ctx.workspaceId),
    storageConnections: root.storageConnections(ctx.workspaceId),
    toolHost,
    toolDomainsRefusal,
  });
  const actorLabel: ActorLabel = async (workspaceId, principalId) => {
    const member = await root.directory
      .forWorkspace(workspaceId)
      .findMembershipByPrincipal(principalId);
    if (member === null) throw new Error('The acting person is not a member of the workspace.');
    return member.email;
  };
  return {
    feature: {
      enabled: async (ctx) => (await enabledFeaturesFor(ctx.workspaceId)).includes('builder'),
    },
    approval: createApproval(root.approvals),
    authorization: createAuthorization({
      agents: root.agents,
      grants: root.agentGrants,
      versions: root.versions.versions,
      ceiling: root.deploymentPolicy,
    }),
    policy: createPolicy(),
    checker: createChecker({ agents: root.agents, versions: root.versions.versions, pipeline }),
    store: createAgentStore({
      agents: root.agents,
      versions: root.versions.versions,
      pipeline,
      actorLabel,
    }),
    runner: createRunner({
      agents: root.agents,
      versions: root.versions.versions,
      runApi: root.runApi,
      ...(root.agentGrants === undefined ? {} : { grants: root.agentGrants }),
    }),
    catalog: createCatalog({
      connectors: root.connectors,
      models: root.models,
      runtimeProfiles: root.runtimeProfiles,
      skills: root.skills,
    }),
    audit: createAudit(root.journal),
    clock: () => new Date(),
  };
}

/** The slice of the database the run reader reads; a `DatabaseRoot` satisfies it. */
export interface BuilderRunDatabase<Scope> {
  readonly scopes: { forWorkspaceId(workspaceId: string): Promise<Scope | null> };
  readonly runs: {
    forScope(scope: Scope): {
      get(runId: string): Promise<{
        readonly agentId: string;
        readonly model: string | null;
        readonly agentVersion?: number | null;
        readonly approvedToolCalls?: readonly { readonly canonicalCall: string }[];
      } | null>;
    };
  };
  readonly agentVersions: {
    forScope(scope: Scope): {
      find(
        agentId: string,
        number: number,
      ): Promise<{
        readonly id: string;
        readonly number: number;
        readonly summary: string;
      } | null>;
    };
  };
}

/** The run's model and pinned version; a run without either is not one the Builder answers. */
export function builderRunReader<Scope>(database: BuilderRunDatabase<Scope>): BuilderRunReader {
  return async ({ workspaceId, runId, agentId }) => {
    const scope = await database.scopes.forWorkspaceId(workspaceId);
    if (scope === null) return null;
    const run = await database.runs.forScope(scope).get(runId);
    if (run?.agentId !== agentId || run.model === null) return null;
    if (run.agentVersion === null || run.agentVersion === undefined) return null;
    const version = await database.agentVersions.forScope(scope).find(agentId, run.agentVersion);
    return version === null
      ? null
      : {
          modelId: run.model,
          agentVersion: { id: version.id, number: version.number, summary: version.summary },
        };
  };
}
