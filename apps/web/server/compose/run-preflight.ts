/**
 * What `runs.start` checks before it queues a run (issue #393).
 *
 * A run used to be accepted with a `202`, queued, and only then found to have no runtime profile
 * or no model — and the one thing the caller saw was "The run request could not be prepared.",
 * while the real reason went to the server log. The two missing pieces are facts about stored
 * configuration, so they can be decided before a run row exists; this module decides them and
 * names each with a contract-declared code (`RUN_START_PROBLEM_CODES`).
 *
 * The same decisions run again while the run is composed (`register.ts`'s `buildRunRequest`),
 * because a configuration can change between the start and the launch. There they are thrown as a
 * {@link DomainError} whose public message is `<code>: <reason>`, so the run's stored `error` and
 * its `run-failed` frame carry the same code a pre-queue refusal would have answered with —
 * `parseRunFailure` in `@indx-workspace/contracts/runs` reads it back.
 */
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { parseRunFailure, type RunStartProblemCode } from '@indx-workspace/contracts/runs';

import type { AgentRecord } from '../agents/contract';
import type { AgentStoreProvider } from '../agents/store';
import { DomainError } from '../errors';
import { describeDiscoveryFailure, type ModelDiscovery } from '../models/discovery';
import type { ModelConnectionResource } from '../models/contract';
import type { DeploymentDefaultModels } from '../models/deployment-default';
import type { ModelsStoreProvider, WorkspaceModelsStore } from '../models/store';
import type { RuntimeProfileStoreProvider } from '../runtimes/store';
import type {
  ModelSelection,
  RunTargetDescription,
  RunTargetDescriptions,
} from '../runs/environment';
import {
  DEFAULT_MODEL_CONNECTION_NAME,
  NO_DEFAULT_CONNECTION_REASON,
  ceilingRefusalMessage,
  connectionSubject,
  meetRunCeiling,
  modelUnavailableReason,
  resolveModelForRun,
  type DeploymentLayer,
  type ModelResolution,
} from './run-request';

/** One refusal: the contract code and a sentence that names what to fix. */
export interface RunStartRefusal {
  readonly code: RunStartProblemCode;
  readonly message: string;
}

/** The refusal as a thrown error, for a check that fails after the run was queued. */
export function runStartRefusalError(refusal: RunStartRefusal): DomainError {
  return new DomainError({
    category: 'validation',
    code: refusal.code,
    publicMessage: `${refusal.code}: ${refusal.message}`,
  });
}

type RuntimeProfileHolder = {
  readonly id: string;
  readonly name: string;
  readonly runtimeProfileId: string | null;
};

/**
 * `agent_runtime_profile_missing` for an agent whose runtime profile could not be found: it names
 * none, or names one that no longer exists in its workspace. A runtime has no inheritance layer,
 * so there is nothing to fall back to.
 */
export function missingRuntimeProfile(agent: RuntimeProfileHolder): RunStartRefusal {
  return {
    code: 'agent_runtime_profile_missing',
    message:
      agent.runtimeProfileId === null
        ? `agent "${agent.name}" has no runtime profile. Attach a runtime profile to the agent, or finish the setup wizard.`
        : `agent "${agent.name}" selects runtime profile ${agent.runtimeProfileId}, which no longer exists. Attach an existing runtime profile to the agent.`,
  };
}

const MODEL_REMEDY: Readonly<Record<Extract<ModelResolution, { ok: false }>['code'], string>> = {
  model_connection_unresolved:
    'Choose a model on the agent, or set a workspace default model under Models.',
  // The discovery failure's own sentence already says to check the base URL and the network.
  model_connection_failed: '',
  model_unavailable: 'Choose a model the connection offers.',
  // The discovery failure's own sentence already says to replace the key on this connection.
  model_credential_rejected: '',
};

/** A failed model resolution as a refusal: the resolver's reason, then what to do about it. */
export function modelResolutionRefusal(
  resolution: Extract<ModelResolution, { ok: false }>,
): RunStartRefusal {
  return {
    code: resolution.code,
    message: `${resolution.reason} ${MODEL_REMEDY[resolution.code]}`.trim(),
  };
}

/** A launched run whose model was not checked against the provider's list (discovery was down). */
export interface UnvalidatedModel {
  readonly layer: Extract<ModelResolution, { ok: true }>['layer'];
  readonly connectionName: string;
  readonly model: string;
}

/** Every launched run's model selection, validated or not (issue #661). */
export interface LaunchedModel extends UnvalidatedModel {
  readonly validated: boolean;
}

/**
 * The coded failure for a run the engine stopped because the provider rejected the key once it was
 * running (issue #661), or `null` for any other failure. The engine reports
 * `model_credential_rejected: …`; the stored sentence is this one, naming the run's connection the
 * way the pre-queue refusal does, so the runtime's text is never stored as given. Only a `403`
 * status is read back from it; anything else is reported as the `401` it almost always is.
 */
export function credentialRejectedFailure(
  reason: string,
  launched: UnvalidatedModel,
): string | null {
  if (parseRunFailure(reason)?.code !== 'model_credential_rejected') return null;
  const status = /\bHTTP 403\b/u.test(reason) ? 403 : 401;
  return runStartRefusalError(
    modelResolutionRefusal({
      ok: false,
      layer: launched.layer,
      code: 'model_credential_rejected',
      reason: `${connectionSubject(launched.layer)} "${launched.connectionName}": ${describeDiscoveryFailure({ kind: 'credential-rejected', status })}`,
    }),
  ).publicMessage;
}

/**
 * The coded failure for a launched run the runtime reported failed, or `null` to store the generic
 * sentence: a rejected key is coded for every run (issue #661), "model not found" only for a run
 * whose model was queued unvalidated (PR #403 review).
 */
export function codeLaunchedRunFailure(
  reason: string,
  launched: LaunchedModel | undefined,
): string | null {
  if (launched === undefined) return null;
  return (
    credentialRejectedFailure(reason, launched) ??
    (launched.validated ? null : modelNotFoundFailure(reason, launched))
  );
}

/**
 * The provider's own "this model does not exist" answers: Anthropic's `not_found_error`, OpenAI's
 * `model_not_found`, and the plain sentences both use, which name the model id.
 */
const MODEL_NOT_FOUND_CODES = /\b(?:not_found_error|model_not_found)\b/iu;
const NOT_FOUND_SENTENCE = /\b(?:not found|does not exist|404)\b/iu;

/**
 * The coded failure for a run whose explicit model was queued unvalidated and that the provider
 * then refused as unknown (PR #403 review), or `null` for any other failure.
 *
 * Discovery being down is the one case where `runs.start` lets an unchecked model through, so it is
 * the one case where "the model does not exist" can first be learnt from the model call. Mapping it
 * to `model_unavailable` makes the run read as the pre-queue refusal would have: the same code, the
 * same sentence. A reason is only treated as "model not found" when it carries a provider code for
 * that or a not-found sentence, **and** names this model, so an unrelated 404 is not mislabelled.
 */
export function modelNotFoundFailure(reason: string, unvalidated: UnvalidatedModel): string | null {
  const matches =
    reason.includes(unvalidated.model) &&
    (MODEL_NOT_FOUND_CODES.test(reason) || NOT_FOUND_SENTENCE.test(reason));
  if (!matches) return null;
  return runStartRefusalError(
    modelResolutionRefusal({
      ok: false,
      layer: unvalidated.layer,
      code: 'model_unavailable',
      reason: modelUnavailableReason(
        unvalidated.layer,
        unvalidated.model,
        unvalidated.connectionName,
      ),
    }),
  ).publicMessage;
}

export interface RunPreflightDependencies {
  readonly agents: AgentStoreProvider;
  readonly profiles: RuntimeProfileStoreProvider;
  /** `null` when encrypted model storage is unavailable; then no model can resolve. */
  readonly models: {
    readonly models: ModelsStoreProvider;
    readonly discover: ModelDiscovery;
  } | null;
  readonly workspaceDefault: (workspaceId: string) => Promise<ModelSelection | null>;
  /** The project default of the project `sessionId` is filed under, or `null`. */
  readonly projectDefault: (
    workspaceId: string,
    sessionId: string,
  ) => Promise<ModelSelection | null>;
  /**
   * The default of every active project that sets one, by project id: what
   * {@link RunPreflight.describe} needs to say what a run would use in each project the composer
   * can select.
   */
  readonly projectDefaults: (workspaceId: string) => Promise<ReadonlyMap<string, ModelSelection>>;
  /**
   * The deployment's default model id per provider (`AW_DEPLOYMENT_DEFAULT_MODELS`, issue #506),
   * parsed once at startup: the ladder's last layer, for an agent that names no model. Empty when
   * the deployment sets none, which is a refusal naming `deployment`.
   */
  readonly deploymentDefaultModels: DeploymentDefaultModels;
  /**
   * The deployment's policy ceiling (`AW_DEPLOYMENT_POLICY`), or `null` for none (S2-04c). An engine
   * or a ladder-resolved model outside it refuses the run with `policy_cannot_widen`.
   */
  readonly policyCeiling: ProjectPolicy | null;
  readonly warn?: (message: string) => void;
}

export interface RunModelQuery {
  readonly workspaceId: string;
  readonly agentId: string;
  /**
   * The session the run continues, or `null` for a run that will open a new one. A new session
   * opened by `runs.start` belongs to no project (the start-run body carries none), so it has no
   * project default.
   */
  readonly sessionId: string | null;
  readonly modelOverride: ModelSelection | null;
  /**
   * The configuration the run composes from, when the caller has read it: a session's pinned
   * version (issue #612). Absent reads the agent row.
   */
  readonly agent?: AgentRecord;
}

export interface RunPreflight {
  /** The run's model, resolved through the documented ladder. */
  resolveModel(query: RunModelQuery): Promise<ModelResolution>;
  /** `null` when the run can be queued; otherwise the first missing piece. */
  check(query: RunModelQuery): Promise<RunStartRefusal | null>;
  /**
   * What a new run of this agent would use, for a screen to show before anything is sent, or
   * `null` when the agent does not exist. It follows the run ladder below the run override: the
   * agent's own model, then the selected project's default, then the workspace default, then the
   * deployment default for the agent's connection (or the workspace's connection named `default`
   * when the agent names none). It reads
   * stored configuration only, with no provider call, so it is cheap enough for every agent on a
   * page; the run itself still validates the model.
   */
  describe(workspaceId: string, agentId: string): Promise<RunTargetDescriptions | null>;
}

const NO_MODEL_STORAGE: Extract<ModelResolution, { ok: false }> = {
  ok: false,
  layer: 'workspace',
  code: 'model_connection_unresolved',
  reason:
    'no model can be resolved for this run: encrypted model storage is unavailable, so no connection can be read.',
};

function unrunnable(refusal: RunStartRefusal): RunTargetDescription {
  return { kind: 'unrunnable', code: refusal.code, reason: refusal.message };
}

/** The two fields of an agent row the model ladder reads. */
type AgentModelFields = {
  readonly modelConnectionId: string | null;
  readonly model: string | null;
};

function ownSelection(agent: AgentModelFields): ModelSelection | null {
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
async function deploymentLayer(
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

type DescribedLayers = {
  readonly agent: ModelSelection | null;
  readonly project: ModelSelection | null;
  readonly workspace: ModelSelection | null;
  readonly deployment: DeploymentLayer | null;
};

export function createRunPreflight(dependencies: RunPreflightDependencies): RunPreflight {
  const resolveModel = async (query: RunModelQuery): Promise<ModelResolution> => {
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
  };

  /** One description for one fixed set of ladder layers: the first non-null layer wins. */
  const describeLadder = async (
    readConnection: (connectionId: string) => Promise<ModelConnectionResource | null>,
    layers: DescribedLayers,
    runtimeProfileName: string,
  ): Promise<RunTargetDescription> => {
    if (dependencies.models === null) {
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
  };

  /**
   * The deployment default as the last fallback: the agent's connection, or the workspace's
   * connection named `default` when the agent names none, plus the configured id for its
   * provider. Like every description it reads stored configuration only, with no provider call,
   * so `model` is the **configured** id: when the connection's model list carries only dated
   * releases, the run itself uses the newest of them (`selectPreferredModel`), and the composer
   * says so (`runTargetLine`).
   */
  const describeDeployment = async (
    readConnection: (connectionId: string) => Promise<ModelConnectionResource | null>,
    deployment: DeploymentLayer,
    runtimeProfileName: string,
  ): Promise<RunTargetDescription> => {
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
  };

  const describe = async (
    workspaceId: string,
    agentId: string,
  ): Promise<RunTargetDescriptions | null> => {
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
    const seen = new Map<string, Promise<ModelConnectionResource | null>>();
    const readConnection = (connectionId: string): Promise<ModelConnectionResource | null> => {
      if (store === null) return Promise.resolve(null);
      let pending = seen.get(connectionId);
      if (pending === undefined) {
        pending = store.get(connectionId);
        seen.set(connectionId, pending);
      }
      return pending;
    };
    const outsideProject = await describeLadder(
      readConnection,
      { agent: own, project: null, workspace, deployment },
      profile.name,
    );
    if (own === null && dependencies.models !== null) {
      // One read per distinct connection, and every project described concurrently: projects
      // that share a default connection share its lookup.
      const defaults = [...(await dependencies.projectDefaults(workspaceId))];
      const described = await Promise.all(
        defaults.map(
          async ([projectId, project]) =>
            [
              projectId,
              await describeLadder(
                readConnection,
                { agent: null, project, workspace, deployment },
                profile.name,
              ),
            ] as const,
        ),
      );
      return { outsideProject, byProject: new Map(described) };
    }
    return { outsideProject, byProject: new Map() };
  };

  return {
    resolveModel,
    describe,
    async check(query) {
      const agent =
        query.agent ??
        (await dependencies.agents.forWorkspace(query.workspaceId).get(query.agentId));
      // The route has already found the agent; one deleted since is the launcher's to report.
      if (agent === null) return null;
      const profile =
        agent.runtimeProfileId === null
          ? null
          : await dependencies.profiles.forWorkspace(query.workspaceId).get(agent.runtimeProfileId);
      if (profile === null) return missingRuntimeProfile(agent);
      const resolution = await resolveModel(query);
      if (!resolution.ok) return modelResolutionRefusal(resolution);
      const { refused } = meetRunCeiling(
        agent,
        agent.permissions,
        resolution.model,
        dependencies.policyCeiling,
      );
      return refused.length === 0
        ? null
        : { code: 'policy_cannot_widen', message: ceilingRefusalMessage(refused) };
    },
  };
}
