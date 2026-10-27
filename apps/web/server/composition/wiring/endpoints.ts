import type { DatabaseRoot } from '@agent-workspace/core/db';

import type { A2aEnvironment } from '../../a2a/env';
import { versionToPin } from '../../agent-versions/session-version';
import { resolveAgentRunOwnership } from '../../agents/run-ownership';
import { readToolBundle } from '../../tool-bundles/handlers';
import { openToolBundleStore } from '../../tool-bundles/http';
import type { ToolEndpointEnvironment } from '../../tool-endpoint/env';
import { createToolEndpointSources } from '../../tool-endpoint/sources';
import { resolveDeploymentScope } from '../../surfaces/public/composition';
import type { AgentsWiring } from './agents';
import type { RunRuntimeWiring } from './run-runtime';
import type { SubsystemsWiring } from './subsystems';

export function wireEndpoints({
  root,
  scopes,
  agents,
  identifyAuditActor,
  secretsService,
  runnerManager,
  resolveProviderCredential,
  gatewaySettings,
}: Pick<AgentsWiring, 'scopes' | 'agents' | 'identifyAuditActor'> &
  Pick<SubsystemsWiring, 'secretsService' | 'runnerManager' | 'resolveProviderCredential'> &
  Pick<RunRuntimeWiring, 'gatewaySettings'> & {
    readonly root: DatabaseRoot;
  }) {
  const evaluationsOf = async (workspaceId: string) => {
    const scope = await scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error(`evaluation: workspace ${workspaceId} did not resolve`);
    return root.agentVersionEvaluations.forScope(scope);
  };
  // ADR-0135: an agent is published when its `production` pointer names a version; `list()` has
  // no by-name lookup, so the name is matched over the workspace's agents.
  // ponytail: O(agents + versions) per A2A call, `tasks/get` polls included; move to a by-name
  // lookup on the `agents_workspace_name_key` unique index plus a pointer read if that shows up.
  const publishedAgentIn = async (workspaceId: string, name: string) => {
    const scope = await scopes.forWorkspaceId(workspaceId);
    if (scope === null) return null;
    const agent = (await agents.forWorkspace(workspaceId).list()).find((a) => a.name === name);
    if (agent === undefined) return null;
    const listing = await root.agentVersions.forScope(scope).list(agent.id);
    const versionId = versionToPin(listing?.pointers ?? [], 'production');
    const version = listing?.versions.find((v) => v.id === versionId);
    return version === undefined
      ? null
      : {
          agentId: agent.id,
          name: agent.name,
          productionVersionId: version.id,
          versionNumber: version.number,
        };
  };
  const a2a: A2aEnvironment = {
    identify: async (request) => {
      const actor = await identifyAuditActor(request);
      if (actor === null) return null;
      return {
        principal: {
          principalId: actor.principalId,
          ownerPrincipalId: actor.ownerPrincipalId,
          userId: actor.userId,
          workspaceId: actor.workspaceId,
          role: actor.role,
          scope: actor.scope,
        },
        via: actor.via,
        apiKeyId: actor.apiKeyId,
        oauth: actor.oauth,
      };
    },
    findPublishedAgent: publishedAgentIn,
    // The workspace of the deployment, resolved as the hosted surfaces resolve theirs.
    findDeploymentAgent: async (name) => {
      const scope = await resolveDeploymentScope(process.env, scopes);
      return scope === null ? null : publishedAgentIn(scope.workspaceId, name);
    },
    now: () => Date.now(),
  };
  const toolEndpoint: ToolEndpointEnvironment = {
    identify: async (request) => {
      const actor = await identifyAuditActor(request);
      if (actor === null) return null;
      return {
        principal: {
          principalId: actor.principalId,
          ownerPrincipalId: actor.ownerPrincipalId,
          userId: actor.userId,
          workspaceId: actor.workspaceId,
          role: actor.role,
          scope: actor.scope,
        },
        via: actor.via,
        apiKeyId: actor.apiKeyId,
        oauth: actor.oauth,
        label: actor.label,
      };
    },
    agentOwnership: resolveAgentRunOwnership,
    ...createToolEndpointSources({
      scopes,
      agentVersions: root.agentVersions,
      runtimeProfiles: root.runtimeProfiles,
      providerCredential: resolveProviderCredential,
      secrets: secretsService,
      bundle: async (workspaceId, digest) => {
        const store = openToolBundleStore(workspaceId);
        return store === null ? null : readToolBundle(store, digest);
      },
      runnerManager,
      gatewaySettings,
    }),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
  };

  return { evaluationsOf, a2a, toolEndpoint };
}
