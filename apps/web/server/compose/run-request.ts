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
import { log } from '../telemetry/logger';
import { isIP } from 'node:net';

import {
  RunRequest,
  type AgentPermissions,
  type PortableAgentConfig,
} from '@agent-workspace/run-protocol';

import { claudeReadOnlyGrantDenials, engineSettingsOf } from '@indx-workspace/contracts/agents';
import { isWithholdingEngine } from '@indx-workspace/contracts/engines';
import {
  meetPolicyCeiling,
  policyWidenings,
  type EffectivePolicyConfiguration,
  type PolicyWidening,
  type ProjectPolicy,
} from '@indx-workspace/contracts/policy-ceiling';
import { GATEWAY_TOOL_SANDBOX_ROUTE } from '@indx-workspace/contracts/tool-connectors';

import { policyNarrowedPermissions } from '../../contracts/agents';
import { DomainError } from '../errors';
import { narrowFileGrants } from '../files/search-terms';
import { atStep } from '../runs/failures';
import { storedEffective } from '../policy-ceiling/ceiling';
import type { AgentRecord } from '../agents/contract';
import type { RunAgent, RunSubagent } from '../agent-versions/session-version';
import type { ModelProvider } from '@indx-workspace/contracts/runs';

import type { ModelDiscovery } from '../models/discovery';
import { selectPreferredModel } from '../models/preferred-model';
import type { WorkspaceModelsStore } from '../models/store';
import type { RunTokenIssuer } from '../gateway/issuer';
import { runCallerOf } from '../runs/caller';
import type { LaunchContext, ModelSelection } from '../runs/environment';
import {
  assertRunFilesFit,
  loadAttachedFiles,
  withAttachedFiles,
  type AgentRunResourceLoader,
  type AgentRunResourceSelection,
} from './resource-loader';
import { ceilingRefusalMessage, loadResourcesWithinCeiling } from './run-request-ceiling';
import { engineFor, wireProtocolFor } from './run-request-engine';
import {
  NO_DEFAULT_CONNECTION_REASON,
  SELECTION_LAYERS,
  readyConnectionFor,
  validateModel,
  type ModelResolution,
  type ModelResolutionLayers,
} from './run-request-model-resolution';
import type { RuntimeSettings } from './run-request-runtime-settings';
import {
  assertCallerForIdentity,
  assertMayReachAwControl,
  awControlServerFor,
  assertToolNamesFit,
  codeToolsServedBySandbox,
  toolMcpServersFor,
  withIdentityHeaders,
  withRunConnectorKeys,
  withToolHostRunHeaders,
} from './run-request-tool-connectors';

export { ceilingRefusalMessage } from './run-request-ceiling';
export {
  DEFAULT_MODEL_CONNECTION_NAME,
  NO_DEFAULT_CONNECTION_REASON,
  connectionSubject,
  modelUnavailableReason,
  type DeploymentLayer,
  type ModelResolution,
  type ModelResolutionLayers,
} from './run-request-model-resolution';
export {
  DEFAULT_WORKSPACE_ROOT,
  readRuntimeSettings,
  type RuntimeSettings,
} from './run-request-runtime-settings';
export { assertToolNamesFit, withToolHostRunHeaders } from './run-request-tool-connectors';

/** Records the run's tool connector ids before the request is posted (C16). Throws on failure. */
export type RunToolSnapshot = (runId: string, connectorIds: readonly string[]) => Promise<void>;

// `ModelSelection` itself lives on `../runs/environment` — `LaunchContext.modelOverride` needs it
// too, and that module has no reason to import this one back.
export type { ModelSelection } from '../runs/environment';

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
  warn: (message: string) => void = (message) => log.warn(message),
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
  resources: Pick<AgentRunResourceSelection, 'connectorKeys' | 'toolConnectors'> & {
    readonly files: GrantedFiles;
  },
  approvedToolCalls: readonly { readonly canonicalCall: string }[],
): unknown {
  const policy = agent.policy;
  // A withholding arm is its engine-native settings, verbatim: the adapter compiles its tools from
  // the portable permissions and enforces grants itself, and has no pre-ENG-04 image to be
  // defended for (ADR-0072 D5).
  if (policy !== null && isWithholdingEngine(policy.engine)) return engineSettingsOf(policy);
  // Every write operation of an openapi tool is implicitly `requireApproval` (ADR-0113 SD4); the
  // rules carry the run's own server keys, so they are added here rather than stored on the policy.
  const requireApproval = [
    ...new Set([
      ...(policy !== null && 'tools' in policy ? (policy.requireApproval ?? []) : []),
      ...(resources.toolConnectors ?? []).flatMap((connector) => connector.approvalRules ?? []),
    ]),
  ];
  return {
    tools:
      policy !== null && 'tools' in policy
        ? withRunConnectorKeys(policy.tools, resources.connectorKeys ?? {})
        : null,
    fileGrantDeny: applyFileGrantPolicy(cwd, resources.files),
    // Left out when empty, so a run without a gate sends the arm an older runner image accepts.
    ...(requireApproval.length === 0 ? {} : { requireApproval }),
    ...(policy !== null && 'tools' in policy && policy.handoff === true ? { handoff: true } : {}),
    ...(approvedToolCalls.length === 0
      ? {}
      : { approvedToolCalls: approvedToolCalls.map((call) => call.canonicalCall) }),
  };
}

/** One granted path: what the read-only denials and the runner's materialisation need to know. */
interface GrantedPath {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly access: 'read' | 'read-write';
}

type GrantedFiles = AgentRunResourceSelection['files'] | readonly GrantedPath[];

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
export function applyFileGrantPolicy(cwd: string, files: GrantedFiles): readonly string[] {
  return claudeReadOnlyGrantDenials(
    cwd,
    files.filter((file) => file.access === 'read'),
  );
}

/**
 * The sandbox root and tenant namespace for one workspace.
 *
 * `projectKey` is the workspace id, and the SDK's own validator for `CLAUDE_CODE_PROJECT_DIR_NAME`
 * — `/^[A-Za-z0-9_-]{1,64}$/`, transcribed in `packages/run-protocol/src/schemas.ts` from the shipped
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

const lowest = (resolved: number | null, cap: number | undefined): number | null =>
  cap === undefined ? resolved : resolved === null ? cap : Math.min(resolved, cap);

/** The met limits under one run's override: the lower of each, so an override never raises a limit. */
export function lowerLimits(
  limits: PortableAgentConfig['limits'],
  override: LaunchContext['limits'],
): PortableAgentConfig['limits'] {
  return {
    maxTurns: lowest(limits.maxTurns, override?.maxTurns),
    maxBudgetUsd: lowest(limits.maxBudgetUsd, override?.maxBudgetUsd),
  };
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
  const resources = await runResourcesWithinCeiling(
    context,
    runAgent,
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
 * The run's resources as {@link buildRunRequestFor} loads them — the session's assignments, the
 * project's (issue #125), capped by the met permissions and the ceiling — for a caller that runs
 * before compose: the network grant, and the input archive, whose files must be the ones the
 * `/run` body references.
 */
export async function runResourcesWithinCeiling(
  context: Pick<LaunchContext, 'permissionOverride'> & {
    readonly principal: Pick<LaunchContext['principal'], 'workspaceId'>;
  },
  runAgent: RunAgent,
  resourceLoader: AgentRunResourceLoader | undefined,
  ceiling: ProjectPolicy | null,
  projectId: string | null,
): Promise<AgentRunResourceSelection> {
  const permissions = context.permissionOverride ?? runAgent.agent.permissions;
  const { met } = meetRunCeiling(runAgent.agent, permissions, null, ceiling);
  return loadResourcesWithinCeiling(
    context.principal.workspaceId,
    runAgent,
    permissions,
    met,
    resourceLoader,
    ceiling,
    projectId,
  );
}

/**
 * The loaded resources with `files` narrowed to the run's `fileScope` (ADR-0147, issue #1539), or
 * unchanged when the run has none. A scope path outside the agent's effective grants (after the
 * readFiles switch and the ceiling) refuses the run, built here as `policy_cannot_widen` is.
 */
export function narrowedToFileScope<R extends { readonly files: readonly GrantedPath[] }>(
  resources: R,
  fileScope: readonly string[] | undefined,
): R {
  if (fileScope === undefined) return resources;
  const { kept, widens } = narrowFileGrants(resources.files, fileScope);
  if (widens.length > 0) {
    throw new DomainError({
      category: 'validation',
      code: 'run_file_scope_not_granted',
      // Names no path: which ones failed would tell the caller what lies inside the grants.
      publicMessage:
        "run_file_scope_not_granted: fileScope names a path this run cannot narrow to. The scope can only narrow the agent's file grants.",
    });
  }
  return { ...resources, files: kept };
}

/**
 * The `/run` body's `resources.files`: the run's grants, already narrowed by
 * {@link narrowedToFileScope}, with its attachments after them. Exported so the delivery tests'
 * runner double receives the body this composes.
 */
export async function attachedRunFiles(
  context: LaunchContext,
  resources: Pick<AgentRunResourceSelection, 'files' | 'skills'>,
  resourceLoader: AgentRunResourceLoader | undefined,
): Promise<AgentRunResourceSelection['files']> {
  // Each attachment is also a `read` reference in `resources.files`, so the runner checks it like
  // any grant; its bytes arrive in the input archive.
  // @story US-STO-11
  const attached = await atStep('resources', () =>
    loadAttachedFiles(resourceLoader, context.principal.workspaceId, context.attachments ?? []),
  );
  const runFiles = withAttachedFiles(resources.files, attached.files);
  // The total after the scope narrowed the grants and the attachments joined them; the input
  // archive judged the same total before the sandbox, so this is the backstop.
  // @story US-STO-06
  assertRunFilesFit(runFiles, resources.skills);
  return runFiles;
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
  const loaded = await atStep('resources', () =>
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
  const resources = narrowedToFileScope(loaded, context.fileScope);
  const caller = runCallerOf(context.principal, context.subject);
  // Before a token is issued: a run that reaches the reserved `aw-control` name, then one that
  // reaches a connector wanting an identity it has none for.
  assertMayReachAwControl(resources);
  assertCallerForIdentity(resources, caller);
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
      ...(caller === null ? {} : { caller }),
      // The gateway ends the run at its next model call once the workspace's spend reaches this.
      ...(ceiling?.maxCostPerDayUsd === undefined
        ? {}
        : { dailyCostCapUsd: ceiling.maxCostPerDayUsd }),
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
      ...(await withIdentityHeaders(
        withToolHostRunHeaders(
          resources,
          context.run.id,
          agent.name,
          sandboxed
            ? { url: `${gateway.baseUrl}${GATEWAY_TOOL_SANDBOX_ROUTE.path}`, token }
            : undefined,
        ),
        resources.connectorIdentities,
        caller,
        workspaceId,
        context.run.id,
      )),
      ...toolMcpServersFor(pendingTools, gateway.baseUrl, token),
      ...awControlServerFor(agent, ceiling, gateway.baseUrl, token),
    },
  };

  // ADR-0146 Decisions 2 and 3: an attachment is a read-only grant whose bytes never ride in this
  // request (the runner's `POST /files` hydrate writes them), so the shell removal a read grant
  // causes is applied here instead, for every engine.
  const attachments = context.attachments ?? [];
  const attachmentGrants: readonly GrantedPath[] = attachments.map(({ path, kind }) => ({
    path,
    kind,
    access: 'read',
  }));
  const portablePermissions =
    attachments.length === 0 ? met.permissions : { ...met.permissions, runCommands: false };
  const runFiles = await attachedRunFiles(context, resources, resourceLoader);

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
        portablePermissions,
        projectInstructions,
        composedResources,
        model,
        runAgent.subagents,
      ),
      limits: lowerLimits(met.limits, context.limits),
    },
    // The engine-native arm, forwarded rather than computed (ENG-04b). Everything that used to be
    // derived here — the Claude tool names a permission switch removes, the `mcp__<server>__*`
    // approvals an assigned connector earns — is compiled by the engine's own adapter now.
    policy: enginePolicyArmFor(
      agent,
      cwd,
      { ...resources, files: [...resources.files, ...attachmentGrants] },
      context.run.approvedToolCalls ?? [],
    ),
    session: context.session.resume
      ? { kind: 'resume', resume: context.session.id }
      : { kind: 'fresh', sessionId: context.session.id },
    // The gateway connection, as a field rather than as two environment variables named after
    // one engine's CLI (ENG-04). The variables below are *still* set, because the Claude Agent
    // SDK's bundled CLI reads its credential out of its environment and this unit is
    // behaviour-preserving for that engine; a later unit removes them once the adapter derives
    // them from this field alone. `packages/run-protocol/src/schemas.ts`'s `RunGatewayConnection`
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
    resources: {
      files: runFiles,
      skills: resources.skills,
    },
    ...(context.outputSchema === undefined ? {} : { outputSchema: context.outputSchema }),
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
