import { log } from '../../telemetry/logger';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import type { AgentVersionsRuntime } from '../../agent-versions/runtime';
import { createRepositoryAgentVersionStoreProvider } from '../../agent-versions/store';
import { createRepositoryAgentGrantStoreProvider } from '../../agents/agent-grants-store';
import { createRepositoryAgentResourceStoreProvider } from '../../agents/resource-store';
import type { AgentsRuntime, WorkspaceResolution } from '../../agents/runtime';
import { createRepositoryAgentStoreProvider } from '../../agents/store';
import type { AuditRuntime } from '../../audit/runtime';
import { readDeploymentDefaultModels } from '../../models/deployment-default';
import { createCeilingFor, type DeploymentCeiling } from '../../policy-ceiling/ceiling';
import { createResourceCatalogStoreProvider } from '../../resources/catalog-store';
import type { RunPrincipal } from '../../runs/environment';
import { restrictedUnenforceableReason } from '../../runtimes/network-policy';
import { createRunGate } from '../../workspaces/run-gate';
import { runnerManagerDriverId } from '../config';
import { installRbacApi } from '../session-rbac';

/**
 * Why this deployment's tool sandbox cannot enforce a code tool's `allowedDomains`, or `null`. The
 * runner starts the tool sandbox on the same driver as the agent sandbox, so the same capability
 * answers (#1018).
 */
function toolDomainsRefusalFromEnv(env: NodeJS.ProcessEnv): string | null {
  return restrictedUnenforceableReason(
    runnerManagerDriverId(env),
    (env['AGENT_WORKSPACE_EGRESS_PROXY_IMAGE']?.trim() ?? '') !== '',
  );
}

export async function wireAgents({
  root,
  sessionSecret,
  policyCeiling,
}: {
  readonly root: DatabaseRoot;
  readonly sessionSecret: string;
  readonly policyCeiling: ProjectPolicy | null;
}) {
  const principalIdentity = await installRbacApi(root, sessionSecret);
  const identifyAuditActor = (request: Request) => principalIdentity.identify(request);
  const identify = async (request: Request): Promise<RunPrincipal | null> => {
    const actor = await identifyAuditActor(request);
    return actor === null
      ? null
      : {
          principalId: actor.principalId,
          ownerPrincipalId: actor.ownerPrincipalId,
          userId: actor.userId,
          workspaceId: actor.workspaceId,
          role: actor.role,
          // Issue #236 (SDK-04, S-1): the browser token's attenuation has to survive this
          // projection or the run API decides with `null` and the token acts with its minter's
          // full width. `RunApiEnvironment`'s `RunPrincipal.scope` is required so that dropping it
          // here is a compile error rather than a silent widening.
          scope: actor.scope,
          // ADR-0142 D2: the run's caller identity is derived from these two.
          via: actor.via,
          kind: actor.kind,
        };
  };

  // One scope resolver and one provider, shared by both seams. `findAgent` on the run API and
  // `GET /api/agents` must see the same rows or a run could start against an agent the API says
  // does not exist.
  //
  // This is the line ADR-0024 exists for. Until it, `apps/web` contained no code that read or
  // wrote the database and an agent created through the UI was gone on the next restart. The
  // scope resolver is what turns the workspace id the routes carry into the `WorkspaceScope` the
  // repository will not run a query without.
  const scopes = root.scopes;
  const agents = createRepositoryAgentStoreProvider({ repositories: root.agents, scopes });
  const agentResources = createRepositoryAgentResourceStoreProvider({
    repositories: root.agentResources,
    scopes,
  });
  // issue #117: `POST /api/agents/:id/runs`'s Viewer "permitted" check.
  const agentGrants = createRepositoryAgentGrantStoreProvider({
    repositories: root.agentGrants,
    scopes,
  });
  const resourceCatalog = createResourceCatalogStoreProvider({
    repositories: root.resourceCatalogs,
    scopes,
  });
  const sessionRows = root.sessions;
  // Issue #119: one gate, shared by every seam below that creates a NEW run or session — see
  // `apps/web/server/workspaces/run-gate.ts` for why this is a module of its own rather than an
  // inline read at each call site.
  const runGate = createRunGate(root.workspaces);

  /**
   * Which workspace this request acts in, or why it acts in none.
   *
   * One closure, shared by the agents, secrets and files runtimes. Each of those three declared
   * its own structurally identical `WorkspaceResolution` type rather than importing a sibling
   * task's (see each `runtime.ts` header for why), but there must be exactly one *answer* in a
   * deployment: two resolvers reading the same cookie could disagree, and the one place a
   * disagreement about which workspace a request acts in would surface is a cross-tenant read.
   */
  const resolveWorkspace = async (request: Request): Promise<WorkspaceResolution> => {
    const result = await principalIdentity.resolveActor(request);
    // `unauthenticated` and `forbidden` are different answers and are kept apart: no valid
    // session at all is the first, a valid session whose account is not a member of the
    // workspace it names is the second. Collapsing them would report a revoked membership as a
    // forgotten login.
    if (result.kind !== 'workspace') return result;
    // This seam answers "which workspace", never "may this role": it carries no role and no
    // attenuation. The role decision is `decide()`'s, and every route handler of the families
    // this seam serves (agents, secrets, files, skills, connectors, runtime profiles and
    // connections, the runtime test) calls `requireResourceAccess` or `authorise` before it —
    // issue #388 closed the last handlers that did not (the secrets collection and `PUT`, the
    // runtime families, the connectors collection), which had let any member or API key of the
    // workspace reach them whatever its role.
    //
    // Issue #236 (SDK-04, S-1): a scoped credential is still refused here rather than silently
    // widened to its minter, exactly as `session-rbac.ts` refuses one, so a handler that ever
    // reached this seam without the gate would not hand a browser token its minter's width.
    if (result.principal.scope !== null) {
      return { kind: 'forbidden', reason: 'A scoped browser token does not reach this route.' };
    }
    return { kind: 'workspace', workspaceId: result.principal.workspaceId };
  };

  // Issue #506: the deployment default model, the run ladder's last layer, parsed once here. An
  // invalid value is reported without echoing it and treated as absent, so it fails closed: an
  // agent with a connection but no model is refused, not given a guessed model.
  const deploymentDefaults = readDeploymentDefaultModels(process.env);
  if (!deploymentDefaults.ok) {
    log.error(`[compose] AW_DEPLOYMENT_DEFAULT_MODELS ignored: ${deploymentDefaults.reason}`);
  }
  const deploymentDefaultModels = deploymentDefaults.ok ? deploymentDefaults.defaults : {};
  // Issue #535: one ceiling, handed to every write path that can widen an agent — the agents and
  // version runtimes, the run API and setup. `disabled` only when no ceiling is configured, so each
  // of those paths is unchanged; a configured ceiling is always `enforced`.
  const ceiling: DeploymentCeiling =
    policyCeiling === null
      ? { kind: 'disabled' }
      : {
          kind: 'enforced',
          ceilingFor: createCeilingFor({
            policy: policyCeiling,
            deploymentDefaultModels,
            modelProvider: async (workspaceId, connectionId) => {
              const scope = await scopes.forWorkspaceId(workspaceId);
              if (scope === null) return null;
              const connection = await root.modelConnections.forScope(scope).get(connectionId);
              return connection?.provider ?? null;
            },
            connectorName: async (workspaceId, connectorId) => {
              const scope = await scopes.forWorkspaceId(workspaceId);
              if (scope === null) return null;
              return (await root.mcpServers.forScope(scope).get(connectorId))?.name ?? null;
            },
            identifyActor: identifyAuditActor,
            recordAuditEvent: (event) => root.recordAuditEvent(event),
          }),
        };
  // The run API still takes the ceiling as an optional `ceilingFor`.
  const withCeiling = ceiling.kind === 'enforced' ? { ceilingFor: ceiling.ceilingFor } : {};

  // PR #403 review: the agent first-run setup configured, which the composer selects first.
  const setupAgentId = (workspaceId: string): Promise<string | null> =>
    root.getWorkspaceSetupAgentId(workspaceId);
  // The agents runtime, all but the runtime-switch audit sink `wireSubsystems` builds.
  const agentsRuntime: Omit<AgentsRuntime, 'runtimeSwitchAudit'> = {
    agents,
    agentResources,
    agentGrants,
    resolveWorkspace,
    skillCatalog: resourceCatalog,
    setupAgentId,
    ceiling,
  };
  // S1-05 (#443): `GET`/`POST /api/agents/:id/versions`, installed by the composition root.
  const agentVersions: AgentVersionsRuntime = {
    versions: createRepositoryAgentVersionStoreProvider({
      repositories: root.agentVersions,
      evaluations: root.agentVersionEvaluations,
      scopes,
    }),
    // The runner manager starts the tool sandbox from this image (ADR-0118); the web reads the
    // same variable, so both processes must be given it. Empty keeps code-tool promotion refused.
    toolHost: (process.env['AGENT_WORKSPACE_TOOL_HOST_IMAGE']?.trim() ?? '') !== '',
    // The runner starts the tool sandbox on the same driver as the agent sandbox, so the same
    // capability says whether it can enforce a code tool's `allowedDomains` (#1018).
    toolDomainsRefusal: toolDomainsRefusalFromEnv(process.env),
    ceiling,
  };
  const audit: AuditRuntime = { scopes, repositories: root.auditEventRepository };
  const { configureTelemetryRuntime, recordRunTelemetry } = await import('../../telemetry/runtime');
  const telemetryConfigured = await configureTelemetryRuntime(process.env);
  log.info(
    telemetryConfigured
      ? '[compose] OpenTelemetry installed: exporting traces to OTEL_EXPORTER_OTLP_ENDPOINT'
      : '[compose] OpenTelemetry disabled: OTEL_EXPORTER_OTLP_ENDPOINT is unset',
  );
  log.info(
    '[compose] agent API installed: session cookie → PostgreSQL membership → PostgreSQL agent repository',
  );
  // The inventory an operator needs, printed rather than left to be inferred from a 200. Every
  // line is a statement about what a restart keeps, and the one that is not durable says so in
  // capitals, because that is the line somebody will be reading at the moment it matters.
  log.info(
    '[compose] persistence: agents durable (PostgreSQL) · run records durable (PostgreSQL) · ' +
      'run events durable and replayable (PostgreSQL run_events) · ' +
      'session transcripts durable with authenticated runner mirroring and resume',
  );

  return {
    principalIdentity,
    identifyAuditActor,
    identify,
    agentsRuntime,
    agentVersions,
    audit,
    scopes,
    agents,
    agentResources,
    resourceCatalog,
    sessionRows,
    runGate,
    resolveWorkspace,
    deploymentDefaultModels,
    withCeiling,
    recordRunTelemetry,
  };
}

export type AgentsWiring = Awaited<ReturnType<typeof wireAgents>>;
