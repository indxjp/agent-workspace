/**
 * How a control-plane agent becomes a spec §14.3 run request.
 *
 * `apps/web/server/runs/launcher.ts` posts a body to `POST {runner}/run` and does not know what
 * is in it — deliberately, because the body is `RunRequest` from `@agent-workspace/core` and
 * `RunRequest` is `.strict()`: it needs the agent's model, instructions, permissions, skill
 * surface and MCP connectors, the sandbox `cwd`, the §25 tenant namespace and the subprocess
 * environment. Only the composition root can answer those, so this is where the answer lives.
 *
 * **This is the mapping that had never been executed.** Until W1-COMP-01 the launcher posted
 * `{ runId, sessionId, agentId, prompt }`, and the first time that reached the real
 * `apps/runner` it came back:
 *
 * ```text
 * HTTP/1.1 400 Bad Request
 * {"error":"invalid_run_request", … "path":["cwd"] … ["portable"] … ["session"] …
 *  ["env"] … "code":"unrecognized_keys","keys":["agentId"]}
 * ```
 *
 * The functions here are pure and take everything they need as arguments, so
 * `run-request.test.ts` can check the result against `RunRequest` itself — the same schema the
 * runner parses with — rather than against a copy of what it is believed to want.
 *
 * ## What ENG-04b (#325) took out of this file
 *
 * The **Claude tool mapping**. `toolPolicyFor` derived `Read` / `Bash` / `WebFetch` and their
 * siblings from §17 Step 4's four checkboxes, `agentConfigFor` unioned the agent's stored policy
 * into the result and added an `mcp__<server>__*` approval per assigned connector, and
 * `sandboxFor` chose `${cwd}/.claude` as the engine's configuration directory. Every one of those
 * strings belongs to one engine, and this application may not import an engine adapter
 * (`dependency-cruiser.config.mjs`) — so it was writing in a vocabulary it could not check.
 *
 * What is left is the **portable core** ({@link portableAgentConfigFor}) plus the engine-native arm
 * forwarded verbatim from the agent's stored policy, and one deliberate exception: the read-only
 * file-grant denials of {@link applyFileGrantPolicy}, kept as a compose-side guard whose removal
 * condition its own doc comment records.
 * `docs/adr/0072-the-claude-tool-mapping-and-skills-live-in-the-claude-adapter.md` is the decision.
 */
import { isIP } from 'node:net';

import {
  DEFAULT_RUN_ENGINE,
  RunRequest,
  type AgentPermissions,
  type PortableAgentConfig,
} from '@agent-workspace/core';

import {
  claudeReadOnlyGrantDenials,
  engineSettingsOf,
  type AgentToolPolicy,
} from '@indx-workspace/contracts/agents';
import {
  ENGINE_CATALOGUE,
  isEngineId,
  isWithholdingEngine,
  mcpToolName,
} from '@indx-workspace/contracts/engines';
import {
  meetPolicyCeiling,
  policyWidenings,
  type EffectivePolicyConfiguration,
  type PolicyWidening,
  type ProjectPolicy,
} from '@indx-workspace/contracts/policy-ceiling';
import {
  AW_DEV_TOOLS_CONNECTOR,
  GATEWAY_TOOL_SANDBOX_ROUTE,
  TOOL_NAME_MAX_LENGTH,
  TOOL_SANDBOX_CONNECTOR_URL,
  gatewayToolPath,
} from '@indx-workspace/contracts/tool-connectors';

import {
  AGENT_PERMISSION_KEYS,
  type AgentPermissionKey,
  policyNarrowedPermissions,
} from '../../contracts/agents';
import { DomainError } from '../errors';
import { atStep } from '../runs/failures';
import { storedEffective } from '../policy-ceiling/ceiling';
import { registeredEngine } from '../engines/registry';
import { resolveWireProtocol } from '../engines/protocol';
import type { AgentRecord } from '../agents/contract';
import type { RunAgent, RunSubagent } from '../agent-versions/session-version';
import type { ModelProvider, RunStartProblemCode } from '@indx-workspace/contracts/runs';

import type { ModelDiscovery } from '../models/discovery';
import type { ModelConnectionResource } from '../models/contract';
import type { DeploymentDefaultModels } from '../models/deployment-default';
import { selectPreferredModel } from '../models/preferred-model';
import type { ResolvedModelConnection, WorkspaceModelsStore } from '../models/store';
import type { RunTokenIssuer } from '../gateway/issuer';
import type { LaunchContext, ModelSelection } from '../runs/environment';
import type {
  AgentRunResourceLoader,
  AgentRunResourceSelection,
  PendingToolConnector,
} from './resource-loader';

/** Records the run's tool connector ids before the request is posted (C16). Throws on failure. */
export type RunToolSnapshot = (runId: string, connectorIds: readonly string[]) => Promise<void>;

/** The deployment values a run needs, once they have been read and found usable. */
export interface RuntimeSettings {
  /** `POST {runnerUrl}/run` — the §14.3 contract. No trailing slash. */
  readonly runnerUrl: string;
  /**
   * The directory, **inside the runtime container**, under which each workspace's sandbox lives.
   *
   * §25 requires a distinct `cwd` per workspace and forbids two tenants sharing one; this is the
   * parent of those, and the workspace id is the segment appended to it. It has a default because
   * it is a path in an image this repository builds, not a secret and not a value an operator has
   * to know — `Dockerfile`'s runner target works in `/app`, and `/workspace` is a sibling of it
   * that no build step writes to. Override it when the runtime is somebody else's image.
   */
  readonly workspaceRoot: string;
  /**
   * Whether the runner allocated this run's session a tool sandbox (ADR-0118 TS2). Absent for a
   * runtime that has none, which a run with code tools refuses by name.
   */
  readonly toolSandbox?: boolean;
}

export type RuntimeSettingsResult =
  | { readonly ok: true; readonly settings: RuntimeSettings }
  | { readonly ok: false; readonly reason: string };

/** The default for {@link RuntimeSettings.workspaceRoot}. See that field for why it has one. */
export const DEFAULT_WORKSPACE_ROOT = '/workspace';

/**
 * Read the runtime's deployment values, or say what is missing.
 *
 * `RUNNER_URL` has **no default**. A guess would be a URL nobody chose, and the failure it
 * produces — every run failing thirty seconds later with a connection error written into the run
 * record — is far worse than the 503 the run routes answer while this returns `ok: false`. That
 * is the ADR-0015 shape applied to configuration: the capability is unavailable because nothing
 * asserted it was available.
 *
 * The URL is parsed before it is used, so a value that is not a URL is rejected here with the
 * variable's name attached rather than at the first `fetch` of the first run.
 */
export function readRuntimeSettings(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeSettingsResult {
  const raw = env['RUNNER_URL'];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      ok: false,
      reason:
        'RUNNER_URL is not set, so there is no spec §14.3 runtime to relay runs to. The three ' +
        'run routes answer 503 run_api_not_configured until it is. Set it to the runtime ' +
        "container's base URL — inside compose that is http://runner:8080.",
    };
  }
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: `RUNNER_URL is not a parseable URL: ${JSON.stringify(trimmed)}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `RUNNER_URL uses the "${parsed.protocol}" scheme; §14.3 is an HTTP contract.`,
    };
  }

  const rawRoot = env['RUNNER_WORKSPACE_ROOT'];
  const workspaceRoot =
    typeof rawRoot === 'string' && rawRoot.trim().length > 0
      ? rawRoot.trim().replace(/\/+$/, '')
      : DEFAULT_WORKSPACE_ROOT;
  if (workspaceRoot.length === 0) {
    return { ok: false, reason: 'RUNNER_WORKSPACE_ROOT is only slashes.' };
  }

  return {
    ok: true,
    settings: { runnerUrl: trimmed.replace(/\/+$/, ''), workspaceRoot },
  };
}

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

// `ModelSelection` itself lives on `../runs/environment` — `LaunchContext.modelOverride` needs it
// too, and that module has no reason to import this one back.
export type { ModelSelection } from '../runs/environment';

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

type ModelResolutionRefusal = {
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

const SELECTION_LAYERS = ['run', 'agent', 'project', 'workspace'] as const;

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

type ReadyConnection = {
  readonly ok: true;
  readonly connectionId: string;
  readonly connection: ModelConnectionResource;
  readonly resolved: ResolvedModelConnection;
};

/** The checks every layer's connection must pass: it exists, is ready and its credential reads. */
async function readyConnectionFor(
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
async function validateModel(
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

/**
 * Resolve one run's `(connection, model)` pair against the documented precedence, validating the
 * winning layer's connection readiness and current discovery before returning it.
 *
 * The order is run > agent > project > workspace > deployment. The **first non-null layer wins
 * outright** — a run override with an unready connection is a refusal naming `run`, never a
 * fall-through to the agent's own default; issue #129's acceptance criteria are explicit that no
 * layer may be silently skipped in favour of a lower one. `ok: false` always names the layer that
 * was tried and refused, or `'workspace'` when every layer was `null` — the empty layer nearest the
 * ground, and the one an operator fixes by setting a workspace default.
 *
 * The **deployment default** (issue #506) is the last layer and the one named exception to never
 * mixing a connection from one level with a model from another: when the agent names no model and
 * no other layer names a pair, the run gets the agent's connection — or, when it names none, the
 * workspace's connection named `default` — plus the deployment's configured id for the
 * connection's provider. With neither connection it is a `model_connection_unresolved` refusal
 * naming `deployment`. Its connection passes the same checks as every other layer. A provider with no configured id is a `model_connection_unresolved` refusal naming
 * `deployment`, decided before any provider call; a readable model list picks the exact id or its
 * newest dated release (`selectPreferredModel`).
 *
 * A selection is refused when: its connection no longer exists in this workspace; its connection
 * is not `ready` (issue #126's derived readiness — a credential and every required config field);
 * the provider rejected the connection's key (`401`/`403` on the model list); the provider could
 * not be connected to at all (connection refused or DNS lookup failed, issue #661); or its `model`
 * is not among what discovery reports for that connection.
 *
 * **A model list that cannot be read is not a refusal** (issue #393). Every layer's selection is an
 * explicit `(connection, model)` pair on a connection that is ready, and a `429`, a `5xx` or an
 * unreachable provider says nothing about whether that model exists — it said only that the list
 * could not be fetched just now. Refusing there made every run hard-depend on a catalogue call,
 * and a rate-limited catalogue read like a broken key. So the run proceeds, `warn` records that the
 * model was not validated, and a model that really is gone fails at its first model call with the
 * provider's own answer. A list cached for the same key is still used when discovery returns one
 * marked stale. A rejected key is different: it is the one failure that is about the credential,
 * so it is refused with `model_credential_rejected` rather than sent to fail inside a sandbox.
 * A provider that refuses the connection or does not resolve is refused too, with
 * `model_connection_failed` (issue #661): the run's model calls leave from the same network, so
 * it would only spend minutes retrying before failing the same way. A timeout or a reset still
 * proceeds.
 */
export async function resolveModelForRun(
  layers: ModelResolutionLayers,
  store: WorkspaceModelsStore,
  discover: ModelDiscovery,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<ModelResolution> {
  for (const layer of SELECTION_LAYERS) {
    const selection = layers[layer];
    if (selection === null) continue;

    const ready = await readyConnectionFor(layer, selection.connectionId, store);
    if (!ready.ok) return ready;
    return validateModel(
      layer,
      ready,
      selection.model,
      (ids) => (ids.includes(selection.model) ? selection.model : null),
      discover,
      warn,
    );
  }

  const deployment = layers.deployment;
  if (deployment !== null) {
    if (deployment.connectionId === null) {
      return {
        ok: false,
        layer: 'deployment',
        code: 'model_connection_unresolved',
        reason: NO_DEFAULT_CONNECTION_REASON,
      };
    }
    const ready = await readyConnectionFor('deployment', deployment.connectionId, store);
    if (!ready.ok) return ready;
    const provider = ready.connection.provider;
    const configured = deployment.defaults[provider];
    if (configured === undefined) {
      return {
        ok: false,
        layer: 'deployment',
        code: 'model_connection_unresolved',
        reason:
          `the agent's model connection "${ready.connection.name}" names no model, no project or ` +
          'workspace default model is configured, and this deployment sets no default model for ' +
          `provider "${provider}".`,
      };
    }
    return validateModel(
      'deployment',
      ready,
      configured,
      (ids) => selectPreferredModel(configured, ids),
      discover,
      warn,
    );
  }

  return {
    ok: false,
    layer: 'workspace',
    code: 'model_connection_unresolved',
    reason:
      'no model connection resolves for this run: the agent names none and no workspace default is configured.',
  };
}

/**
 * The §17 agent record as the **portable core** of a run request (#299's portable/engine-native
 * table; ENG-04b, #325).
 *
 * Until ENG-04b this function also produced §17 Step 4's SDK-facing detail — `tools`, in the Claude
 * Agent SDK's own tool vocabulary, derived here from the four permission checkboxes and from the
 * assigned connectors. It does not any more: the checkboxes *are* the portable statement, and the
 * engine's adapter maps them onto its own tool names
 * (`packages/engine-claude-agent-sdk/src/tools.ts`). What is left here is everything that means the
 * same thing on every engine.
 *
 * Three of the fields have no column behind them in this wave and are set to the narrowest value
 * that is true rather than to the widest that would work, **when `agent.policy` is NULL** — every
 * agent until a `PUT /api/agents/:id/policy` replaces it (S-13):
 *
 *   * `skills: { mode: 'allowlist', names: [] }` — **not** `{ mode: 'all' }`. "All of a set nobody
 *     has chosen" is the reading that hands a run every skill directory on the image.
 *   * `mcpServers: {}` — an agent with no connector assignment gets none.
 *   * `limits` — `maxTurns: null` means the engine's own default, which is what an agent with no
 *     configured limit has; `maxBudgetUsd: null` is no per-run cap, and §20.6.3's budgets sit
 *     above it.
 *
 * `skills` is *intersected* with the skills currently assigned to the agent, and `limits` comes from
 * the stored policy verbatim when there is one. That intersection is what keeps a stored policy
 * strictly narrowing (`docs/adr/SDK-02-AGENT-POLICY-234-stored-policy-is-a-narrowing-jsonb-column.md`):
 * a stored `{ mode: 'all' }` is composed as "every skill *currently assigned*", never as the whole
 * discoverable surface, and a stored allowlist loses any name whose assignment has since been
 * revoked. The `409 skill_not_assigned` refusal at `PUT` checks the same membership at write time;
 * this is the read-time half, so a policy that was valid when it was stored cannot go stale into a
 * widening. The *tool* half of the same rule is now enforced by the adapter, which unions the
 * permission floor into whatever the stored arm says rather than letting it replace them.
 */
export function portableAgentConfigFor(
  agent: AgentRecord,
  permissionOverride: AgentPermissions | undefined = undefined,
  projectInstructions: string | null = null,
  resources: AgentRunResourceSelection = { files: [], skills: [], mcpServers: {} },
  // issue #129: the model the run actually resolved to, which may come from any layer — not only
  // the agent's own stored default. Defaults to `agent.model` so a caller that has not yet wired
  // resolution (or a test exercising this function directly) keeps today's behaviour unchanged.
  model: string | null = agent.model,
  subagents: readonly RunSubagent[] = [],
): PortableAgentConfig {
  const policy = agent.policy;
  // ADR-0074 D12: a withholding arm (`openai-agents`, `pi`, `mastra`) may withhold switches an
  // engine switch carried from the Claude arm's `tools.deny`/`permissionMode`. It only turns switches off, so it applies on top
  // of a run-level override as well as on top of the checkboxes.
  const permissions = policyNarrowedPermissions(permissionOverride ?? agent.permissions, policy);
  const assignedSkillNames = new Set(resources.skills.map((skill) => skill.name));
  const skills: PortableAgentConfig['skills'] =
    policy === null || policy.skills.mode === 'all'
      ? { mode: 'allowlist', names: [...assignedSkillNames] }
      : {
          mode: 'allowlist',
          names: policy.skills.names.filter((name) => assignedSkillNames.has(name)),
        };
  const limits: PortableAgentConfig['limits'] =
    policy === null ? { maxTurns: null, maxBudgetUsd: null } : { ...policy.limits };

  return {
    name: agent.name,
    instructions:
      projectInstructions === null || projectInstructions.length === 0
        ? agent.instructions
        : `${agent.instructions}\n\n${projectInstructions}`,
    model,
    permissions,
    skills,
    mcpServers: { ...resources.mcpServers },
    limits,
    // Only when non-empty, so a request without subagents is byte-identical to before.
    ...(subagents.length === 0
      ? {}
      : {
          subagents: subagents.map((sub) => {
            const own = policyNarrowedPermissions(sub.permissions, sub.policy);
            return {
              name: sub.name,
              description: sub.description,
              instructions: sub.instructions,
              model: sub.model,
              // A subagent can only narrow its parent's composed permissions.
              permissions: {
                readFiles: own.readFiles && permissions.readFiles,
                writeFiles: own.writeFiles && permissions.writeFiles,
                runCommands: own.runCommands && permissions.runCommands,
                unrestrictedNetwork: own.unrestrictedNetwork && permissions.unrestrictedNetwork,
              },
            };
          }),
        }),
  };
}

/**
 * The engine-native arm of the private `/run` contract, for the engine this run is addressed to.
 *
 * The stored policy's engine-specific half, forwarded **verbatim** — never recomputed here. That is
 * the whole of ENG-04b's first item: `AgentPolicy` is discriminated by engine and its `tools` field
 * is *"engine-native: the Claude Agent SDK's own tool grammar. No other arm may reuse it"*
 * (`packages/contracts/src/agents.ts`), so this function's job is to hand it across, not to
 * interpret it. An agent with no stored policy sends `tools: null`, and the adapter compiles the
 * permission floor alone.
 *
 * A further engine of the withholding kind adds nothing here: its settings come from the engine
 * catalogue (ADR-0136).
 */
function enginePolicyArmFor(
  agent: AgentRecord,
  cwd: string,
  resources: Pick<AgentRunResourceSelection, 'files' | 'connectorKeys'>,
): unknown {
  const policy = agent.policy;
  // A withholding arm is its engine-native settings, verbatim: the adapter compiles its tools from
  // the portable permissions and enforces grants itself, and has no pre-ENG-04 image to be
  // defended for (ADR-0072 D5).
  if (policy !== null && isWithholdingEngine(policy.engine)) return engineSettingsOf(policy);
  return {
    tools:
      policy !== null && 'tools' in policy
        ? withRunConnectorKeys(policy.tools, resources.connectorKeys ?? {})
        : null,
    fileGrantDeny: applyFileGrantPolicy(cwd, resources.files),
  };
}

const LEGACY_CONNECTOR_RULE_PREFIX = /^mcp__connector-([0-9a-f-]{36})__/u;

/**
 * A stored Claude tool policy with every rule written against an MCP connector's old server key,
 * `mcp__connector-<id>__…`, pointed at the key the connector has in this run (ADR-0113 SD13,
 * #1109), so a `deny` or an `autoApprove` keeps its meaning when the key is its slug name. A rule
 * for a connector not in the run, or already in the run's key form, is left as it is.
 */
function withRunConnectorKeys<T extends AgentToolPolicy>(
  tools: T,
  keys: Readonly<Record<string, string>>,
): T {
  const rewrite = (rules: readonly string[]): readonly string[] =>
    rules.map((rule) =>
      rule.replace(LEGACY_CONNECTOR_RULE_PREFIX, (prefix, id: string) => {
        const key = keys[id];
        return key === undefined ? prefix : `mcp__${key}__`;
      }),
    );
  return {
    ...tools,
    base: tools.base === 'claude_code_preset' ? tools.base : rewrite(tools.base),
    autoApprove: rewrite(tools.autoApprove),
    deny: rewrite(tools.deny),
  };
}

/**
 * File grants narrow the agent-wide permission switches: read-only paths are removed from the
 * engine's write tools, and command execution is removed because a shell redirect would otherwise
 * bypass those tool-specific rules. The runner also materialises these paths with read-only
 * filesystem modes; the two checks protect independent write paths.
 *
 * ## This is the legacy guard, and here is when it can be removed (ENG-04b, #325)
 *
 * The rules (`@indx-workspace/contracts`' `claudeReadOnlyGrantDenials`, shared with the adapter) are
 * written in the Claude Agent SDK's tool vocabulary — the one thing this unit
 * otherwise removed from compose — and they are kept deliberately, as **defence in depth on the
 * compose side**. `packages/engine-claude-agent-sdk`'s `claudeFileGrantDenials` derives the same
 * list from the same grants and the adapter de-duplicates the two in order, so this list can only
 * ever narrow a run and never widen or reorder one; ENG-04b's refinement theorem covers both the
 * request that carries it and the request that does not.
 *
 * It exists for a runner image whose Claude adapter predates ENG-04 (#324) — one that trusted the
 * control plane to have compiled grant denials, because at that point nothing else did. It may be
 * deleted once the minimum supported runtime image carries an adapter that compiles grants itself,
 * which is every image from ENG-04 onwards;
 * `docs/adr/0072-the-claude-tool-mapping-and-skills-live-in-the-claude-adapter.md` records the condition so
 * that removing it is a decision somebody takes rather than a line nobody dares touch.
 */
export function applyFileGrantPolicy(
  cwd: string,
  files: AgentRunResourceSelection['files'],
): readonly string[] {
  return claudeReadOnlyGrantDenials(
    cwd,
    files.filter((file) => file.access === 'read'),
  );
}

/**
 * The sandbox root and tenant namespace for one workspace.
 *
 * `projectKey` is the workspace id, and the SDK's own validator for `CLAUDE_CODE_PROJECT_DIR_NAME`
 * — `/^[A-Za-z0-9_-]{1,64}$/`, transcribed in `packages/core/src/schemas.ts` from the shipped
 * bundle — accepts a UUID's 36 characters unchanged. That is checked rather than assumed: the
 * value goes through `RunProjectKey`, whose `superRefine` rejects anything the SDK would silently
 * ignore, and R-01 §7 records that silently ignoring it collapses two tenants onto one session key
 * namespace. So a workspace id that ever stopped matching would fail the run instead of quietly
 * sharing a namespace.
 *
 * **There is no `configDir` here any more** (ENG-04b, #325). It was `${cwd}/.claude` — one engine's
 * directory name, chosen by a control plane that may not import an engine adapter and therefore had
 * no way to ask. The engine's own adapter derives it now
 * (`packages/engine-claude-agent-sdk/src/scope.ts`), from the same `cwd`, to the same string.
 */
export function sandboxFor(
  workspaceId: string,
  sessionId: string,
  settings: RuntimeSettings,
): { cwd: string; projectKey: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(sessionId)) {
    throw new Error(`session ${JSON.stringify(sessionId)} is not safe to use as a path segment`);
  }
  return { cwd: `${settings.workspaceRoot}/${workspaceId}/${sessionId}`, projectKey: workspaceId };
}

/**
 * C17's run-time half: refuse a run whose tool connectors would show the model a name over
 * {@link TOOL_NAME_MAX_LENGTH} characters, or the same name twice. `mcp__<key>__<operation>` is
 * every engine's worst case and fits by construction (16 + 41); it is checked as a guard.
 */
export function assertToolNamesFit(
  pending: readonly PendingToolConnector[],
  engineId: string,
): void {
  // An engine the catalogue does not list shows the bare tool name, the strictest for collisions.
  const form = isEngineId(engineId) ? ENGINE_CATALOGUE[engineId].mcpToolName : 'tool';
  const seen = new Set<string>();
  for (const connector of pending) {
    for (const operation of connector.operationNames) {
      const name = mcpToolName(form, connector.key, operation);
      const worst = `mcp__${connector.key}__${operation}`;
      if (
        seen.has(name) ||
        name.length > TOOL_NAME_MAX_LENGTH ||
        worst.length > TOOL_NAME_MAX_LENGTH
      ) {
        throw new DomainError({
          category: 'validation',
          code: 'connector_tool_name_collision',
          publicMessage:
            `connector_tool_name_collision: the tool ${JSON.stringify(name)} of connector ` +
            `${connector.connectorId} collides with another connector's tool or is longer than ` +
            `${String(TOOL_NAME_MAX_LENGTH)} characters on engine ${engineId}`,
        });
      }
      seen.add(name);
    }
  }
}

/**
 * A run met with the deployment's policy ceiling (S2-04c, C14, ADR-0102 SD6): `met` is the stored
 * configuration (permissions after the stored arm's withholding, the stored limits, the engine and
 * the resolved `model`) narrowed by `meetPolicyCeiling`, and `refused` is what the meet cannot
 * narrow — by the contract only `engine:` and `model:` entries, which refuse the run. A `null`
 * ceiling meets to the input and refuses nothing. Tools are judged separately, once the loader has
 * named the run's connectors.
 */
export function meetRunCeiling(
  agent: Pick<AgentRecord, 'policy'>,
  permissions: AgentPermissions,
  model: string | null,
  ceiling: ProjectPolicy | null,
  subagentModels: readonly (string | null)[] = [],
): { readonly met: EffectivePolicyConfiguration; readonly refused: readonly PolicyWidening[] } {
  const met = meetPolicyCeiling(
    storedEffective({ permissions, policy: agent.policy }, model, []),
    ceiling,
  );
  const refused = [...policyWidenings(met, ceiling)];
  // A subagent's own model is judged like the parent's; its other switches only ever narrow.
  for (const subagentModel of subagentModels) {
    if (subagentModel === null) continue;
    for (const widening of policyWidenings({ ...met, model: subagentModel }, ceiling)) {
      if (widening.startsWith('model:') && !refused.includes(widening)) refused.push(widening);
    }
  }
  return { met, refused };
}

/** The switches the ceiling turned off: on after the withholding narrowing, off after the meet. */
function ceilingCapsFor(
  permissions: AgentPermissions,
  policy: AgentRecord['policy'],
  met: AgentPermissions,
): AgentPermissionKey[] {
  const narrowed = policyNarrowedPermissions(permissions, policy);
  return AGENT_PERMISSION_KEYS.filter((key) => narrowed[key] && !met[key]);
}

/** The sentence a `policy_cannot_widen` run refusal carries, naming each detail in C14 order. */
export function ceilingRefusalMessage(refused: readonly PolicyWidening[]): string {
  return (
    "the run asks for more than this deployment's policy ceiling allows: " +
    `${refused.join(', ')}. Choose an engine and a model the ceiling lists.`
  );
}

/**
 * The loaded resources without the connectors the ceiling's `tools` does not allow, decided by
 * `meetPolicyCeiling` over their names (C14: no copy of the rule). An MCP entry the loader named no
 * connector for is judged as the empty name, which no ceiling lists, so a `tools` ceiling drops it.
 */
function resourcesWithinCeiling(
  resources: AgentRunResourceSelection,
  met: EffectivePolicyConfiguration,
  ceiling: ProjectPolicy | null,
): AgentRunResourceSelection {
  if (ceiling === null) return resources;
  const names = resources.connectorNames ?? {};
  const nameOf = (key: string): string => names[key] ?? '';
  const pending = resources.toolConnectors ?? [];
  const kept = new Set(
    meetPolicyCeiling(
      {
        ...met,
        tools: [...Object.keys(resources.mcpServers).map(nameOf), ...pending.map((c) => c.name)],
      },
      ceiling,
    ).tools,
  );
  return {
    ...resources,
    mcpServers: Object.fromEntries(
      Object.entries(resources.mcpServers).filter(([key]) => kept.has(nameOf(key))),
    ),
    toolConnectors: pending.filter((connector) => kept.has(connector.name)),
  };
}

async function loadResourcesWithinCeiling(
  workspaceId: string,
  runAgent: RunAgent,
  permissions: AgentPermissions,
  met: EffectivePolicyConfiguration,
  resourceLoader: AgentRunResourceLoader | undefined,
  ceiling: ProjectPolicy | null,
  projectId: string | null,
): Promise<AgentRunResourceSelection> {
  return resourcesWithinCeiling(
    resourceLoader === undefined
      ? { files: [], skills: [], mcpServers: {} }
      : await resourceLoader.load(
          workspaceId,
          runAgent.assignments,
          projectId,
          met.permissions,
          ceilingCapsFor(permissions, runAgent.agent.policy, met.permissions),
        ),
    met,
    ceiling,
  );
}

/**
 * What a run's sandbox may be granted on the network (ADR-0117 decision 9, issue #785): the met
 * `unrestrictedNetwork` switch and the DNS names of the met remote (`http`/`sse`) connectors, which
 * the sandbox itself calls. It narrows exactly as {@link buildRunRequestFor} does — the stored arm's
 * withholding, then the ceiling's meet, then the connectors the ceiling allows — so a switch the
 * ceiling turned off lowers the network too. IP-literal hosts are left out: the egress proxy
 * allowlist holds names only (ADR-0117 decision 3).
 */
export async function runNetworkGrant(
  context: LaunchContext,
  runAgent: RunAgent,
  resourceLoader: AgentRunResourceLoader | undefined,
  ceiling: ProjectPolicy | null,
  projectId: string | null,
): Promise<{ readonly unrestrictedNetwork: boolean; readonly connectorHosts: readonly string[] }> {
  const permissions = context.permissionOverride ?? runAgent.agent.permissions;
  const { met } = meetRunCeiling(runAgent.agent, permissions, null, ceiling);
  const resources = await loadResourcesWithinCeiling(
    context.principal.workspaceId,
    runAgent,
    permissions,
    met,
    resourceLoader,
    ceiling,
    projectId,
  );
  const hosts: string[] = [];
  for (const server of Object.values(resources.mcpServers)) {
    if (!('url' in server) || !URL.canParse(server.url)) continue;
    const host = new URL(server.url).hostname;
    if (isIP(host.replace(/^\[|\]$/g, '')) === 0) hosts.push(host);
  }
  return { unrestrictedNetwork: met.permissions.unrestrictedNetwork, connectorHosts: hosts };
}

/**
 * The run's MCP servers, with the tool host's connector (ADR-0115) told which run and agent call
 * it: the host reads `x-aw-run-id` and `x-aw-agent` into each code tool's context. The agent name
 * is percent-encoded, because a header value must be a ByteString and a name may be any Unicode.
 *
 * With `sandbox` (ADR-0118 TS3) the connector's entry is replaced by the gateway's tool sandbox
 * route and the run token: the agent sandbox never holds the tool host's own credential, and the
 * connector's stored URL, a reserved placeholder there, is never dialled.
 */
export function withToolHostRunHeaders(
  resources: AgentRunResourceSelection,
  runId: string,
  agent: string,
  sandbox?: { readonly url: string; readonly token: string },
): AgentRunResourceSelection['mcpServers'] {
  const names = resources.connectorNames ?? {};
  const agentHeader = encodeURIComponent(agent);
  return Object.fromEntries(
    Object.entries(resources.mcpServers).map(([key, server]) => {
      if (names[key] !== AW_DEV_TOOLS_CONNECTOR || !('url' in server)) return [key, server];
      if (sandbox !== undefined) {
        return [
          key,
          {
            type: 'http' as const,
            url: sandbox.url,
            headers: { authorization: `Bearer ${sandbox.token}`, 'x-aw-agent': agentHeader },
          },
        ];
      }
      return [
        key,
        {
          ...server,
          headers: { ...server.headers, 'x-aw-run-id': runId, 'x-aw-agent': agentHeader },
        },
      ];
    }),
  );
}

/**
 * A run whose version pins code tools needs the tool host's connector among its servers, and a
 * sandbox to run them in when that connector is the deployment's reserved placeholder. Without
 * either the tools would silently not exist, so the run fails and names them instead (ADR-0118
 * TS8). A connector at a real tool host, such as `aw dev`'s loopback one, keeps the header path of
 * earlier pins (TS7).
 *
 * @returns whether the connector's entry is swapped for the gateway's tool sandbox route.
 */
function codeToolsServedBySandbox(
  runAgent: RunAgent,
  settings: RuntimeSettings,
  resources: AgentRunResourceSelection,
): boolean {
  const tools = runAgent.toolBundles.map((bundle) => bundle.tool).join(', ');
  const key = Object.entries(resources.connectorNames ?? {}).find(
    ([, name]) => name === AW_DEV_TOOLS_CONNECTOR,
  )?.[0];
  const server = key === undefined ? undefined : resources.mcpServers[key];
  if (server === undefined) {
    throw new DomainError({
      category: 'validation',
      code: 'code_tool_connector_missing',
      publicMessage: `code_tool_connector_missing: the code tools ${tools} are served through the connector ${AW_DEV_TOOLS_CONNECTOR}, which this run does not have (it may be disabled, or outside the deployment policy).`,
    });
  }
  if (settings.toolSandbox === true) return true;
  if ('url' in server && server.url === TOOL_SANDBOX_CONNECTOR_URL) {
    throw new DomainError({
      category: 'validation',
      code: 'code_tool_needs_host',
      publicMessage: `code_tool_needs_host: the code tools ${tools} need a tool sandbox, and this run's runtime has none (the operator enables it with AGENT_WORKSPACE_TOOL_HOST_IMAGE on the web and the runner).`,
    });
  }
  return false;
}

/**
 * Each tool connector as an `http` MCP server at the gateway (ADR-0113 SD2, C16). The run token is
 * its only credential; the connector's own credential never leaves the gateway.
 */
function toolMcpServersFor(
  pending: readonly PendingToolConnector[],
  gatewayBaseUrl: string,
  token: string,
): Record<string, { type: 'http'; url: string; headers: Record<string, string> }> {
  return Object.fromEntries(
    pending.map((connector) => [
      connector.key,
      {
        type: 'http' as const,
        url: `${gatewayBaseUrl}${gatewayToolPath(connector.connectorId)}`,
        headers: { authorization: `Bearer ${token}` },
      },
    ]),
  );
}

/**
 * Compose the §14.3 body for one launch. Throws — with a sentence naming the reason — rather than
 * returning a partial request.
 *
 * `RunRequest.parse` runs before anything is posted on purpose (only the tool snapshot follows it,
 * so an unparseable request records no tool set). The runner parses the same schema and
 * answers 400 when it fails, and a 400 discovered on the wire is a run that has already been
 * accepted with a 202 and a stream URL. Parsing here turns that into a named failure written to
 * the run record before anything is posted, which is what `launcher.ts`'s `buildRunRequest`
 * failure path exists for.
 *
 * `runAgent` is what the session runs (issue #612): the version it pinned when it started, or the
 * agent row and its assignments for a legacy session. The caller reads it, scoped to the workspace,
 * so this function composes exactly that configuration and never re-reads the row.
 *
 * The environment is assembled from A.11 instead of inherited from the web or runner process.
 * Its model credential is a fresh run-scoped token tied to the selected model connection; the
 * provider master key is resolved later, inside the gateway. Agent secrets are the only
 * variable-cardinality entries and are passed explicitly by the caller that resolved §23 grants.
 *
 * `resolvedModel` is issue #129's resolved `(connection, model)` pair, produced by
 * {@link resolveModelForRun} and passed in already-validated — this function does not call the
 * resolver itself, so it stays free of a `WorkspaceModelsStore`/`ModelDiscovery` dependency for
 * every existing caller that has no need of full-precedence resolution. When omitted, the
 * pre-#129 fallback applies: `context.modelOverride`, then the agent's own stored default.
 *
 * `projectId` is issue #125's addition: the session's project, if any, passed straight to
 * `resourceLoader.load` alongside the agent's own permissions so a project's file/connector
 * associations can be composed in, capped by the agent's own tool permissions (never widened).
 * `null`/omitted means this session has no project, which is exactly how every pre-#125 caller
 * behaves today — see `ProjectResourceReader` on `./resource-loader.js`.
 *
 * `snapshotTools` records the run's tool connector set (C16) after the run token is issued and
 * before the request is returned for posting; the gateway authorises a tool call against it. A run
 * with tool connectors and no sink is refused, because the gateway would refuse every call.
 *
 * `ceiling` is the deployment's policy ceiling (`AW_DEPLOYMENT_POLICY`, S2-04c). The narrowing
 * steps run in this order: the stored arm's withholding (`policyNarrowedPermissions`), then the
 * ceiling's meet ({@link meetRunCeiling}) — which refuses an engine or a resolved model outside
 * the ceiling with `policy_cannot_widen` before any connector is read or any token is minted —
 * then the resource loader capped by the met permissions (#125), then the meet over the loaded
 * connectors' names, then `gateway.issue`, the tool entries and the snapshot, so the snapshot
 * records only the met tool set (C16). The met limits replace the stored ones. The meet only turns
 * permissions off and never touches the stored arm or the grant denials, so the adapter's deny list
 * keeps its documented order. `null` changes nothing.
 */
export async function buildRunRequestFor(
  context: LaunchContext,
  runAgent: RunAgent,
  settings: RuntimeSettings,
  gateway: RunTokenIssuer,
  agentSecrets: Readonly<Record<string, string>> = {},
  permissionOverride: AgentPermissions | undefined = undefined,
  projectInstructions: string | null = null,
  resourceLoader: AgentRunResourceLoader | undefined = undefined,
  resolvedModel: ModelSelection | undefined = undefined,
  projectId: string | null = null,
  // ENG-04 (#303): the provider `resolveModelForRun` resolved this run's connection to. Optional
  // because the pre-ENG-04 callers that do not resolve a model cannot supply one; when it is
  // absent the protocol check has nothing to check and the request is composed on the
  // gateway-native dialect, which is what every run uses today.
  modelProvider: ModelProvider | undefined = undefined,
  snapshotTools: RunToolSnapshot | undefined = undefined,
  ceiling: ProjectPolicy | null = null,
): Promise<RunRequest> {
  const workspaceId = context.principal.workspaceId;
  const { agent } = runAgent;
  const modelConnectionId =
    resolvedModel?.connectionId ??
    context.modelOverride?.connectionId ??
    context.modelConnectionId ??
    agent.modelConnectionId;
  if (modelConnectionId === null) {
    throw new Error(
      `agent ${agent.id} has no model connection; a run-scoped gateway token cannot be resolved`,
    );
  }
  // `context.modelConnectionId` (pre-#129) never carries a model of its own — only the newer
  // `resolvedModel`/`context.modelOverride` pairs do.
  const model = resolvedModel?.model ?? context.modelOverride?.model ?? agent.model;
  // The same resolution `agentConfigFor` applies below: a run-level override only ever narrows
  // the stored agent permissions (`LaunchContext.permissionOverride`'s own doc comment), so it —
  // not the wider stored value — is issue #125's ceiling for a project's resources on THIS run.
  // ADR-0074 D12: an `openai-agents` arm's `withheldPermissions` narrows this ceiling too, the same
  // way `portableAgentConfigFor` narrows the portable statement below — otherwise a withheld
  // `unrestrictedNetwork`/`readFiles` would still load a project's connectors/files. The deployment
  // ceiling's meet (S2-04c) narrows it once more, so a capped switch caps project resources too.
  const { met, refused } = meetRunCeiling(
    agent,
    permissionOverride ?? agent.permissions,
    model,
    ceiling,
    runAgent.subagents.map((sub) => sub.model),
  );
  if (refused.length > 0) {
    // Built here rather than through `runStartRefusalError`, which would import this module back.
    throw new DomainError({
      category: 'validation',
      code: 'policy_cannot_widen',
      publicMessage: `policy_cannot_widen: ${ceilingRefusalMessage(refused)}`,
    });
  }
  const resources = await atStep('resources', () =>
    loadResourcesWithinCeiling(
      workspaceId,
      runAgent,
      permissionOverride ?? agent.permissions,
      met,
      resourceLoader,
      ceiling,
      projectId,
    ),
  );
  // Before a token is issued: a run that cannot serve its code tools never gets one.
  const sandboxed =
    runAgent.toolBundles.length > 0 && codeToolsServedBySandbox(runAgent, settings, resources);
  const token = await atStep('token', () =>
    gateway.issue({
      runId: context.run.id,
      sessionId: context.session.id,
      workspaceId,
      agentId: agent.id,
      modelConnectionId,
    }),
  );
  const { cwd, projectKey } = sandboxFor(workspaceId, context.session.id, settings);

  // ENG-04's protocol check, and it is a *refusal*, not a narrowing (ADR-0065 D3): an engine that
  // speaks no dialect the gateway serves for this connection's provider cannot reach its model at
  // all, so composing the run anyway would buy a failure at the first model call, minutes later,
  // carrying a provider error instead of this sentence. The engine's capability check (ENG-02)
  // already happened at save time; this is the half that depends on which *connection* the run
  // resolved to, which is only known here.
  const engineId = engineFor(agent);
  const wireProtocol = wireProtocolFor(engineId, modelProvider);

  const pendingTools = resources.toolConnectors ?? [];
  assertToolNamesFit(pendingTools, engineId);
  // After the MCP connectors, so their keys and order are unchanged. An MCP connector whose name
  // is a SD13 key of this run was keyed `connector-<id>` by the loader, so the two cannot collide.
  const composedResources: AgentRunResourceSelection = {
    ...resources,
    mcpServers: {
      ...withToolHostRunHeaders(
        resources,
        context.run.id,
        agent.name,
        sandboxed
          ? { url: `${gateway.baseUrl}${GATEWAY_TOOL_SANDBOX_ROUTE.path}`, token }
          : undefined,
      ),
      ...toolMcpServersFor(pendingTools, gateway.baseUrl, token),
    },
  };

  const request = RunRequest.parse({
    runId: context.run.id,
    sessionId: context.session.id,
    cwd,
    prompt: context.prompt,
    engine: engineId,
    projectKey,
    // `met.permissions` is already narrowed by the stored arm; narrowing it again is idempotent.
    portable: {
      ...portableAgentConfigFor(
        agent,
        met.permissions,
        projectInstructions,
        composedResources,
        model,
        runAgent.subagents,
      ),
      limits: met.limits,
    },
    // The engine-native arm, forwarded rather than computed (ENG-04b). Everything that used to be
    // derived here — the Claude tool names a permission switch removes, the `mcp__<server>__*`
    // approvals an assigned connector earns — is compiled by the engine's own adapter now.
    policy: enginePolicyArmFor(agent, cwd, resources),
    session: context.session.resume
      ? { kind: 'resume', resume: context.session.id }
      : { kind: 'fresh', sessionId: context.session.id },
    // The gateway connection, as a field rather than as two environment variables named after
    // one engine's CLI (ENG-04). The variables below are *still* set, because the Claude Agent
    // SDK's bundled CLI reads its credential out of its environment and this unit is
    // behaviour-preserving for that engine; a later unit removes them once the adapter derives
    // them from this field alone. `packages/core/src/schemas.ts`'s `RunGatewayConnection`
    // records why the field exists at all.
    gateway: { baseUrl: gateway.baseUrl, token, protocol: wireProtocol },
    env: {
      ...agentSecrets,
      ANTHROPIC_BASE_URL: gateway.baseUrl,
      ANTHROPIC_AUTH_TOKEN: token,
      // The same signed, registered per-run claim authenticates transcript mirroring. It is
      // bound to workspace/run/session and contains no provider credential.
      AW_SESSION_MIRROR_TOKEN: token,
      NODE_USE_ENV_PROXY: '1',
    },
    resources: { files: resources.files, skills: resources.skills },
  });
  if (pendingTools.length > 0) {
    if (snapshotTools === undefined) {
      throw new Error('this run has tool connectors, but no tool snapshot is configured');
    }
    await snapshotTools(
      context.run.id,
      pendingTools.map((connector) => connector.connectorId),
    );
  }
  return request;
}

/**
 * The engine this agent runs on: the one its stored policy names, or the default.
 *
 * Read off the policy rather than off a column, because that is where ENG-02 put it — the policy
 * is discriminated by engine id, so an agent with no stored policy is on the engine
 * `compiledPolicyFor` answers with, which is the same default `apps/web/server/engines/session-engine.ts`
 * publishes and `packages/core`'s `DEFAULT_RUN_ENGINE` carries onto the wire.
 */
function engineFor(agent: AgentRecord): string {
  return agent.policy?.engine ?? DEFAULT_RUN_ENGINE;
}

/**
 * Resolve the wire protocol for this run, or throw the typed `engine_model_protocol_unsupported`
 * refusal.
 *
 * Throws rather than returning a verdict because every other refusal in this function does:
 * `buildRunRequestFor`'s own contract is *"throws — with a sentence naming the reason — rather
 * than returning a partial request"*.
 *
 * The throw is a {@link DomainError}, not a bare `Error`, and that is what makes the refusal
 * reach a human. The launcher turns anything thrown while preparing a run into the run's public
 * failure through `publicRunFailure` (`../runs/failures.ts`), which keeps a `DomainError`'s
 * `publicMessage` and replaces every other error with a generic sentence. So the run is
 * recorded `failed` with an error that starts with the problem code and continues with the
 * resolver's sentence — the engine, the dialects the gateway serves for this provider, and what
 * to change — which is what the run API and the UI show.
 *
 * This is decided while the run is being composed, **after** its row exists, and not as an HTTP
 * `422` on the run-create route: the model connection is resolved here (`resolveModelForRun`,
 * which may call provider discovery), and the protocol check depends on which connection the
 * run resolved to. ENG-04's PR records that as a deviation from the issue's "`422` before a run
 * row exists"; `ENGINE_PROBLEM_CODES` keeps the status a future route-level check would answer.
 *
 * An unregistered engine is **not** decided here. `apps/web/server/agents/policy.ts` refuses one
 * at save time with `400 unsupported_engine`, and a descriptor this deployment has since stopped
 * registering is a deployment change rather than a request problem; composing on the
 * gateway-native dialect keeps that run working exactly as it did before this check existed,
 * which is the behaviour-preserving direction for a check whose job is to catch a *mismatch*.
 */
export function wireProtocolFor(engineId: string, provider: ModelProvider | undefined): string {
  if (provider === undefined) return 'anthropic-messages';
  const descriptor = registeredEngine(engineId);
  if (descriptor === null) return 'anthropic-messages';
  const resolution = resolveWireProtocol(engineId, descriptor.capabilities.wireProtocols, provider);
  if (!resolution.ok) {
    throw new DomainError({
      category: 'validation',
      code: 'engine_model_protocol_unsupported',
      publicMessage: `engine_model_protocol_unsupported: ${resolution.reason}`,
    });
  }
  return resolution.protocol;
}
