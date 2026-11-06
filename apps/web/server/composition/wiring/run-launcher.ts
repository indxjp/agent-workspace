import type { DatabaseRoot } from '@agent-workspace/core/db';
import { readBytes } from '@agent-workspace/core/storage/streams';
import { toolSandboxRunToken } from '@agent-workspace/gateway/tokens';
import { MAX_UPLOAD_BYTES } from '@indx-workspace/contracts/files';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import type { ModelProvider } from '@indx-workspace/contracts/runs';

import {
  codeLaunchedRunFailure,
  modelResolutionRefusal,
  runStartRefusalError,
} from '../../compose/run-preflight';
import { isUnderMemoryDirectory } from '../../compose/agent-memory';
import type { AgentRunResourceLoader, DeliveredStorageFolder } from '../../compose/resource-loader';
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
import type { FilesRuntime } from '../../files/runtime';
import { grantRoots } from '../../files/search-terms';
import type { ResolvedModelConnection } from '../../models/store';
import type { LaunchContext, RunPrincipal } from '../../runs/environment';
import { atStep, resolvedSecretValues } from '../../runs/failures';
import { createRunnerLauncher } from '../../runs/launcher';
import {
  isAudioAttachment,
  promptWithTranscription,
  transcribes,
  untranscribableRefusal,
} from '../../runs/transcription';
import { activeTraceHeaders } from '../../telemetry/runtime';
import { maximumRunDurationMs } from '../config';
import { recordReportedSessionIdentity } from '../session-launch';
import type { AgentsWiring } from './agents';
import type { RunResourcesWiring } from './run-resources';
import type { RunRuntimeWiring } from './run-runtime';
import type { RuntimeResolverWiring } from './runtime-resolver';
import type { SubsystemsWiring } from './subsystems';

/**
 * ADR-0147: run-scoped file search answers only from the paths this very request carries, so a
 * launch whose grants cannot be recorded fails rather than running with an empty snapshot. The
 * memory folder is left out (ADR-0163): its run path `memory/` is not a workspace path (the folder
 * is `memory/<agentId>/`), so recording it would let a search reach every agent's memory, and
 * search does not read memory.
 */
export async function recordRunFileGrants(
  runs: {
    snapshotFileGrants?(runId: string, paths: readonly string[]): Promise<boolean>;
  } | null,
  runId: string,
  files: Parameters<typeof grantRoots>[0],
): Promise<void> {
  const recorded = await runs?.snapshotFileGrants?.(
    runId,
    grantRoots(files.filter((file) => !isUnderMemoryDirectory(file.path))),
  );
  if (recorded !== true) throw new Error('the run file grants were not recorded');
}

/**
 * Issue #1313: `context` with a transcript of each attached recording, made through the run's own
 * model connection, joined to its prompt. Judged again at launch for the reason the model is: the
 * connection may have changed provider since the start was accepted.
 */
export async function withTranscription(input: {
  readonly context: LaunchContext;
  readonly provider: ModelProvider;
  readonly resolveConnection: () => Promise<ResolvedModelConnection | null>;
  readonly readBytes: (path: string) => Promise<Uint8Array | null>;
  readonly request?: typeof fetch;
  /** Whether the run is still `queued`; an interrupt makes it terminal and stops transcription. */
  readonly stillQueued?: () => Promise<boolean>;
}): Promise<LaunchContext> {
  const attachments = input.context.attachments ?? [];
  if (!attachments.some(isAudioAttachment)) return input.context;
  if (!transcribes(input.provider)) {
    throw runStartRefusalError(untranscribableRefusal(input.provider));
  }
  const prompt = await atStep('transcription', async () => {
    const connection = await input.resolveConnection();
    if (connection === null) throw new Error('the run model connection could not be read');
    return promptWithTranscription({
      prompt: input.context.prompt,
      attachments,
      connection,
      readBytes: input.readBytes,
      ...(input.request === undefined ? {} : { request: input.request }),
      ...(input.stillQueued === undefined ? {} : { stillQueued: input.stillQueued }),
    });
  });
  return { ...input.context, prompt };
}

/**
 * The bytes of the ready file at `path` through the catalog service, capped at `MAX_UPLOAD_BYTES`,
 * for transcription; `null` without a catalog service or a ready file there.
 */
export async function readAttachmentBytes(
  filesRuntime: Pick<FilesRuntime, 'catalog' | 'storage'> | null | undefined,
  workspaceId: string,
  path: string,
): Promise<Uint8Array | null> {
  const storage = filesRuntime?.storage;
  if (storage === undefined || filesRuntime?.catalog === undefined) return null;
  const row = await (await filesRuntime.catalog.forWorkspace(workspaceId)).get(path);
  const opened =
    row === null || row.kind !== 'file' ? null : await storage.open({ workspaceId }, row);
  return opened === null ? null : readBytes(opened.body, MAX_UPLOAD_BYTES);
}

export function createCompositionRunLauncher({
  root,
  scopes,
  sessionRows,
  recordRunTelemetry,
  secretsService,
  modelsApi,
  runnerManager,
  runnerManagerFetch,
  resolveProviderCredential,
  filesRuntime,
  runResources,
  runAgentOf,
  readRunAgent,
  runStorageConnections,
  wave5Repositories,
  runs,
  runPreflight,
  gateway,
  gatewaySettings,
  hostLaunch,
  runtimeResolver,
  launchedModels,
  revokeAllRunTokensFor,
  policyCeiling,
}: Pick<AgentsWiring, 'scopes' | 'sessionRows' | 'recordRunTelemetry'> &
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
  }) {
  /** The project of the run's session, or `null` (issue #125). */
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
   * A team lead run's members (ADR-0104 acceptance decisions 3, 4 and 6): its pinned team
   * version's member names and its member endpoint at the deployment's public origin, which the
   * lead's engine dials. `null` for a run of no team and for a child run (depth at most 1).
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
  // The grant behind each folder compose delivered writable, so the write-back saves to the
  // connection that was delivered even when it is renamed during the run.
  const deliveredFolders = new WeakMap<LaunchContext, Map<string, DeliveredStorageFolder>>();
  // The grant behind each folder the input archive was loaded with. The write-back refuses a folder
  // the archive and compose delivered for different grants (a rename between two loads).
  const hydratedFolders = new WeakMap<LaunchContext, Map<string, DeliveredStorageFolder>>();
  // One launch lists each granted connection folder once: compose asks for the selection the input
  // archive already loaded, with the same arguments, and gets that load back rather than a second
  // listing of the bucket. A different load (the run's attachments) is its own. A failed load is
  // dropped, so a retry reads again.
  const launchLoads = new WeakMap<
    LaunchContext,
    Map<string, ReturnType<AgentRunResourceLoader['load']>>
  >();
  const sharedLoader = (context: LaunchContext): AgentRunResourceLoader => ({
    load: (...args) => {
      let loads = launchLoads.get(context);
      if (loads === undefined) {
        loads = new Map();
        launchLoads.set(context, loads);
      }
      const key = JSON.stringify(args);
      const held = loads.get(key);
      if (held !== undefined) return held;
      const loading = runResources.load(...args);
      loads.set(key, loading);
      loading.catch(() => loads.delete(key));
      return loading;
    },
  });
  const recordingFolders = (context: LaunchContext): AgentRunResourceLoader => {
    const folders = new Map<string, DeliveredStorageFolder>();
    deliveredFolders.set(context, folders);
    const loader = sharedLoader(context);
    return {
      load: async (...args) => {
        const selection = await loader.load(...args);
        for (const [path, grant] of selection.storageFolders ?? []) folders.set(path, grant);
        return selection;
      },
    };
  };
  return createRunnerLauncher({
    runtime: runtimeResolver,
    store: runs,
    fetch: runnerManagerFetch,
    ...(filesRuntime?.storage === undefined
      ? {}
      : {
          workspaceLifecycle: createRuntimeWorkspaceLifecycle({
            resources: runResources,
            granted: async (context) => {
              const selection = await runResourcesWithinCeiling(
                context,
                await runAgentOf(context),
                sharedLoader(context),
                policyCeiling,
                (await projectOf(context))?.id ?? null,
              );
              hydratedFolders.set(context, new Map(selection.storageFolders ?? []));
              return selection;
            },
            storage: filesRuntime.storage,
            // ADR-0163: one `memory-updated` row per run that wrote its agent's memory folder.
            audit: (event) => root.recordAuditEvent(event),
          }),
        }),
    ...(runStorageConnections === null
      ? {}
      : {
          storageWriteback: (run: Omit<StorageWriteBackRun, 'folders' | 'hydrated'>) =>
            writeBackStorage(
              {
                ...run,
                folders: deliveredFolders.get(run.context) ?? new Map(),
                // With no archive lifecycle nothing was hydrated, so there is no second load.
                ...(filesRuntime?.storage === undefined
                  ? {}
                  : { hydrated: hydratedFolders.get(run.context) ?? new Map() }),
              },
              {
                readRunAgent,
                connections: runStorageConnections,
                audit: (event) => root.recordAuditEvent(event),
                stillRunning: async (runId) => (await runs.get(runId))?.status === 'running',
              },
            ),
        }),
    // F-04: the runtime request carries the active trace, so runner log lines join it.
    runtimeRequestHeaders: () => ({
      ...(runnerManager === null ? {} : runnerManager.authorizationHeaders()),
      ...activeTraceHeaders(),
    }),
    // A provider-hosted tool sandbox (E2B) counts against the account's concurrent cap until it
    // ends, so the one a run started is killed with the run rather than left to its timeout. The
    // session's agent runtime is not: the session's other runs keep using it (issue #832).
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
    // The SDK subprocess receives a fixed token at spawn time. End the run with a 10% safety
    // margin so no active run silently outlives that credential.
    ...(gatewaySettings.ok
      ? {
          maxRunDurationMs: maximumRunDurationMs(process.env, gatewaySettings.settings.ttlSeconds),
        }
      : {}),
    // Issue #235 (S-14): an interrupt that lands while the run is still `queued` revoked nothing,
    // because the run's token row is only created by `gateway.issue` inside `buildRunRequest`
    // below. The launcher calls this when it discovers the run went terminal underneath it, so
    // the credential it has just minted does not outlive the cancelled run.
    revokeRunTokens: async (context: LaunchContext) => {
      await revokeAllRunTokensFor(context.principal, context.run.id);
    },
    // Issue #827: what a preparation failure's log line is redacted of. Declared agent secrets,
    // tool secrets, the runtime connection credential and model connection keys are all workspace
    // secrets; the tool-sandbox token is derived from the run id. The gateway token is a long
    // random token, which `redacted` already masks by shape.
    preparationSecrets: async (context: LaunchContext) => {
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
    },
    ...hostLaunch,
    onRunFinished: recordRunTelemetry,
    // Whatever ends a launch — a finished run, a refused build, an unexpected throw — forgets
    // its launched-model entry, so the map never outlives the runs it describes.
    onLaunchSettled: (context) => {
      launchedModels.delete(context.run.id);
    },
    // Issue #661: a key the provider rejects mid-run fails with the coded
    // `model_credential_rejected`. PR #403 review: a run queued while discovery was down carries
    // an unchecked model; when the provider then answers "model not found", the run fails with
    // the coded `model_unavailable`.
    codeRuntimeFailure: (context, reason) =>
      codeLaunchedRunFailure(reason, launchedModels.get(context.run.id)),
    onSessionIdentified: async (context, reportedSessionId) => {
      const scope = await scopes.forWorkspaceId(context.principal.workspaceId);
      if (scope === null) throw new Error('the run workspace disappeared');
      await recordReportedSessionIdentity(
        sessionRows.forScope(scope),
        context.session,
        reportedSessionId,
        // The engine this run recorded, so the pin names what actually produced the id.
        context.run.engine,
      );
    },
    buildRunRequest: async (context, runtimeTarget) => {
      if (runtimeTarget === undefined) {
        throw new Error('the selected runtime profile did not produce a launch target');
      }
      const workspaceId = context.principal.workspaceId;
      const scope = await scopes.forWorkspaceId(workspaceId);
      const project = await projectOf(context);

      // issue #129: resolve and validate the run's model BEFORE it is composed into a request,
      // so a refusal names the layer and the run never reaches the runtime with an unresolved
      // or stale model. `runs.start` already ran this check before queueing (issue #393); it
      // runs again because the configuration may have changed since, and a refusal here is
      // thrown with the same contract code so the run's stored error carries it.
      const runAgent = await runAgentOf(context);
      const resolution = await atStep('model', () =>
        runPreflight.resolveModel({
          workspaceId,
          agentId: context.agent.id,
          sessionId: context.session.id,
          modelOverride: context.modelOverride ?? null,
          agent: runAgent.agent,
        }),
      );
      if (!resolution.ok) throw runStartRefusalError(modelResolutionRefusal(resolution));
      // Snapshotted before the request is even built, let alone posted: a run that fails later
      // in this function, or one the runtime never answers, still shows what it attempted.
      await atStep('model', () =>
        runs.snapshotModel(context.run.id, {
          connectionId: resolution.connectionId,
          model: resolution.model,
          provider: resolution.provider,
        }),
      );

      const launchContext = await withTranscription({
        context,
        provider: resolution.provider,
        resolveConnection: async () =>
          (await modelsApi?.models.forWorkspace(workspaceId).resolve(resolution.connectionId)) ??
          null,
        readBytes: (path) => readAttachmentBytes(filesRuntime, workspaceId, path),
        stillQueued: async () => (await runs.get(context.run.id))?.status === 'queued',
      });

      // ADR-0104: a team lead run gets its members' server; every other run gets none.
      const team = await atStep('resources', () => teamMembersOf(context));
      const request = await buildRunRequestFor(
        team === null ? launchContext : { ...launchContext, team },
        runAgent,
        runtimeSettingsFor(runtimeTarget),
        gateway,
        {},
        context.permissionOverride,
        project?.instructions ?? null,
        recordingFolders(context),
        { connectionId: resolution.connectionId, model: resolution.model },
        project?.id ?? null,
        // ENG-04: the provider this run's connection resolved to, so compose can check that
        // the agent's engine speaks a dialect the gateway serves for it.
        resolution.provider,
        // C16: the run's tool connector set, which the gateway authorises each tool call by.
        async (runId, connectorIds) => {
          const outcome =
            scope === null
              ? null
              : await root.runs.forScope(scope).snapshotTools?.(runId, connectorIds);
          if (outcome?.kind !== 'snapshotted') {
            throw new Error(
              `the run tool snapshot was not recorded (${outcome?.kind ?? 'unavailable'})`,
            );
          }
        },
        // S2-04c: the run meets the deployment's ceiling before anything is issued or posted.
        policyCeiling,
      );
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
    },
  });
}
