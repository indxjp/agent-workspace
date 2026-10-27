import type { ModelProvider, RunStartProblemCode } from '@indx-workspace/contracts/runs';

import type { ModelDiscovery } from '../models/discovery';
import type { ModelConnectionResource } from '../models/contract';
import type { DeploymentDefaultModels } from '../models/deployment-default';
import type { ResolvedModelConnection, WorkspaceModelsStore } from '../models/store';
import type { ModelSelection } from '../runs/environment';

// ── Model resolution (issue #129) ────────────────────────────────────────────────────────────────
//
// One connection + one provider-side model, written and read together as a pair at every layer
// that can supply one, and resolved by exactly one function, in exactly one documented order:
// run override > agent override > project default > workspace default > deployment default.
// `resolveModelForRun` is that function. It is called once per launch, by whoever composes the
// application (before `buildRunRequestFor`, so the resolved triple can be snapshotted onto the run
// row before the runtime is ever called), not by `buildRunRequestFor` itself — see that function's
// own `resolvedModel` parameter for how the two connect.
//
// The deployment default (issue #506, ADR-0103's amendment) is the one named exception to never
// mixing a connection from one level with a model from another: for an agent that names no model,
// it pairs the agent's connection — or, when the agent names none, the workspace's connection named
// `default` (contract C7, bound late) — with the deployment's configured id for that connection's
// provider. It is the last layer, reported as its own layer, and applies only when no other layer
// names a pair. The late binding of `default` happens in this layer only, so it changes nothing
// for a run an earlier layer resolves.

export type ModelResolutionLayer = 'run' | 'agent' | 'project' | 'workspace' | 'deployment';

/**
 * The deployment default layer (issue #506) of an agent that names no model: its connection and the
 * deployment's per-provider default model ids (`AW_DEPLOYMENT_DEFAULT_MODELS`).
 */
export type DeploymentLayer = {
  /**
   * The agent's own connection when it names one; otherwise the workspace's connection named
   * `default` (C7 bound at run time, because a version applied before that connection existed is
   * stored with none); `null` when the workspace has no such connection, which is a refusal.
   */
  readonly connectionId: string | null;
  readonly defaults: DeploymentDefaultModels;
};

/** Which selection each layer supplies, or `null` when that layer has none configured. */
export type ModelResolutionLayers = {
  readonly run: ModelSelection | null;
  readonly agent: ModelSelection | null;
  readonly project: ModelSelection | null;
  readonly workspace: ModelSelection | null;
  /**
   * Non-null whenever the agent names no model. It is **not** gated on a default or a connection
   * being configured, so an unconfigured deployment default is a refusal naming `deployment`,
   * never a silent skip.
   */
  readonly deployment: DeploymentLayer | null;
};

export type ModelResolution =
  | {
      readonly ok: true;
      readonly layer: ModelResolutionLayer;
      readonly connectionId: string;
      readonly model: string;
      readonly provider: ModelProvider;
      /**
       * `false` when the model list could not be read, so the model was not checked against it
       * (issue #393). A launch maps the provider's "model not found" answer to `model_unavailable`
       * only for such a run, because a validated model that is then not found is a different fault.
       */
      readonly validated: boolean;
      /** The selected connection's name, for a refusal sentence written after the launch. */
      readonly connectionName: string;
    }
  | ModelResolutionRefusal;

export type ModelResolutionRefusal = {
  readonly ok: false;
  /** Which layer's selection was refused — the preflight error's "actionable" half. */
  readonly layer: ModelResolutionLayer;
  /** The contract-declared code `runs.start` answers with (issue #393). */
  readonly code: Extract<
    RunStartProblemCode,
    | 'model_connection_unresolved'
    | 'model_connection_failed'
    | 'model_unavailable'
    | 'model_credential_rejected'
  >;
  readonly reason: string;
};

export const SELECTION_LAYERS = ['run', 'agent', 'project', 'workspace'] as const;

/** Contract C7's connection name: what a definition with no connection, or `default`, resolves to. */
export const DEFAULT_MODEL_CONNECTION_NAME = 'default';

/**
 * The refusal at the deployment layer for an agent that names neither a model nor a connection, in
 * a workspace with no connection named `default` for the deployment default to use.
 */
export const NO_DEFAULT_CONNECTION_REASON =
  'the agent names no model or model connection, no project or workspace default model is ' +
  `configured, and the workspace has no connection named "${DEFAULT_MODEL_CONNECTION_NAME}" for ` +
  'the deployment default model to use.';

/**
 * How a refusal names a layer's connection. The deployment layer supplies only a model id; its
 * connection is the agent's, so that is what the user is pointed at to fix.
 */
export function connectionSubject(layer: ModelResolutionLayer): string {
  return layer === 'deployment' ? "the agent's model connection" : `the ${layer} model connection`;
}

/** The `model_unavailable` sentence for `model` on the named connection of `layer`. */
export function modelUnavailableReason(
  layer: ModelResolutionLayer,
  model: string,
  connectionName: string,
): string {
  return layer === 'deployment'
    ? `the deployment default model "${model}" is not available at the agent's model connection "${connectionName}".`
    : `model "${model}" is not available at the ${layer} connection "${connectionName}".`;
}

export type ReadyConnection = {
  readonly ok: true;
  readonly connectionId: string;
  readonly connection: ModelConnectionResource;
  readonly resolved: ResolvedModelConnection;
};

/** The checks every layer's connection must pass: it exists, is ready and its credential reads. */
export async function readyConnectionFor(
  layer: ModelResolutionLayer,
  connectionId: string,
  store: WorkspaceModelsStore,
): Promise<ReadyConnection | ModelResolutionRefusal> {
  const connection: ModelConnectionResource | null = await store.get(connectionId);
  if (connection === null) {
    return {
      ok: false,
      layer,
      code: 'model_connection_unresolved',
      reason: `${connectionSubject(layer)} ${connectionId} no longer exists in this workspace.`,
    };
  }
  if (!connection.ready) {
    return {
      ok: false,
      layer,
      code: 'model_connection_unresolved',
      reason: `${connectionSubject(layer)} "${connection.name}" is not ready (missing credential or configuration).`,
    };
  }
  const resolved = await store.resolve(connectionId);
  if (resolved === null) {
    return {
      ok: false,
      layer,
      code: 'model_connection_unresolved',
      reason: `${connectionSubject(layer)} "${connection.name}"'s credential could not be read.`,
    };
  }
  return { ok: true, connectionId, connection, resolved };
}

/**
 * Validate `model` against the connection's discovered list. `pick` chooses the id from a readable
 * list (the exact id for an explicit selection, alias-or-dated for the deployment default) and
 * returns `null` when the model is not there.
 */
export async function validateModel(
  layer: ModelResolutionLayer,
  ready: ReadyConnection,
  model: string,
  pick: (discoveredIds: readonly string[]) => string | null,
  discover: ModelDiscovery,
  warn: (message: string) => void,
): Promise<ModelResolution> {
  const { connection, resolved } = ready;
  const discovered = await discover(resolved);
  let chosen = model;
  let validated = true;
  if (!discovered.ok) {
    if (discovered.failure.kind === 'credential-rejected') {
      return {
        ok: false,
        layer,
        code: 'model_credential_rejected',
        reason: `${connectionSubject(layer)} "${connection.name}": ${discovered.reason}`,
      };
    }
    if (discovered.failure.kind === 'connection-failed') {
      return {
        ok: false,
        layer,
        code: 'model_connection_failed',
        reason: `${connectionSubject(layer)} "${connection.name}": ${discovered.reason}`,
      };
    }
    warn(
      `[runs] model "${model}" on the ${layer} connection ${connection.id} was not ` +
        `validated because the model list could not be read (${discovered.failure.kind}); ` +
        'the run proceeds with the explicit selection.',
    );
    validated = false;
  } else {
    const picked = pick(discovered.models.map((entry) => entry.providerModelId));
    if (picked === null) {
      return {
        ok: false,
        layer,
        code: 'model_unavailable',
        reason: modelUnavailableReason(layer, model, connection.name),
      };
    }
    chosen = picked;
  }
  return {
    ok: true,
    layer,
    connectionId: ready.connectionId,
    model: chosen,
    provider: connection.provider,
    validated,
    connectionName: connection.name,
  };
}
