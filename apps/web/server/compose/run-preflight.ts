import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { BUILDER_MODEL } from '@indx-workspace/contracts/builder';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { parseRunFailure } from '@indx-workspace/contracts/runs';
import type { AgentRecord } from '../agents/contract';
import { isBuilderAgent } from '../builder/agent/is-builder-agent';
import { builderModelUnavailableMessage } from '../builder/agent/model-unavailable';
import { DomainError } from '../errors';
import { transcribes, untranscribableRefusal } from '../runs/transcription';
import {
  loadAttachedFiles,
  runFilesTooLargeMessage,
  runFilesTotal,
  runInputFiles,
} from './resource-loader';
import { deploymentLayer, NO_MODEL_STORAGE, ownSelection } from './run-model-selection';
import type {
  RunFilesQuery,
  RunFilesSources,
  RunModelQuery,
  RunPreflight,
  RunPreflightDependencies,
} from './run-preflight-contract';
import {
  ceilingRefusalMessage,
  meetRunCeiling,
  resolveModelForRun,
  runResourcesWithinCeiling,
  type ModelResolution,
} from './run-request';
import {
  missingRuntimeProfile,
  modelResolutionRefusal,
  type RunStartRefusal,
} from './run-start-refusal';
import { createRunTargetDescriber } from './run-target-description';

export type {
  RunFilesQuery,
  RunFilesSources,
  RunModelQuery,
  RunPreflight,
  RunPreflightDependencies,
} from './run-preflight-contract';
export {
  codeLaunchedRunFailure,
  credentialRejectedFailure,
  missingRuntimeProfile,
  modelNotFoundFailure,
  modelResolutionRefusal,
  runStartRefusalError,
} from './run-start-refusal';
export type { LaunchedModel, RunStartRefusal, UnvalidatedModel } from './run-start-refusal';

/** Whether a Builder run's model resolution means no connection serves {@link BUILDER_MODEL}. */
function builderModelUnserved(resolution: ModelResolution): boolean {
  if (resolution.ok) return resolution.model !== BUILDER_MODEL;
  return (
    resolution.code === 'model_connection_unresolved' || resolution.code === 'model_unavailable'
  );
}

/**
 * The refusal of the run's files, or `null` to queue it. The run's granted files, skill files and
 * attachments are summed in bytes from catalog rows exactly as the launch selects them (the
 * session's assignments and project, within the ceiling, narrowed to `fileScope`, attachments
 * after). A loader refusal of a granted connection folder (over the cap, or gone) is answered now;
 * any other failure to read them queues the run: the launch reads them again and fails with the
 * reason, and judges the total again as the backstop.
 */
// @story US-STO-06
async function runFilesRefusalBeforeQueue(options: {
  readonly sources: RunFilesSources;
  readonly ceiling: ProjectPolicy | null;
  readonly query: RunModelQuery;
  readonly files: RunFilesQuery;
  readonly warn: ((message: string) => void) | undefined;
}): Promise<RunStartRefusal | null> {
  const { sources, ceiling, query, files, warn } = options;
  try {
    const [runAgent, projectId] = await Promise.all([
      sources.readRunAgent(query.workspaceId, query.agentId, files.agentVersionId),
      query.sessionId === null
        ? Promise.resolve(null)
        : sources.projectOf(query.workspaceId, query.sessionId),
    ]);
    const [granted, attached] = await Promise.all([
      runResourcesWithinCeiling({ principal: { workspaceId: query.workspaceId } }, runAgent, {
        resourceLoader: sources.loader,
        ceiling,
        projectId,
      }),
      loadAttachedFiles(sources.loader, query.workspaceId, files.attachments),
    ]);
    const total = runFilesTotal(
      runInputFiles(granted.files, attached.files, files.fileScope),
      granted.skills,
    );
    return total > RUN_FILES_MAX_BYTES
      ? { code: 'run_files_too_large', message: runFilesTooLargeMessage(total) }
      : null;
  } catch (error) {
    // @story US-STO-12
    if (
      error instanceof DomainError &&
      (error.code === 'run_files_too_large' || error.code === 'run_storage_grant_unavailable')
    ) {
      const message = parseRunFailure(error.publicMessage)?.message ?? error.publicMessage;
      return { code: error.code, message };
    }
    warn?.(
      `the run's files total was not judged before the run was queued; the launch judges it: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function resolveRunModel(
  dependencies: RunPreflightDependencies,
  query: RunModelQuery,
): Promise<ModelResolution> {
  if (dependencies.models === null) return NO_MODEL_STORAGE;
  const store = dependencies.models.models.forWorkspace(query.workspaceId);
  const agent =
    query.agent ?? (await dependencies.agents.forWorkspace(query.workspaceId).get(query.agentId));
  const agentSelection = agent === null ? null : ownSelection(agent);
  const [project, workspace] = await Promise.all([
    query.sessionId === null
      ? Promise.resolve(null)
      : dependencies.projectDefault(query.workspaceId, query.sessionId),
    dependencies.workspaceDefault(query.workspaceId),
  ]);
  const earlierLayerResolves =
    query.modelOverride !== null ||
    agentSelection !== null ||
    project !== null ||
    workspace !== null;
  const deployment =
    agent === null || earlierLayerResolves
      ? null
      : await deploymentLayer(agent, store, dependencies.deploymentDefaultModels);
  return resolveModelForRun(
    { run: query.modelOverride, agent: agentSelection, project, workspace, deployment },
    store,
    dependencies.models.discover,
    dependencies.warn,
  );
}

function attachmentRefusal({
  query,
  permissions,
  driver,
  provider,
}: {
  readonly query: RunModelQuery;
  readonly permissions: AgentRecord['permissions'];
  readonly driver: string;
  readonly provider: Extract<ModelResolution, { ok: true }>['provider'];
}): RunStartRefusal | null {
  // ADR-0146: an attachment is a read grant, so an agent that cannot read files cannot take one.
  if ((query.attachmentCount ?? 0) > 0 && !permissions.readFiles) {
    return {
      code: 'run_attachments_unreadable',
      message:
        'this run attaches files, but the agent running it does not have the readFiles ' +
        'permission; grant it, or start the run without attachments.',
    };
  }
  // ADR-0146 Decision 2: attachments reach the run through the runner's session-scoped hydrate,
  // which the `local` driver (an in-process runner whose `/files` is not session-scoped) lacks.
  if ((query.attachmentCount ?? 0) > 0 && driver === 'local') {
    return {
      code: 'run_attachments_unsupported_runtime',
      message:
        "this run attaches files, but the agent's runtime profile uses the local driver, " +
        'which cannot be handed session files; use another runtime, or start the run ' +
        'without attachments.',
    };
  }
  // Issue #1313: an audio attachment is transcribed through the run's model connection.
  if ((query.audioAttachmentCount ?? 0) > 0 && !transcribes(provider)) {
    return untranscribableRefusal(provider);
  }
  return null;
}

async function checkRun(
  dependencies: RunPreflightDependencies,
  query: RunModelQuery,
): Promise<RunStartRefusal | null> {
  const agent =
    query.agent ?? (await dependencies.agents.forWorkspace(query.workspaceId).get(query.agentId));
  // The route has already found the agent; one deleted since is the launcher's to report.
  if (agent === null) return null;
  const profile =
    agent.runtimeProfileId === null
      ? null
      : await dependencies.profiles.forWorkspace(query.workspaceId).get(agent.runtimeProfileId);
  if (profile === null) return missingRuntimeProfile(agent);
  const resolution = await resolveRunModel(dependencies, query);
  // The Builder is pinned to one model so its evals stay meaningful: no connection to choose,
  // the model not offered, or a fall-through to another model (a default) all mean no
  // connection serves it. An unreachable provider or a rejected key keeps its own refusal.
  if (isBuilderAgent(agent) && builderModelUnserved(resolution)) {
    return { code: 'builder_model_unavailable', message: builderModelUnavailableMessage() };
  }
  if (!resolution.ok) return modelResolutionRefusal(resolution);
  const { met, refused } = meetRunCeiling(
    { agent, permissions: agent.permissions, model: resolution.model },
    dependencies.policyCeiling,
  );
  if (refused.length > 0) {
    return { code: 'policy_cannot_widen', message: ceilingRefusalMessage(refused) };
  }
  const attachments = attachmentRefusal({
    query,
    permissions: met.permissions,
    driver: profile.driver,
    provider: resolution.provider,
  });
  if (attachments !== null) return attachments;
  // The storage design, §04: a run over the files cap is refused before a run row or a sandbox
  // exists. Row sizes only; nothing is read or hashed here.
  if (query.files !== undefined && dependencies.runFiles !== undefined) {
    const refusal = await runFilesRefusalBeforeQueue({
      sources: dependencies.runFiles,
      ceiling: dependencies.policyCeiling,
      query,
      files: query.files,
      warn: dependencies.warn,
    });
    if (refusal !== null) return refusal;
  }
  return null;
}
export function createRunPreflight(dependencies: RunPreflightDependencies): RunPreflight {
  return {
    resolveModel: (query) => resolveRunModel(dependencies, query),
    describe: createRunTargetDescriber(dependencies),
    check: (query) => checkRun(dependencies, query),
  };
}
