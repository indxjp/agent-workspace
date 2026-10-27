/**
 * The two parts of the tool endpoint's environment that read the workspace: which code tools the
 * client's agents publish at `production`, and how a call reaches their sandbox. Every read is
 * scoped to the caller's workspace; the composition root supplies the stores.
 */
import type { SecretsService } from '@agent-workspace/core/secrets';
import {
  GATEWAY_TOOL_SANDBOX_ENDPOINT_ROUTE,
  createEndpointGrantCodec,
  endpointSandboxRunId,
  toolSandboxRunToken,
} from '@agent-workspace/gateway/tokens';
import type { AgentVersionToolBundle } from '@indx-workspace/contracts/agent-versions';

import { toAgentVersionResource } from '../agent-versions/contract';
import { versionToPin } from '../agent-versions/session-version';
import type { RuntimeManagerClient } from '../compose/runtime-manager-client';
import type { ProviderCredentialSpec } from '../compose/runtime-provider-credential';
import { buildToolSandboxRequest } from '../compose/tool-sandbox';
import type { GatewayIssuerSettingsResult } from '../gateway/issuer';
import type { ToolEndpointEnvironment } from './env';
import type { EndpointAgentVersions, EndpointRuntimeProfiles, WorkspaceScope } from './store';

export interface ToolEndpointSourceDependencies {
  readonly scopes: { forWorkspaceId(workspaceId: string): Promise<WorkspaceScope | null> };
  readonly agentVersions: EndpointAgentVersions;
  /** Where the workspace's default runtime profile is read; it picks the sandbox's credential. */
  readonly runtimeProfiles: EndpointRuntimeProfiles;
  readonly providerCredential: (
    workspaceId: string,
    spec: ProviderCredentialSpec,
  ) => Promise<string | undefined>;
  readonly secrets: Pick<SecretsService, 'resolveByName'> | null;
  /** The bytes stored for `digest` in `workspaceId`'s bundle store, or `null`. */
  readonly bundle: (workspaceId: string, digest: string) => Promise<Uint8Array | null>;
  readonly runnerManager: Pick<RuntimeManagerClient, 'openToolSandbox' | 'closeToolSandbox'> | null;
  readonly gatewaySettings: GatewayIssuerSettingsResult;
}

export function createToolEndpointSources(
  deps: ToolEndpointSourceDependencies,
): Pick<ToolEndpointEnvironment, 'productionToolBundles' | 'route' | 'closeSandbox'> {
  const defaultProfileCredential = async (workspaceId: string, scope: WorkspaceScope) => {
    const profile = await deps.runtimeProfiles.forScope(scope).findWorkspaceDefault();
    if (profile === null) return { profile: null, providerCredential: undefined };
    const providerCredential = await deps.providerCredential(workspaceId, {
      driver: profile.driver,
      runtimeProfileId: profile.id,
      ...(profile.runtimeConnectionId === null
        ? {}
        : { runtimeConnectionId: profile.runtimeConnectionId }),
    });
    return { profile, providerCredential };
  };
  return {
    productionToolBundles: async (workspaceId, agentIds) => {
      const scope = await deps.scopes.forWorkspaceId(workspaceId);
      if (scope === null) return [];
      const versions = deps.agentVersions.forScope(scope);
      const bundles: AgentVersionToolBundle[] = [];
      for (const agentId of agentIds) {
        const listing = await versions.list(agentId);
        const versionId = versionToPin(listing?.pointers ?? [], 'production');
        const version = listing?.versions.find((v) => v.id === versionId);
        if (version !== undefined) {
          bundles.push(...(toAgentVersionResource(version).body.toolBundles ?? []));
        }
      }
      return bundles;
    },
    // ADR-0134 part 2: the sandbox is opened for the call, keyed by the client; the runner
    // reuses a live one, and the gateway is the only caller of it. The workspace's default runtime
    // profile and its provider credential open it; with no default there is no sandbox to open.
    // ponytail: the request (bundles and secrets) is rebuilt per call; cache it by bundle digests
    // if a busy client makes that visible.
    route: async ({ workspaceId, clientId, bundles }) => {
      const { runnerManager, gatewaySettings, secrets } = deps;
      if (runnerManager === null) throw new Error('no runner manager is configured');
      if (!gatewaySettings.ok) throw new Error(gatewaySettings.reason);
      const scope = await deps.scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error('the workspace is gone');
      const { profile, providerCredential } = await defaultProfileCredential(workspaceId, scope);
      if (profile === null) throw new Error('the workspace has no default runtime profile');
      const { signingSecret, baseUrl } = gatewaySettings.settings;
      const toolSandbox = await buildToolSandboxRequest(endpointSandboxRunId(clientId), bundles, {
        bundle: (digest) => deps.bundle(workspaceId, digest),
        secret: async (name) => {
          const resolved = secrets === null ? null : await secrets.resolveByName(scope, name);
          return resolved === null ? null : resolved.value.toString('utf8');
        },
        runToken: (id) => toolSandboxRunToken(signingSecret, id),
      });
      const origin = await runnerManager.openToolSandbox(
        { workspaceId, clientId, toolSandbox },
        providerCredential,
      );
      return {
        url: `${baseUrl}${GATEWAY_TOOL_SANDBOX_ENDPOINT_ROUTE.path}`,
        grant: await createEndpointGrantCodec({ secret: signingSecret }).issue({
          workspaceId,
          clientId,
          origin,
        }),
      };
    },
    // The default profile may have changed since the open, so the close can present another
    // credential and fail; the caller logs that and the idle timeout is the backstop.
    closeSandbox: async (workspaceId, clientId) => {
      if (deps.runnerManager === null) return;
      const scope = await deps.scopes.forWorkspaceId(workspaceId);
      if (scope === null) return;
      const { providerCredential } = await defaultProfileCredential(workspaceId, scope);
      await deps.runnerManager.closeToolSandbox(workspaceId, clientId, providerCredential);
    },
  };
}
