import type { ModelConnectionResource, WorkspaceModelsStore } from '../integrations';
import type { ModelSelection, RunTargetDescription, RunTargetDescriptions } from '../execution';
import { deploymentLayer, NO_MODEL_STORAGE, ownSelection } from './run-model-selection';
import type { RunPreflight, RunPreflightDependencies } from './run-preflight-contract';
import { NO_DEFAULT_CONNECTION_REASON, type DeploymentLayer } from './run-request';
import {
  missingRuntimeProfile,
  modelResolutionRefusal,
  type RunStartRefusal,
} from './run-start-refusal';

type DescribedLayers = {
  readonly agent: ModelSelection | null;
  readonly project: ModelSelection | null;
  readonly workspace: ModelSelection | null;
  readonly deployment: DeploymentLayer | null;
};

function unrunnable(refusal: RunStartRefusal): RunTargetDescription {
  return { kind: 'unrunnable', code: refusal.code, reason: refusal.message };
}

/** One description for one fixed set of ladder layers: the first non-null layer wins. */
async function describeLadder(
  hasModelStorage: boolean,
  readConnection: (connectionId: string) => Promise<ModelConnectionResource | null>,
  layers: DescribedLayers,
  runtimeProfileName: string,
): Promise<RunTargetDescription> {
  if (!hasModelStorage) {
    return { kind: 'unrunnable', code: NO_MODEL_STORAGE.code, reason: NO_MODEL_STORAGE.reason };
  }
  const source =
    layers.agent !== null ? 'agent' : layers.project !== null ? 'project' : 'workspace';
  const selection = layers.agent ?? layers.project ?? layers.workspace;
  if (selection === null && layers.deployment !== null) {
    return describeDeployment(readConnection, layers.deployment, runtimeProfileName);
  }
  if (selection === null) {
    return unrunnable(
      modelResolutionRefusal({
        ok: false,
        layer: 'workspace',
        code: 'model_connection_unresolved',
        reason: 'the agent names no model and no project or workspace default is configured.',
      }),
    );
  }
  const connection = await readConnection(selection.connectionId);
  if (connection === null || !connection.ready) {
    return unrunnable(
      modelResolutionRefusal({
        ok: false,
        layer: source,
        code: 'model_connection_unresolved',
        reason:
          connection === null
            ? `the ${source} model connection no longer exists.`
            : `the ${source} model connection "${connection.name}" is not ready.`,
      }),
    );
  }
  return {
    kind: 'runnable',
    source,
    connectionId: connection.id,
    connectionName: connection.name,
    provider: connection.provider,
    model: selection.model,
    runtimeProfileName,
  };
}

/**
 * The deployment default as the last fallback: the agent's connection, or the workspace's
 * connection named `default` when the agent names none, plus the configured id for its
 * provider. Like every description it reads stored configuration only, with no provider call,
 * so `model` is the **configured** id: when the connection's model list carries only dated
 * releases, the run itself uses the newest of them (`selectPreferredModel`), and the composer
 * says so (`runTargetLine`).
 */
async function describeDeployment(
  readConnection: (connectionId: string) => Promise<ModelConnectionResource | null>,
  deployment: DeploymentLayer,
  runtimeProfileName: string,
): Promise<RunTargetDescription> {
  if (deployment.connectionId === null) {
    return unrunnable(
      modelResolutionRefusal({
        ok: false,
        layer: 'deployment',
        code: 'model_connection_unresolved',
        reason: NO_DEFAULT_CONNECTION_REASON,
      }),
    );
  }
  const connection = await readConnection(deployment.connectionId);
  if (connection === null || !connection.ready) {
    return unrunnable(
      modelResolutionRefusal({
        ok: false,
        layer: 'deployment',
        code: 'model_connection_unresolved',
        reason:
          connection === null
            ? "the agent's model connection no longer exists."
            : `the agent's model connection "${connection.name}" is not ready.`,
      }),
    );
  }
  const model = deployment.defaults[connection.provider];
  if (model === undefined) {
    return unrunnable(
      modelResolutionRefusal({
        ok: false,
        layer: 'deployment',
        code: 'model_connection_unresolved',
        reason:
          `the agent's model connection "${connection.name}" names no model, no project or ` +
          'workspace default model is configured, and this deployment sets no default model for ' +
          `provider "${connection.provider}".`,
      }),
    );
  }
  return {
    kind: 'runnable',
    source: 'deployment',
    connectionId: connection.id,
    connectionName: connection.name,
    provider: connection.provider,
    model,
    runtimeProfileName,
  };
}

function cachedConnectionReader(
  store: WorkspaceModelsStore | null,
): (connectionId: string) => Promise<ModelConnectionResource | null> {
  const seen = new Map<string, Promise<ModelConnectionResource | null>>();
  return (connectionId: string): Promise<ModelConnectionResource | null> => {
    if (store === null) return Promise.resolve(null);
    let pending = seen.get(connectionId);
    if (pending === undefined) {
      pending = store.get(connectionId);
      seen.set(connectionId, pending);
    }
    return pending;
  };
}

function describeProjectDefaults({
  defaults,
  readConnection,
  workspace,
  deployment,
  runtimeProfileName,
}: {
  readonly defaults: readonly (readonly [string, ModelSelection])[];
  readonly readConnection: (connectionId: string) => Promise<ModelConnectionResource | null>;
  readonly workspace: ModelSelection | null;
  readonly deployment: DeploymentLayer | null;
  readonly runtimeProfileName: string;
}): Promise<readonly (readonly [string, RunTargetDescription])[]> {
  return Promise.all(
    defaults.map(
      async ([projectId, project]) =>
        [
          projectId,
          await describeLadder(
            true,
            readConnection,
            { agent: null, project, workspace, deployment },
            runtimeProfileName,
          ),
        ] as const,
    ),
  );
}

async function describeRunTarget(
  dependencies: RunPreflightDependencies,
  workspaceId: string,
  agentId: string,
): Promise<RunTargetDescriptions | null> {
  const agent = await dependencies.agents.forWorkspace(workspaceId).get(agentId);
  if (agent === null) return null;
  const profile =
    agent.runtimeProfileId === null
      ? null
      : await dependencies.profiles.forWorkspace(workspaceId).get(agent.runtimeProfileId);
  if (profile === null) {
    return { outsideProject: unrunnable(missingRuntimeProfile(agent)), byProject: new Map() };
  }
  const store = dependencies.models?.models.forWorkspace(workspaceId) ?? null;
  const own = ownSelection(agent);
  const workspace = own === null ? await dependencies.workspaceDefault(workspaceId) : null;
  // Every project described below sets a default, so only the description outside a project can
  // reach the deployment layer, and only when neither the agent nor the workspace names a model.
  const deployment =
    own === null && workspace === null
      ? await deploymentLayer(agent, store, dependencies.deploymentDefaultModels)
      : null;
  const readConnection = cachedConnectionReader(store);
  const outsideProject = await describeLadder(
    dependencies.models !== null,
    readConnection,
    { agent: own, project: null, workspace, deployment },
    profile.name,
  );
  if (own === null && dependencies.models !== null) {
    // One read per distinct connection, and every project described concurrently: projects
    // that share a default connection share its lookup.
    const defaults = [...(await dependencies.projectDefaults(workspaceId))];
    const described = await describeProjectDefaults({
      defaults,
      readConnection,
      workspace,
      deployment,
      runtimeProfileName: profile.name,
    });
    return { outsideProject, byProject: new Map(described) };
  }
  return { outsideProject, byProject: new Map() };
}

export function createRunTargetDescriber(
  dependencies: RunPreflightDependencies,
): RunPreflight['describe'] {
  return (workspaceId, agentId) => describeRunTarget(dependencies, workspaceId, agentId);
}
