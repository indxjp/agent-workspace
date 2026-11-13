import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import { createRunPreflight } from '../../compose/run-preflight';
import type {
  AgentRef,
  ModelSelection,
  RunStartEnvironment,
  RunPrincipal,
} from '../../runs/environment';
import type { createRepositoryRuntimeProfileStoreProvider } from '../../runtimes/store';
import type { AgentsWiring } from './agents';
import type { RunResourcesWiring } from './run-resources';
import { projectOfSession, sessionPinOf, spendLimitOf, versionOfRun } from './run-session-lookups';
import type { SubsystemsWiring } from './subsystems';

type RunPreflightDependencies = Parameters<typeof createRunPreflight>[0];
type RunStartPreflight = NonNullable<RunStartEnvironment['preflight']>;
type RunPreflightFiles = Parameters<RunStartPreflight>[7];

/** `preflightAgainst`'s arguments, in the order the token surfaces call it with. */
type PreflightAgainstArguments = [
  principal: RunPrincipal,
  agent: AgentRef,
  sessionId: string | null,
  modelOverride: ModelSelection | null,
  versionId: string | null,
  attachmentCount?: number,
  audioAttachmentCount?: number,
  files?: RunPreflightFiles,
];

type RunStartPreflightDependencies = Pick<
  AgentsWiring,
  'scopes' | 'sessionRows' | 'agents' | 'deploymentDefaultModels'
> &
  Pick<SubsystemsWiring, 'modelsApi'> &
  Pick<
    RunResourcesWiring,
    'wave5Repositories' | 'readRunAgent' | 'runFileSizes' | 'pinnedVersionFor'
  > & {
    readonly workspaceDefault: RunPreflightDependencies['workspaceDefault'];
    readonly policyCeiling: ProjectPolicy | null;
    readonly runtimeProfiles: ReturnType<typeof createRepositoryRuntimeProfileStoreProvider>;
  };

/** A project's default model, or `null` when the project sets no complete default. */
function projectModelDefault(project: {
  readonly defaultModelConnectionId: string | null;
  readonly defaultModel: string | null;
}): ModelSelection | null {
  if (project.defaultModelConnectionId === null || project.defaultModel === null) return null;
  return { connectionId: project.defaultModelConnectionId, model: project.defaultModel };
}

/**
 * Issue #393: what `runs.start` checks before it queues a run, and the model ladder the launch
 * resolves again - one implementation, so the pre-queue answer and the launch cannot disagree.
 */
function createStartPreflight(dependencies: RunStartPreflightDependencies) {
  const { wave5Repositories, policyCeiling } = dependencies;
  return createRunPreflight({
    runFiles: {
      loader: dependencies.runFileSizes,
      readRunAgent: dependencies.readRunAgent,
      projectOf: (workspaceId, sessionId) => projectOfSession(dependencies, workspaceId, sessionId),
    },
    agents: dependencies.agents,
    profiles: dependencies.runtimeProfiles,
    models: dependencies.modelsApi,
    deploymentDefaultModels: dependencies.deploymentDefaultModels,
    policyCeiling,
    workspaceDefault: dependencies.workspaceDefault,
    projectDefault: async (workspaceId, sessionId) => {
      const projectId = await projectOfSession(dependencies, workspaceId, sessionId);
      if (projectId === null) return null;
      const project = await (await wave5Repositories(workspaceId)).projects.get(projectId);
      return project === null ? null : projectModelDefault(project);
    },
    projectDefaults: async (workspaceId) => {
      // Active projects only: an archived project takes no new work, so its default is moot.
      const projects = await (await wave5Repositories(workspaceId)).projects.list('active');
      const defaults = new Map<string, ModelSelection>();
      for (const project of projects) {
        const selection = projectModelDefault(project);
        if (selection !== null) defaults.set(project.id, selection);
      }
      return defaults;
    },
  });
}

/** What one run-start preflight asks: which agent version, session, model and files. */
type RunStartQuery = Readonly<{
  principal: RunPrincipal;
  agent: AgentRef;
  sessionId: string | null;
  modelOverride: ModelSelection | null;
  versionId: string | null;
  attachmentCount: number;
  audioAttachmentCount: number;
  files: RunPreflightFiles;
}>;

function queryFromArguments([
  principal,
  agent,
  sessionId,
  modelOverride,
  versionId,
  attachmentCount = 0,
  audioAttachmentCount = 0,
  files,
]: PreflightAgainstArguments): RunStartQuery {
  return {
    principal,
    agent,
    sessionId,
    modelOverride,
    versionId,
    attachmentCount,
    audioAttachmentCount,
    files,
  };
}

/** Run the preflight for one start request against the version it names (`null`: a legacy pin). */
async function checkRunStart(
  dependencies: RunStartPreflightDependencies,
  runPreflight: ReturnType<typeof createStartPreflight>,
  query: RunStartQuery,
) {
  const { workspaceId } = query.principal;
  const { agent, sessionId, versionId, files } = query;
  const pinned =
    versionId === null
      ? null
      : (await dependencies.readRunAgent(workspaceId, agent.id, versionId)).agent;
  // A new session pins the version `local` points at when it opens (issue #612), so its files
  // are that version's.
  const filesVersionId = await versionOfRun(dependencies, {
    workspaceId,
    agentId: agent.id,
    versionId,
    sessionId,
  });
  return runPreflight.check({
    workspaceId,
    agentId: agent.id,
    sessionId,
    modelOverride: query.modelOverride,
    ...(pinned === null ? {} : { agent: pinned }),
    ...(query.attachmentCount === 0 ? {} : { attachmentCount: query.attachmentCount }),
    ...(query.audioAttachmentCount === 0
      ? {}
      : { audioAttachmentCount: query.audioAttachmentCount }),
    files: {
      agentVersionId: filesVersionId,
      attachments: files?.attachments ?? [],
      ...(files?.fileScope === undefined ? {} : { fileScope: files.fileScope }),
    },
  });
}

/** The run-start preflight, the pin lookups it needs and the spend limit a run composes with. */
export function wireRunStartPreflight(dependencies: RunStartPreflightDependencies) {
  const runPreflight = createStartPreflight(dependencies);
  const sessionPin = (workspaceId: string, agentId: string, sessionId: string | null) =>
    sessionPinOf(dependencies, workspaceId, agentId, sessionId);
  /** The run-start preflight against version `versionId`, or the row for `null` (a legacy pin). */
  const preflightAgainst = (...args: PreflightAgainstArguments) =>
    checkRunStart(dependencies, runPreflight, queryFromArguments(args));

  // A follow-up is checked against the configuration it will run: its session's pinned version,
  // so a push never refuses (or lets through) an open conversation's next turn from the row. A new
  // session asked to pin a version (an evaluation, #618) is checked against that version.
  const runStartPreflight: RunStartPreflight = async (...args) => {
    const [principal, agent, sessionId, modelOverride, agentVersionId, ...counts] = args;
    const versionId =
      agentVersionId ?? (await sessionPin(principal.workspaceId, agent.id, sessionId));
    return preflightAgainst(principal, agent, sessionId, modelOverride, versionId, ...counts);
  };

  return {
    runPreflight,
    sessionPin,
    preflightAgainst,
    runStartPreflight,
    spendLimitFor: spendLimitOf(dependencies),
  };
}
