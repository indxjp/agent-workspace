import type { DeploymentDefaultModels, WorkspaceModelsStore } from '../integrations';
import type { ModelSelection } from '../execution';
import {
  DEFAULT_MODEL_CONNECTION_NAME,
  type DeploymentLayer,
  type ModelResolution,
} from './run-request';

export const NO_MODEL_STORAGE: Extract<ModelResolution, { ok: false }> = {
  ok: false,
  layer: 'workspace',
  code: 'model_connection_unresolved',
  reason:
    'no model can be resolved for this run: encrypted model storage is unavailable, so no connection can be read.',
};

/** The two fields of an agent row the model ladder reads. */
type AgentModelFields = {
  readonly modelConnectionId: string | null;
  readonly model: string | null;
};

export function ownSelection(agent: AgentModelFields): ModelSelection | null {
  return agent.modelConnectionId === null || agent.model === null
    ? null
    : { connectionId: agent.modelConnectionId, model: agent.model };
}

/**
 * The deployment default layer (issue #506) for an agent that names no model, or `null` for one
 * that names a model. Callers build it only once every earlier layer (run, agent, project,
 * workspace) resolved nothing, so it changes nothing for a run those layers resolve.
 *
 * Its connection is the agent's own, or — when the agent names none — the workspace's connection
 * named `default` (names are unique in a workspace). That is contract C7 bound at run time, and
 * only here: a version that names no connection, or `default`, is stored with
 * `modelConnectionId: null` when the workspace had no connection named `default` at apply time.
 * `aw dev` without `ANTHROPIC_API_KEY` reaches that state, and a restart that then creates
 * `default` does not re-apply an unchanged version, so the agent would otherwise be refused for
 * ever. With neither connection the layer carries `connectionId: null`, which is a refusal naming
 * the missing `default` connection. Not gated on a default model being configured either: an
 * unconfigured one is a refusal naming `deployment`, never a silent skip. Reads stored
 * configuration only, never the provider.
 */
export async function deploymentLayer(
  agent: AgentModelFields,
  store: WorkspaceModelsStore | null,
  defaults: DeploymentDefaultModels,
): Promise<DeploymentLayer | null> {
  if (agent.model !== null) return null;
  if (agent.modelConnectionId !== null) return { connectionId: agent.modelConnectionId, defaults };
  const named =
    store === null
      ? undefined
      : (await store.list()).find(
          (connection) => connection.name === DEFAULT_MODEL_CONNECTION_NAME,
        );
  return { connectionId: named?.id ?? null, defaults };
}
