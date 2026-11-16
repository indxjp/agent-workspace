import type { DatabaseRoot } from '@agent-workspace/core/db';
import { toolSandboxRunToken } from '@agent-workspace/gateway/tokens';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import {
  codeLaunchedRunFailure,
  modelResolutionRefusal,
  runStartRefusalError,
} from '../../compose/run-preflight';
import {
  buildRunRequestFor,
  runResourcesWithinCeiling,
  type RunTeamMembers,
} from '../../compose/run-request';
import { memberEndpointPath } from '../../agent-teams/member-tools';
import { readPublicUrl } from '../../endpoints/public-url';
import { DomainError } from '../../errors';
import { runtimeSettingsFor, type RuntimeLaunchTarget } from '../../compose/runtime-profile';
import { type StorageWriteBackRun, writeBackStorage } from '../../compose/storage-writeback';
import { createRuntimeWorkspaceLifecycle } from '../../compose/workspace-lifecycle';
import type { LaunchContext, RunPrincipal } from '../../runs/environment';
import { atStep, resolvedSecretValues } from '../../runs/failures';
import { createRunnerLauncher, type RunnerLauncherOptions } from '../../runs/launcher';
import { activeTraceHeaders } from '../../telemetry/runtime';
import { maximumRunDurationMs } from '../config';
import { recordReportedSessionIdentity } from '../session-launch';
import type { AgentsWiring } from './agents';
import type { RunResourcesWiring } from './run-resources';
import type { RunRuntimeWiring } from './run-runtime';
import type { RuntimeResolverWiring } from './runtime-resolver';
import type { SubsystemsWiring } from './subsystems';
import { createLaunchResourceTracking, recordRunFileGrants } from './run-launcher-resources';
import { readAttachmentBytes, withTranscription } from './run-launcher-attachments';

export { readAttachmentBytes, withTranscription } from './run-launcher-attachments';
export { recordRunFileGrants } from './run-launcher-resources';

type CompositionRunLauncherDependencies = Pick<
  AgentsWiring,
  'scopes' | 'sessionRows' | 'recordRunTelemetry'
> &
  Pick<
    SubsystemsWiring,
    | 'secretsService'
    | 'modelsApi'
    | 'runnerManager'
    | 'runnerManagerFetch'
    | 'resolveProviderCredential'
  > &
  Pick<
    RunResourcesWiring,
    | 'filesRuntime'
    | 'runResources'
    | 'runAgentOf'
    | 'readRunAgent'
    | 'runStorageConnections'
    | 'wave5Repositories'
  > &
  Pick<RunRuntimeWiring, 'runs' | 'runPreflight' | 'gateway' | 'gatewaySettings' | 'hostLaunch'> &
  Pick<RuntimeResolverWiring, 'runtimeResolver' | 'launchedModels'> & {
    readonly root: DatabaseRoot;
    readonly policyCeiling: ProjectPolicy | null;
    readonly revokeAllRunTokensFor: (principal: RunPrincipal, runId: string) => Promise<unknown>;
  };

type LaunchResources = ReturnType<typeof createLaunchResourceTracking>;
type LaunchMetadata = ReturnType<typeof createLaunchMetadata>;

function createLaunchMetadata({
  root,
  scopes,
  sessionRows,
  wave5Repositories,
}: Pick<
  CompositionRunLauncherDependencies,
  'root' | 'scopes' | 'sessionRows' | 'wave5Repositories'
>) {
  const projectOf = async (context: LaunchContext) => {
    const workspaceId = context.principal.workspaceId;
    const scope = await scopes.forWorkspaceId(workspaceId);
    const sessionRow =
      scope === null ? null : await sessionRows.forScope(scope).get(context.session.id);
    return sessionRow?.projectId === null || sessionRow?.projectId === undefined
      ? null
      : (await wave5Repositories(workspaceId)).projects.get(sessionRow.projectId);
  };
  /**
   * A team lead reaches its pinned members at the public origin. Child runs never receive
   * members, which bounds team delegation to one level.
   */
  const teamMembersOf = async (context: LaunchContext): Promise<RunTeamMembers | null> => {
    const versionId = context.run.agentTeamVersionId ?? null;
    const isChild = context.run.parentRunId !== null && context.run.parentRunId !== undefined;
    if (versionId === null || isChild) return null;
    const scope = await scopes.forWorkspaceId(context.principal.workspaceId);
    const version =
      scope === null ? null : await root.agentTeams.forScope(scope).getVersion(versionId);
    if (version === null) throw new Error('the team version this run runs could not be read');
    const origin = readPublicUrl(process.env);
    if (!origin.ok) {
      throw new DomainError({
        category: 'validation',
        code: 'agent_team_members_unreachable',
        publicMessage:
          "agent_team_members_unreachable: a team lead reaches its members at this deployment's " +
          'public origin, and AW_PUBLIC_URL is not set to one; the operator sets it.',
      });
    }
    return {
      url: `${origin.origin}${memberEndpointPath(context.run.id)}`,
      names: version.members.map((member) => member.name),
    };
  };
  return { projectOf, teamMembersOf };
}

function launchStorageOptions(
  dependencies: CompositionRunLauncherDependencies,
  resources: LaunchResources,
  projectOf: LaunchMetadata['projectOf'],
): Pick<RunnerLauncherOptions, 'workspaceLifecycle' | 'storageWriteback'> {
  const { filesRuntime, runResources, runAgentOf, policyCeiling, root } = dependencies;
  return {
    ...(filesRuntime?.storage === undefined
      ? {}
      : {
          workspaceLifecycle: createRuntimeWorkspaceLifecycle({
            resources: runResources,
            granted: async (context) => {
              const selection = await runResourcesWithinCeiling(
                context,
                await runAgentOf(context),
                {
                  resourceLoader: resources.sharedLoader(context),
                  ceiling: policyCeiling,
                  projectId: (await projectOf(context))?.id ?? null,
                },
              );
              resources.rememberHydrated(context, selection);
              return selection;
            },
            storage: filesRuntime.storage,
            // ADR-0163: one `memory-updated` row per run that wrote its agent's memory folder.
            audit: (event) => root.recordAuditEvent(event),
          }),
        }),
    ...storageWritebackOptions(dependencies, resources),
  };
}

function storageWritebackOptions(
  dependencies: CompositionRunLauncherDependencies,
  resources: LaunchResources,
): Pick<RunnerLauncherOptions, 'storageWriteback'> {
  const { runStorageConnections, readRunAgent, root, runs, filesRuntime } = dependencies;
  return {
    ...(runStorageConnections === null
      ? {}
      : {
          storageWriteback: (run: Omit<StorageWriteBackRun, 'folders' | 'hydrated'>) =>
            writeBackStorage(
              {
                ...run,
                folders: resources.deliveredFor(run.context),
                // With no archive lifecycle nothing was hydrated, so there is no second load.
                ...(filesRuntime?.storage === undefined
                  ? {}
                  : { hydrated: resources.hydratedFor(run.context) }),
              },
              {
                readRunAgent,
                connections: runStorageConnections,
                audit: (event) => root.recordAuditEvent(event),
                stillRunning: async (runId) => (await runs.get(runId))?.status === 'running',
              },
            ),
        }),
  };
}

function createPreparationSecretsReader({
  gatewaySettings,
  scopes,
  secretsService,
}: Pick<CompositionRunLauncherDependencies, 'gatewaySettings' | 'scopes' | 'secretsService'>) {
  return async (context: LaunchContext) => {
    const runToken = gatewaySettings.ok
      ? [await toolSandboxRunToken(gatewaySettings.settings.signingSecret, context.run.id)]
      : [];
    const scope = await scopes.forWorkspaceId(context.principal.workspaceId);
    if (scope === null || secretsService === null) return runToken;
    const metadata = await secretsService.list(scope);
    const values = await resolvedSecretValues(
      metadata.map(async (secret) => {
        const resolved = await secretsService.resolveByName(scope, secret.name);
        return resolved === null ? null : resolved.value.toString('utf8');
      }),
    );
    return [...values, ...runToken];
  };
}

function launchCallbacks(dependencies: CompositionRunLauncherDependencies) {
  const { revokeAllRunTokensFor, recordRunTelemetry, launchedModels, scopes, sessionRows } =
    dependencies;
  return {
    // An interrupt may finish a queued run before its token is minted during preparation.
    revokeRunTokens: async (context: LaunchContext) => {
      await revokeAllRunTokensFor(context.principal, context.run.id);
    },
    preparationSecrets: createPreparationSecretsReader(dependencies),
    onRunFinished: recordRunTelemetry,
    // Failed preparation and completed execution must both release the model entry.
    onLaunchSettled: (context: LaunchContext) => {
      launchedModels.delete(context.run.id);
    },
    codeRuntimeFailure: (context: LaunchContext, reason: string) =>
      codeLaunchedRunFailure(reason, launchedModels.get(context.run.id)),
    onSessionIdentified: async (context: LaunchContext, reportedSessionId: string) => {
      const scope = await scopes.forWorkspaceId(context.principal.workspaceId);
      if (scope === null) throw new Error('the run workspace disappeared');
      await recordReportedSessionIdentity(
        sessionRows.forScope(scope),
        context.session,
        reportedSessionId,
        context.run.engine,
      );
    },
  };
}

async function resolveLaunchModel(
  { runs, runPreflight }: Pick<CompositionRunLauncherDependencies, 'runs' | 'runPreflight'>,
  context: LaunchContext,
  runAgent: Awaited<ReturnType<CompositionRunLauncherDependencies['runAgentOf']>>,
) {
  // Revalidate at launch because the connection may have changed since queueing. Snapshot
  // before transcription or composition so even a later failure records the attempted model.
  const resolution = await atStep('model', () =>
    runPreflight.resolveModel({
      workspaceId: context.principal.workspaceId,
      agentId: context.agent.id,
      sessionId: context.session.id,
      modelOverride: context.modelOverride ?? null,
      agent: runAgent.agent,
    }),
  );
  if (!resolution.ok) throw runStartRefusalError(modelResolutionRefusal(resolution));
  await atStep('model', () =>
    runs.snapshotModel(context.run.id, {
      connectionId: resolution.connectionId,
      model: resolution.model,
      provider: resolution.provider,
    }),
  );

  return resolution;
}

function toolSnapshotFor(
  root: CompositionRunLauncherDependencies['root'],
  scope: Awaited<ReturnType<CompositionRunLauncherDependencies['scopes']['forWorkspaceId']>>,
): NonNullable<Parameters<typeof buildRunRequestFor>[0]['snapshotTools']> {
  return async (runId, connectorIds) => {
    const outcome =
      scope === null ? null : await root.runs.forScope(scope).snapshotTools?.(runId, connectorIds);
    if (outcome?.kind !== 'snapshotted') {
      throw new Error(`the run tool snapshot was not recorded (${outcome?.kind ?? 'unavailable'})`);
    }
  };
}

function transcribedLaunchContext(
  {
    modelsApi,
    filesRuntime,
    runs,
  }: Pick<CompositionRunLauncherDependencies, 'modelsApi' | 'filesRuntime' | 'runs'>,
  context: LaunchContext,
  resolution: Awaited<ReturnType<typeof resolveLaunchModel>>,
) {
  const workspaceId = context.principal.workspaceId;
  return withTranscription({
    context,
    provider: resolution.provider,
    resolveConnection: async () =>
      (await modelsApi?.models.forWorkspace(workspaceId).resolve(resolution.connectionId)) ?? null,
    readBytes: (path) => readAttachmentBytes(filesRuntime, workspaceId, path),
    stillQueued: async () => (await runs.get(context.run.id))?.status === 'queued',
  });
}

function createRunRequestBuilder(
  dependencies: CompositionRunLauncherDependencies,
  resources: LaunchResources,
  { projectOf, teamMembersOf }: LaunchMetadata,
): RunnerLauncherOptions['buildRunRequest'] {
  const { scopes, runAgentOf, gateway, root, policyCeiling, launchedModels } = dependencies;
  return async (context, runtimeTarget) => {
    if (runtimeTarget === undefined) {
      throw new Error('the selected runtime profile did not produce a launch target');
    }
    const workspaceId = context.principal.workspaceId;
    const scope = await scopes.forWorkspaceId(workspaceId);
    const project = await projectOf(context);

    const runAgent = await runAgentOf(context);
    const resolution = await resolveLaunchModel(dependencies, context, runAgent);

    const launchContext = await transcribedLaunchContext(dependencies, context, resolution);
    const team = await atStep('resources', () => teamMembersOf(context));
    const request = await buildRunRequestFor({
      context: team === null ? launchContext : { ...launchContext, team },
      runAgent,
      settings: runtimeSettingsFor(runtimeTarget),
      gateway,
      permissionOverride: context.permissionOverride,
      projectInstructions: project?.instructions ?? null,
      resourceLoader: resources.recordingFolders(context),
      resolvedModel: {
        connectionId: resolution.connectionId,
        model: resolution.model,
      },
      projectId: project?.id ?? null,
      modelProvider: resolution.provider,
      snapshotTools: toolSnapshotFor(root, scope),
      ceiling: policyCeiling,
    });
    await recordRunFileGrants(
      scope === null ? null : root.runs.forScope(scope),
      context.run.id,
      request.resources?.files ?? [],
    );
    // Recorded only once the request is built: a build that throws records nothing to forget.
    launchedModels.set(context.run.id, {
      layer: resolution.layer,
      connectionName: resolution.connectionName,
      model: resolution.model,
      validated: resolution.validated,
    });
    return request;
  };
}

export function createCompositionRunLauncher(dependencies: CompositionRunLauncherDependencies) {
  const {
    runtimeResolver,
    runs,
    runnerManagerFetch,
    runnerManager,
    resolveProviderCredential,
    gatewaySettings,
    hostLaunch,
  } = dependencies;
  const metadata = createLaunchMetadata(dependencies);
  const resources = createLaunchResourceTracking(dependencies.runResources);
  const { revokeRunTokens, preparationSecrets, ...lifecycleCallbacks } =
    launchCallbacks(dependencies);
  return createRunnerLauncher({
    runtime: runtimeResolver,
    store: runs,
    fetch: runnerManagerFetch,
    ...launchStorageOptions(dependencies, resources, metadata.projectOf),
    runtimeRequestHeaders: () => ({
      ...(runnerManager === null ? {} : runnerManager.authorizationHeaders()),
      ...activeTraceHeaders(),
    }),
    // Release only this run's provider-hosted tool sandboxes; the session runtime is shared.
    ...(runnerManager === null
      ? {}
      : {
          releaseRunSandboxes: async (context: LaunchContext, target: RuntimeLaunchTarget) => {
            if (target.driver !== 'external' || target.toolSandboxOrigin === undefined) return;
            await runnerManager.releaseRunToolSandboxes(
              context.principal.workspaceId,
              context.run.id,
              await resolveProviderCredential(context.principal.workspaceId, target),
            );
          },
        }),
    // The subprocess keeps its spawn-time token, so end before that credential expires.
    ...(gatewaySettings.ok
      ? {
          maxRunDurationMs: maximumRunDurationMs(process.env, gatewaySettings.settings.ttlSeconds),
        }
      : {}),
    revokeRunTokens,
    preparationSecrets,
    ...hostLaunch,
    ...lifecycleCallbacks,
    buildRunRequest: createRunRequestBuilder(dependencies, resources, metadata),
  });
}
