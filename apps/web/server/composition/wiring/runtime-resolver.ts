import { log } from '../../telemetry/logger';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import type { RuntimeRunSpec } from '@agent-workspace/runtime/driver';
import { LOCAL_RUNTIME_CAPABILITIES } from '@agent-workspace/runtime/driver/local';
import { toolSandboxRunToken } from '@agent-workspace/gateway/tokens';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import { runNetworkGrant } from '../../compose/run-request';
import type { LaunchedModel } from '../../compose/run-preflight';
import {
  createRuntimeRunResolver,
  localRuntimeRunSpecRejection,
} from '../../compose/runtime-profile';
import { buildToolSandboxRequest } from '../../compose/tool-sandbox';
import { atStep } from '../../runs/failures';
import type { LaunchContext } from '../../runs/environment';
import { readToolBundle } from '../../tool-bundles/handlers';
import { openToolBundleStore } from '../../tool-bundles/http';
import { runnerManagerDriverId } from '../config';
import type { AgentsWiring } from './agents';
import type { RunResourcesWiring } from './run-resources';
import type { RunRuntimeWiring } from './run-runtime';
import type { SubsystemsWiring } from './subsystems';

export function wireRuntimeResolver({
  root,
  scopes,
  sessionRows,
  secretsService,
  runnerManager,
  runnerManagerUrl,
  resolveProviderCredential,
  runResources,
  runAgentOf,
  wave5Repositories,
  runtime,
  gatewaySettings,
  driverRegistry,
  runtimeProfiles,
  policyCeiling,
}: Pick<AgentsWiring, 'scopes' | 'sessionRows'> &
  Pick<
    SubsystemsWiring,
    'secretsService' | 'runnerManager' | 'runnerManagerUrl' | 'resolveProviderCredential'
  > &
  Pick<RunResourcesWiring, 'runResources' | 'runAgentOf' | 'wave5Repositories'> &
  Pick<RunRuntimeWiring, 'runtime' | 'gatewaySettings' | 'driverRegistry' | 'runtimeProfiles'> & {
    readonly root: DatabaseRoot;
    readonly policyCeiling: ProjectPolicy | null;
  }) {
  const launchedModels = new Map<string, LaunchedModel>();
  const runtimeResolver = createRuntimeRunResolver({
    agentFor: async (context) => (await runAgentOf(context)).agent,
    profiles: runtimeProfiles,
    registry: driverRegistry,
    // ponytail: this reads the agent and loads the run's resources a second time, because
    // `buildRunRequest` loads them after the spec is allocated; pass one load through if launch
    // latency matters.
    networkGrantFor: async (context) => {
      const scope = await scopes.forWorkspaceId(context.principal.workspaceId);
      const sessionRow =
        scope === null ? null : await sessionRows.forScope(scope).get(context.session.id);
      const project =
        sessionRow?.projectId === null || sessionRow?.projectId === undefined
          ? null
          : await (
              await wave5Repositories(context.principal.workspaceId)
            ).projects.get(sessionRow.projectId);
      return runNetworkGrant(
        context,
        await runAgentOf(context),
        runResources,
        policyCeiling,
        project?.id ?? null,
      );
    },
    // The runner manager starts the proxy from this image (#822); the web reads the same variable,
    // as it does for the runtime images, so both processes must be given it.
    egressProxyConfigured: (process.env['AGENT_WORKSPACE_EGRESS_PROXY_IMAGE']?.trim() ?? '') !== '',
    onNetworkLowered: (context, lowered) => {
      log.info(
        `[runs] run ${context.run.id}: the agent lacks unrestrictedNetwork, so the open runtime ` +
          `profile was lowered to ${lowered.applied}` +
          (lowered.allowedDomains.length === 0 ? '' : ` (${lowered.allowedDomains.join(', ')})`),
      );
    },
    // RUNNER_URL positively configures the local HTTP runtime only. Other drivers stay
    // unavailable until their own launch adapters register a target; they never fall back here.
    targets: [
      ...(runtime.ok
        ? [
            {
              driver: 'local' as const,
              runnerUrl: runtime.settings.runnerUrl,
              workspaceRoot: runtime.settings.workspaceRoot,
              fileTransfer: LOCAL_RUNTIME_CAPABILITIES.fileTransfer,
              validate: localRuntimeRunSpecRejection,
            },
          ]
        : []),
      ...(runnerManager === null
        ? []
        : [
            {
              // The runner manager allocates whatever runtime its own RUNTIME_DRIVER selects
              // (docker container, Cloud Run service, …) — this web process names that same
              // driver so an agent's runtime profile can select it. RUNTIME_DRIVER is read again
              // here rather than threaded through, because the two processes are configured
              // independently and must still agree on the id by construction: a mismatch here
              // means a runtime profile can never find this target (`createRuntimeRunResolver`
              // matches on `driver` alone), not that it reaches the wrong runtime.
              driver: runnerManagerDriverId(process.env),
              runnerUrl: runnerManagerUrl!,
              workspaceRoot: '/workspace',
              // Every driver behind the runner manager takes the pushed archive, except a managed
              // `local` one, whose workspace is this host's disk.
              fileTransfer:
                runnerManagerDriverId(process.env) === 'local'
                  ? LOCAL_RUNTIME_CAPABILITIES.fileTransfer
                  : ('push-archive' as const),
              allocate: async (context: LaunchContext, spec: RuntimeRunSpec) => {
                // ADR-0118: a version that pins code tools gets the session's tool sandbox from
                // this allocation, and the run records where it is so the gateway can reach it.
                const workspaceId = context.principal.workspaceId;
                // Refuse a misconfigured connection before any tool secret is decrypted.
                const providerCredential = await atStep('runtime_connection', () =>
                  resolveProviderCredential(workspaceId, spec),
                );
                const { toolBundles } = await atStep('tools', () => runAgentOf(context));
                const toolSandbox =
                  toolBundles.length === 0
                    ? undefined
                    : await atStep('tools', () =>
                        buildToolSandboxRequest(context.run.id, toolBundles, {
                          bundle: async (digest) => {
                            const store = openToolBundleStore(workspaceId);
                            return store === null ? null : readToolBundle(store, digest);
                          },
                          secret: (name) =>
                            atStep('secrets', async () => {
                              const scope = await scopes.forWorkspaceId(workspaceId);
                              const resolved =
                                scope === null || secretsService === null
                                  ? null
                                  : await secretsService.resolveByName(scope, name);
                              return resolved === null ? null : resolved.value.toString('utf8');
                            }),
                          runToken: (runId) => {
                            if (!gatewaySettings.ok) throw new Error(gatewaySettings.reason);
                            return toolSandboxRunToken(
                              gatewaySettings.settings.signingSecret,
                              runId,
                            );
                          },
                        }),
                      );
                const allocation = await atStep('allocation', () =>
                  runnerManager.allocate(context, spec, toolSandbox, providerCredential),
                );
                if (allocation.toolSandboxOrigin !== undefined) {
                  const toolSandboxOrigin = allocation.toolSandboxOrigin;
                  try {
                    await atStep('tools', async () => {
                      const scope = await scopes.forWorkspaceId(workspaceId);
                      const outcome =
                        scope === null
                          ? null
                          : await root.runs
                              .forScope(scope)
                              .recordToolSandbox?.(context.run.id, toolSandboxOrigin);
                      if (outcome?.kind !== 'recorded') {
                        throw new Error(
                          `the run tool sandbox was not recorded (${outcome?.kind ?? 'unavailable'})`,
                        );
                      }
                    });
                  } catch (error) {
                    // No target is returned, so the launcher never releases this run's tool sandbox.
                    if (spec.driver === 'external') {
                      await runnerManager
                        .releaseRunToolSandboxes(workspaceId, context.run.id, providerCredential)
                        .catch(() => undefined);
                    }
                    throw error;
                  }
                }
                return {
                  runnerUrl: allocation.runnerUrl,
                  workspaceRoot: '/workspace',
                  ...(allocation.toolSandboxOrigin === undefined
                    ? {}
                    : { toolSandboxOrigin: allocation.toolSandboxOrigin }),
                };
              },
            },
          ]),
    ],
  });

  return { launchedModels, runtimeResolver };
}

export type RuntimeResolverWiring = ReturnType<typeof wireRuntimeResolver>;
