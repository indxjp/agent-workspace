import { log } from '../../telemetry/logger';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import type { RuntimeRunSpec } from '@agent-workspace/runtime/driver';
import { LOCAL_RUNTIME_CAPABILITIES } from '@agent-workspace/runtime/driver/local';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import { runNetworkGrant } from '../../compose/run-request';
import type { LaunchedModel } from '../../compose/run-preflight';
import {
  createRuntimeRunResolver,
  localRuntimeRunSpecRejection,
} from '../../compose/runtime-profile';
import { atStep } from '../../runs/failures';
import type { LaunchContext } from '../../runs/environment';
import { egressProxyConfiguredFromEnv } from '../../runtimes/network-policy';
import { runnerManagerDriverId } from '../config';
import type { AgentsWiring } from './agents';
import {
  recordRunToolSandboxOrRelease,
  releaseRunToolSandboxes,
  requestRunToolSandbox,
  type RunnerManager,
} from './run-tool-sandbox';
import type { RunResourcesWiring } from './run-resources';
import type { RunRuntimeWiring } from './run-runtime';
import type { SubsystemsWiring } from './subsystems';

/** The ports the run launcher's runtime targets are built from. */
export type RuntimeTargetDependencies = Pick<AgentsWiring, 'scopes' | 'sessionRows'> &
  Pick<
    SubsystemsWiring,
    'secretsService' | 'runnerManager' | 'runnerManagerUrl' | 'resolveProviderCredential'
  > &
  Pick<RunResourcesWiring, 'runResources' | 'runAgentOf' | 'wave5Repositories'> &
  Pick<RunRuntimeWiring, 'runtime' | 'gatewaySettings' | 'driverRegistry' | 'runtimeProfiles'> & {
    readonly root: DatabaseRoot;
    readonly policyCeiling: ProjectPolicy | null;
  };

/** What the run's network grant is computed from: its agent, resources and project ceiling. */
function runNetworkGrantFor({
  scopes,
  sessionRows,
  wave5Repositories,
  runAgentOf,
  runResources,
  policyCeiling,
}: Pick<
  RuntimeTargetDependencies,
  'scopes' | 'sessionRows' | 'wave5Repositories' | 'runAgentOf' | 'runResources' | 'policyCeiling'
>) {
  return async (context: LaunchContext) => {
    const scope = await scopes.forWorkspaceId(context.principal.workspaceId);
    const sessionRow =
      scope === null ? null : await sessionRows.forScope(scope).get(context.session.id);
    const projectId = sessionRow?.projectId ?? null;
    const project =
      projectId === null
        ? null
        : await (await wave5Repositories(context.principal.workspaceId)).projects.get(projectId);
    return runNetworkGrant(context, await runAgentOf(context), {
      resourceLoader: runResources,
      ceiling: policyCeiling,
      projectId: project?.id ?? null,
    });
  };
}

function logNetworkLowered(
  context: LaunchContext,
  lowered: { readonly applied: string; readonly allowedDomains: readonly string[] },
): void {
  log.info(
    `[runs] run ${context.run.id}: the agent lacks unrestrictedNetwork, so the open runtime ` +
      `profile was lowered to ${lowered.applied}` +
      (lowered.allowedDomains.length === 0 ? '' : ` (${lowered.allowedDomains.join(', ')})`),
  );
}

/**
 * Allocate this run's runtime through the runner manager (ADR-0118): a version that pins code tools
 * gets the session's tool sandbox from the allocation, and the run records where it is.
 */
function allocateThroughRunnerManager(
  dependencies: RuntimeTargetDependencies,
  runnerManager: RunnerManager,
) {
  return async (context: LaunchContext, spec: RuntimeRunSpec) => {
    // Refuse a misconfigured connection before any tool secret is decrypted.
    const providerCredential = await atStep('runtime_connection', () =>
      dependencies.resolveProviderCredential(context.principal.workspaceId, spec),
    );
    const toolSandbox = await requestRunToolSandbox(dependencies, context);
    const allocation = await atStep('allocation', () =>
      runnerManager.allocate(context, spec, toolSandbox, providerCredential),
    );
    const { toolSandboxOrigin } = allocation;
    if (toolSandboxOrigin !== undefined) {
      await recordRunToolSandboxOrRelease(dependencies, context, toolSandboxOrigin, () =>
        spec.driver === 'external'
          ? releaseRunToolSandboxes(runnerManager, context, providerCredential)
          : Promise.resolve(),
      );
    }
    return {
      runnerUrl: allocation.runnerUrl,
      workspaceRoot: '/workspace',
      ...(toolSandboxOrigin === undefined ? {} : { toolSandboxOrigin }),
    };
  };
}

/** The local HTTP runtime, positively configured by RUNNER_URL; no other driver falls back to it. */
function localRuntimeTargets({ runtime }: Pick<RuntimeTargetDependencies, 'runtime'>) {
  if (!runtime.ok) return [];
  return [
    {
      driver: 'local' as const,
      runnerUrl: runtime.settings.runnerUrl,
      workspaceRoot: runtime.settings.workspaceRoot,
      fileTransfer: LOCAL_RUNTIME_CAPABILITIES.fileTransfer,
      validate: localRuntimeRunSpecRejection,
    },
  ];
}

/**
 * The runner manager allocates whatever runtime its own RUNTIME_DRIVER selects (docker container,
 * Cloud Run service, ...) - this web process names that same driver so an agent's runtime profile
 * can select it. RUNTIME_DRIVER is read again here rather than threaded through, because the two
 * processes are configured independently and must still agree on the id by construction: a
 * mismatch here means a runtime profile can never find this target (`createRuntimeRunResolver`
 * matches on `driver` alone), not that it reaches the wrong runtime.
 */
function runnerManagerTargets(dependencies: RuntimeTargetDependencies) {
  const { runnerManager, runnerManagerUrl } = dependencies;
  if (runnerManager === null || runnerManagerUrl === null) return [];
  const driver = runnerManagerDriverId(process.env);
  return [
    {
      driver,
      runnerUrl: runnerManagerUrl,
      workspaceRoot: '/workspace',
      // Every driver behind the runner manager takes the pushed archive, except a managed
      // `local` one, whose workspace is this host's disk.
      fileTransfer:
        driver === 'local' ? LOCAL_RUNTIME_CAPABILITIES.fileTransfer : ('push-archive' as const),
      allocate: allocateThroughRunnerManager(dependencies, runnerManager),
    },
  ];
}

export function wireRuntimeResolver(dependencies: RuntimeTargetDependencies) {
  const { runAgentOf, runtimeProfiles, driverRegistry } = dependencies;
  const launchedModels = new Map<string, LaunchedModel>();
  const runtimeResolver = createRuntimeRunResolver({
    agentFor: async (context) => (await runAgentOf(context)).agent,
    profiles: runtimeProfiles,
    registry: driverRegistry,
    // ponytail: this reads the agent and loads the run's resources a second time, because
    // `buildRunRequest` loads them after the spec is allocated; pass one load through if launch
    // latency matters.
    networkGrantFor: runNetworkGrantFor(dependencies),
    // The runner manager starts the proxy from AGENT_WORKSPACE_EGRESS_PROXY_IMAGE (#822) or, on
    // Cloud Run, reaches the shared one at RUNTIME_EGRESS_PROXY_URL; the web reads the same
    // variables, so both processes must be given them.
    egressProxyConfigured: egressProxyConfiguredFromEnv(process.env),
    onNetworkLowered: logNetworkLowered,
    // Other drivers stay unavailable until their own launch adapters register a target.
    targets: [...localRuntimeTargets(dependencies), ...runnerManagerTargets(dependencies)],
  });

  return { launchedModels, runtimeResolver };
}

export type RuntimeResolverWiring = ReturnType<typeof wireRuntimeResolver>;
