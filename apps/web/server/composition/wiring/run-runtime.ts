import { log } from '../../telemetry/logger';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import { after } from 'next/server';

import { readRuntimeSettings } from '../../compose/run-request';
import { createRunPreflight } from '../../compose/run-preflight';
import {
  createRunTokenIssuer,
  createUnavailableRunTokenIssuer,
  readGatewayIssuerSettings,
} from '../../gateway/issuer';
import type {
  AgentRef,
  ModelSelection,
  RunApiEnvironment,
  RunPrincipal,
} from '../../runs/environment';
import { staleRunAfterMs } from '../../runs/launcher';
import { createRepositoryRunStore } from '../../runs/repository-store';
import type { RunStore } from '../../runs/store';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { hostLaunchOptions, maximumRunDurationMs } from '../config';
import type { AgentsWiring } from './agents';
import type { RunResourcesWiring } from './run-resources';
import type { SubsystemsWiring } from './subsystems';

/**
 * A launch lives in the process that started it, so a replica that dies mid-run leaves the run
 * open. Where runs can launch, fail every run still open past the longest a launch can live, its
 * storage write-back included, and a margin (`../runs/stale-sweep.ts`).
 */
async function startStaleRunSweep(
  root: DatabaseRoot,
  runs: RunStore,
  gatewaySettings: ReturnType<typeof readGatewayIssuerSettings>,
  stopOnClose: (stop: () => void) => void,
): Promise<void> {
  if (!gatewaySettings.ok) return;
  const { startStaleRunSweeper } = await import('../../runs/stale-sweep');
  const stop = startStaleRunSweeper({
    lease: { tryAcquire: (name, ttlMs) => root.tryAcquireMaintenanceLease(name, ttlMs) },
    listStaleRunIds: (before) => root.listStaleRunIds(before),
    finish: (runId, status, error, emitStatusEvent) =>
      runs.finish(runId, status, error, emitStatusEvent),
    staleAfterMs: staleRunAfterMs(
      maximumRunDurationMs(process.env, gatewaySettings.settings.ttlSeconds),
    ),
    intervalMs: 60_000,
    onError: (error) => log.error('[compose] stale-run sweep failed', { error }),
  });
  stopOnClose(stop);
}

/** The run-API wiring, or `null` when no runtime can launch (the run routes then answer 503). */
export async function wireRunRuntime({
  root,
  scopes,
  sessionRows,
  agents,
  deploymentDefaultModels,
  modelsApi,
  runnerManager,
  wave5Repositories,
  readRunAgent,
  runFileSizes,
  pinnedVersionFor,
  policyCeiling,
  stopOnClose,
}: Pick<AgentsWiring, 'scopes' | 'sessionRows' | 'agents' | 'deploymentDefaultModels'> &
  Pick<SubsystemsWiring, 'modelsApi' | 'runnerManager'> &
  Pick<
    RunResourcesWiring,
    'wave5Repositories' | 'readRunAgent' | 'runFileSizes' | 'pinnedVersionFor'
  > & {
    readonly root: DatabaseRoot;
    readonly policyCeiling: ProjectPolicy | null;
    /** Hand the composition a background driver's stop, so closing it stops the driver. */
    readonly stopOnClose: (stop: () => void) => void;
  }) {
  const runtime = readRuntimeSettings(process.env);
  if (!runtime.ok) {
    // RUNNER_URL configures the in-process "local" driver only (§14.3's one fixed runtime URL).
    // A deployment that instead allocates a runtime per session through the runner manager
    // (RUNNER_MANAGER_URL/RUNNER_MANAGER_TOKEN, checked above) has a real runtime with no use for
    // that fixed URL, so its absence is not itself a reason to leave the run API uninstalled — only
    // the absence of *every* runtime is. See docs/adr/ADR-cloud-run-service-driver.md.
    log.error(`[compose] "local" runtime driver unavailable: ${runtime.reason}`);
    if (runnerManager === null) {
      // Neither a fixed runtime URL nor a runner manager is configured, so there is truly nothing
      // to relay a run to. The three run routes go on answering 503 by name, which is the true
      // statement about a deployment with no runtime at all.
      log.error(
        '[compose] run API NOT installed: no runtime is configured (neither RUNNER_URL nor ' +
          'RUNNER_MANAGER_URL/RUNNER_MANAGER_TOKEN).',
      );
      return null;
    }
  }
  const gatewaySettings = readGatewayIssuerSettings(process.env);
  const hostLaunch = hostLaunchOptions(process.env, after);
  const gateway = gatewaySettings.ok
    ? createRunTokenIssuer(gatewaySettings.settings, async ({ claims, tokenHash }) => {
        const scope = await scopes.forWorkspaceId(claims.workspaceId);
        if (scope === null) throw new Error(`cannot register a token for unknown workspace`);
        await root.runTokens.forScope(scope).register({
          id: claims.tokenId,
          runId: claims.runId,
          tokenHash,
          expiresAt: new Date(claims.expiresAt * 1_000),
        });
      })
    : createUnavailableRunTokenIssuer(gatewaySettings.reason);
  if (!gatewaySettings.ok) {
    log.error(
      `[compose] run launch disabled: ${gatewaySettings.reason} Run lookup and event routes remain installed, but a launch fails closed before the runner is called.`,
    );
  }

  const runs = createRepositoryRunStore({
    repositories: root.runs,
    events: root.runEvents,
    scopes,
    findRunWorkspace: (runId: string): Promise<string | null> => root.findRunWorkspace(runId),
  });
  await startStaleRunSweep(root, runs, gatewaySettings, stopOnClose);
  const [{ createRepositoryRuntimeProfileStoreProvider }, { currentWebRuntimeRegistry }] =
    await Promise.all([import('../../runtimes/store'), import('../../runtimes/registry')]);
  const driverRegistry = currentWebRuntimeRegistry();
  if (driverRegistry === null) {
    log.error(
      '[compose] run API NOT installed: the runtime driver registry is unavailable, so an agent profile cannot select a launch driver.',
    );
    return null;
  }
  const runtimeProfiles = createRepositoryRuntimeProfileStoreProvider({
    repositories: root.runtimeProfiles,
    scopes,
  });
  /** The project session `sessionId` is filed under, or `null`. */
  const projectOfSession = async (workspaceId: string, sessionId: string) => {
    const scope = await scopes.forWorkspaceId(workspaceId);
    const sessionRow = scope === null ? null : await sessionRows.forScope(scope).get(sessionId);
    return sessionRow?.projectId ?? null;
  };
  // Issue #393: what `runs.start` checks before it queues a run, and the model ladder the launch
  // resolves again — one implementation, so the pre-queue answer and the launch cannot disagree.
  const runPreflight = createRunPreflight({
    runFiles: { loader: runFileSizes, readRunAgent, projectOf: projectOfSession },
    agents,
    profiles: runtimeProfiles,
    models: modelsApi,
    deploymentDefaultModels,
    policyCeiling,
    workspaceDefault: (workspaceId) => root.getWorkspaceModelDefault(workspaceId),
    projectDefault: async (workspaceId, sessionId) => {
      const projectId = await projectOfSession(workspaceId, sessionId);
      if (projectId === null) return null;
      const project = await (await wave5Repositories(workspaceId)).projects.get(projectId);
      return project?.defaultModelConnectionId === null ||
        project?.defaultModelConnectionId === undefined ||
        project.defaultModel === null
        ? null
        : { connectionId: project.defaultModelConnectionId, model: project.defaultModel };
    },
    projectDefaults: async (workspaceId) => {
      // Active projects only: an archived project takes no new work, so its default is moot.
      const projects = await (await wave5Repositories(workspaceId)).projects.list('active');
      const defaults = new Map<string, ModelSelection>();
      for (const project of projects) {
        if (project.defaultModelConnectionId !== null && project.defaultModel !== null) {
          defaults.set(project.id, {
            connectionId: project.defaultModelConnectionId,
            model: project.defaultModel,
          });
        }
      }
      return defaults;
    },
  });
  /** The pin of session `sessionId`, when it is one of `agentId`'s; else `null`. */
  const sessionPin = async (
    workspaceId: string,
    agentId: string,
    sessionId: string | null,
  ): Promise<string | null> => {
    const scope = sessionId === null ? null : await scopes.forWorkspaceId(workspaceId);
    const row =
      scope === null || sessionId === null
        ? null
        : await sessionRows.forScope(scope).get(sessionId);
    return row?.agentId === agentId ? row.agentVersionId : null;
  };
  /** The run-start preflight against version `versionId`, or the row for `null` (a legacy pin). */
  const preflightAgainst = async (
    principal: RunPrincipal,
    agent: AgentRef,
    sessionId: string | null,
    modelOverride: ModelSelection | null,
    versionId: string | null,
    attachmentCount = 0,
    audioAttachmentCount = 0,
    files: Parameters<NonNullable<RunApiEnvironment['preflight']>>[7] = undefined,
  ) => {
    const pinned =
      versionId === null
        ? null
        : (await readRunAgent(principal.workspaceId, agent.id, versionId)).agent;
    // A new session pins the version `local` points at when it opens (issue #612), so its files
    // are that version's.
    const scope =
      versionId === null && sessionId === null
        ? await scopes.forWorkspaceId(principal.workspaceId)
        : null;
    const filesVersionId =
      versionId ?? (scope === null ? null : await pinnedVersionFor(scope, agent.id));
    return runPreflight.check({
      workspaceId: principal.workspaceId,
      agentId: agent.id,
      sessionId,
      modelOverride,
      ...(pinned === null ? {} : { agent: pinned }),
      ...(attachmentCount === 0 ? {} : { attachmentCount }),
      ...(audioAttachmentCount === 0 ? {} : { audioAttachmentCount }),
      files: {
        agentVersionId: filesVersionId,
        attachments: files?.attachments ?? [],
        ...(files?.fileScope === undefined ? {} : { fileScope: files.fileScope }),
      },
    });
  };
  // A follow-up is checked against the configuration it will run: its session's pinned version,
  // so a push never refuses (or lets through) an open conversation's next turn from the row. A new
  // session asked to pin a version (an evaluation, #618) is checked against that version.
  const runStartPreflight: NonNullable<RunApiEnvironment['preflight']> = async (
    principal,
    agent,
    sessionId,
    modelOverride,
    agentVersionId,
    attachmentCount,
    audioAttachmentCount,
    files,
  ) =>
    preflightAgainst(
      principal,
      agent,
      sessionId,
      modelOverride,
      agentVersionId ?? (await sessionPin(principal.workspaceId, agent.id, sessionId)),
      attachmentCount,
      audioAttachmentCount,
      files,
    );

  return {
    runtime,
    gatewaySettings,
    hostLaunch,
    gateway,
    runs,
    driverRegistry,
    runtimeProfiles,
    runPreflight,
    sessionPin,
    preflightAgainst,
    runStartPreflight,
  };
}

export type RunRuntimeWiring = NonNullable<Awaited<ReturnType<typeof wireRunRuntime>>>;
