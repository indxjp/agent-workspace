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

import { RunRequest, type AgentPermissions } from '@agent-workspace/run-protocol';

import type {
  EffectivePolicyConfiguration,
  ProjectPolicy,
} from '@indx-workspace/contracts/policy-ceiling';

import { atStep } from '../runs/failures';
import type { AgentRecord } from '../agents/contract';
import type { RunAgent } from '../agent-versions/session-version';
import type { ModelProvider } from '@indx-workspace/contracts/runs';

import type { ModelDiscovery, RunTokenIssuer, WorkspaceModelsStore } from '../integrations';
import { type LaunchContext, type ModelSelection, type RunCaller, runCallerOf } from '../execution';
import type {
  AgentRunResourceLoader,
  AgentRunResourceSelection,
  PendingToolConnector,
} from './resource-loader';
import {
  attachmentGrantsFor as attachmentGrantsOf,
  portablePermissionsFor as portablePermissionsOf,
  runEnvironment,
  runModelFor as chooseRunModel,
  sandboxFor as sandboxPathsFor,
} from './core/run-request';
import { assertWithinCeiling, loadResourcesWithinCeiling } from './run-request-ceiling';
import { enginePolicyArmFor, engineFor, wireProtocolFor } from './run-request-engine';
import {
  SELECTION_LAYERS,
  readyConnectionFor,
  resolveDeploymentDefault,
  validateModel,
  type ModelResolution,
  type ModelResolutionLayers,
} from './run-request-model-resolution';
import { portableAgentConfigFor } from './run-request-portable';
import {
  attachedRunFiles,
  narrowedToFileScope,
  runLimitsFor,
  type GrantedPath,
} from './run-request-resources';
import type { RuntimeSettings } from './run-request-runtime-settings';
import {
  assertCallerForIdentity,
  assertMayReachAwControl,
  assertToolNamesFit,
  codeToolsServedBySandbox,
  composeRunMcpServers,
} from './run-request-tool-connectors';

export { ceilingRefusalMessage, meetRunCeiling } from './run-request-ceiling';
export { applyFileGrantPolicy } from './run-request-engine';
export { portableAgentConfigFor } from './run-request-portable';
export {
  attachedRunFiles,
  launchLimits,
  lowerLimits,
  narrowedToFileScope,
  runNetworkGrant,
  runResourcesWithinCeiling,
} from './run-request-resources';
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
export {
  assertToolNamesFit,
  withToolHostRunHeaders,
  type RunTeamMembers,
} from './run-request-tool-connectors';

/** Records the run's tool connector ids before the request is posted (C16). Throws on failure. */
export type RunToolSnapshot = (runId: string, connectorIds: readonly string[]) => Promise<void>;

// `ModelSelection` itself lives on `../runs/environment` — `LaunchContext.modelOverride` needs it
// too, and that module has no reason to import this one back.
export type { ModelSelection } from '../execution';

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

  if (layers.deployment !== null) {
    return resolveDeploymentDefault(layers.deployment, store, discover, warn);
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
  return sandboxPathsFor(settings.workspaceRoot, workspaceId, sessionId);
}

/**
 * What {@link buildRunRequestFor} composes one launch from. Every optional field defaults as its
 * doc there says: `agentSecrets` to none, `projectInstructions`, `projectId` and `ceiling` to
 * `null`, the rest to absent.
 */
export interface BuildRunRequestInput {
  readonly context: LaunchContext;
  readonly runAgent: RunAgent;
  readonly settings: RuntimeSettings;
  readonly gateway: RunTokenIssuer;
  readonly agentSecrets?: Readonly<Record<string, string>> | undefined;
  readonly permissionOverride?: AgentPermissions | undefined;
  readonly projectInstructions?: string | null | undefined;
  readonly resourceLoader?: AgentRunResourceLoader | undefined;
  readonly resolvedModel?: ModelSelection | undefined;
  readonly projectId?: string | null | undefined;
  /**
   * ENG-04 (#303): the provider `resolveModelForRun` resolved this run's connection to. Optional
   * because the pre-ENG-04 callers that do not resolve a model cannot supply one; when it is
   * absent the protocol check has nothing to check and the request is composed on the
   * gateway-native dialect, which is what every run uses today.
   */
  readonly modelProvider?: ModelProvider | undefined;
  readonly snapshotTools?: RunToolSnapshot | undefined;
  readonly ceiling?: ProjectPolicy | null | undefined;
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
export async function buildRunRequestFor(input: BuildRunRequestInput): Promise<RunRequest> {
  const { context, runAgent, settings, gateway, resourceLoader, ceiling = null } = input;
  const workspaceId = context.principal.workspaceId;
  const { agent } = runAgent;
  const { modelConnectionId, model } = runModelFor(context, agent, input.resolvedModel);
  // The same resolution `agentConfigFor` applies below: a run-level override only ever narrows
  // the stored agent permissions (`LaunchContext.permissionOverride`'s own doc comment), so it —
  // not the wider stored value — is issue #125's ceiling for a project's resources on THIS run.
  // ADR-0074 D12: an `openai-agents` arm's `withheldPermissions` narrows this ceiling too, the same
  // way `portableAgentConfigFor` narrows the portable statement below — otherwise a withheld
  // `unrestrictedNetwork`/`readFiles` would still load a project's connectors/files. The deployment
  // ceiling's meet (S2-04c) narrows it once more, so a capped switch caps project resources too.
  const permissions = input.permissionOverride ?? agent.permissions;
  const met = assertWithinCeiling(runAgent, permissions, model, ceiling);
  const resources = await loadRunResources(input, permissions, met);
  const caller = runCallerOf(context.principal, context.subject);
  // Before a token is issued: a run that reaches the reserved `aw-control` name, then one that
  // reaches a connector wanting an identity it has none for.
  assertMayReachAwControl(resources);
  assertCallerForIdentity(resources, caller);
  // Before a token is issued: a run that cannot serve its code tools never gets one.
  const sandboxed =
    runAgent.toolBundles.length > 0 && codeToolsServedBySandbox(runAgent, settings, resources);
  const token = await issueRunToken(input, modelConnectionId, caller);
  const { cwd, projectKey } = sandboxFor(workspaceId, context.session.id, settings);

  // ENG-04's protocol check, and it is a *refusal*, not a narrowing (ADR-0065 D3): an engine that
  // speaks no dialect the gateway serves for this connection's provider cannot reach its model at
  // all, so composing the run anyway would buy a failure at the first model call, minutes later,
  // carrying a provider error instead of this sentence. The engine's capability check (ENG-02)
  // already happened at save time; this is the half that depends on which *connection* the run
  // resolved to, which is only known here.
  const engineId = engineFor(agent);
  const wireProtocol = wireProtocolFor(engineId, input.modelProvider);

  const pendingTools = resources.toolConnectors ?? [];
  assertToolNamesFit(pendingTools, engineId);
  const runResources = await composeRunMcpServers({
    context,
    agent,
    resources,
    caller,
    workspaceId,
    sandboxed,
    engineId,
    gatewayBaseUrl: gateway.baseUrl,
    token,
    ceiling,
  });
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
      ...portableAgentConfigFor(agent, {
        permissionOverride: portablePermissionsFor(met.permissions, context),
        projectInstructions: input.projectInstructions ?? null,
        resources: runResources,
        model,
        subagents: runAgent.subagents,
      }),
      limits: runLimitsFor(met.limits, context),
    },
    // The engine-native arm, forwarded rather than computed (ENG-04b). Everything that used to be
    // derived here — the Claude tool names a permission switch removes, the `mcp__<server>__*`
    // approvals an assigned connector earns — is compiled by the engine's own adapter now.
    policy: enginePolicyArmFor(
      agent,
      cwd,
      { ...resources, files: [...resources.files, ...attachmentGrantsFor(context)] },
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
    env: runEnvironment(input.agentSecrets ?? {}, gateway.baseUrl, token),
    resources: { files: runFiles, skills: resources.skills },
    ...(context.outputSchema === undefined ? {} : { outputSchema: context.outputSchema }),
  });
  await snapshotRunTools(context.run.id, pendingTools, input.snapshotTools);
  return request;
}

/**
 * The run's model connection and model: `resolvedModel`, then the context's override, then the
 * pre-#129 `context.modelConnectionId`, then the agent's own. A run with no connection cannot be
 * given a run-scoped gateway token, so it is refused here.
 */
function runModelFor(
  context: LaunchContext,
  agent: AgentRecord,
  resolvedModel: ModelSelection | undefined,
): { readonly modelConnectionId: string; readonly model: string | null } {
  return chooseRunModel({
    resolved: resolvedModel,
    override: context.modelOverride,
    legacyConnectionId: context.modelConnectionId,
    agent,
  });
}

/** The run's resources within the ceiling, narrowed to its file scope (#125, ADR-0147). */
async function loadRunResources(
  input: BuildRunRequestInput,
  permissions: AgentPermissions,
  met: EffectivePolicyConfiguration,
): Promise<AgentRunResourceSelection> {
  const { context, runAgent, resourceLoader, projectId = null, ceiling = null } = input;
  const loaded = await atStep('resources', () =>
    loadResourcesWithinCeiling(
      context.principal.workspaceId,
      runAgent,
      { permissions, met },
      { resourceLoader, ceiling, projectId },
    ),
  );
  return narrowedToFileScope(loaded, context.fileScope);
}

/** The run's gateway token, bound to its run, session, agent, connection and caller. */
function issueRunToken(
  input: BuildRunRequestInput,
  modelConnectionId: string,
  caller: RunCaller | null,
): Promise<string> {
  const { context, gateway, ceiling = null } = input;
  return atStep('token', () =>
    gateway.issue({
      runId: context.run.id,
      sessionId: context.session.id,
      workspaceId: context.principal.workspaceId,
      agentId: input.runAgent.agent.id,
      modelConnectionId,
      ...(caller === null ? {} : { caller }),
      // The gateway ends the run at its next model call once the workspace's spend reaches this.
      ...(ceiling?.maxCostPerDayUsd === undefined
        ? {}
        : { dailyCostCapUsd: ceiling.maxCostPerDayUsd }),
    }),
  );
}

// ADR-0146 Decisions 2 and 3: an attachment is a read-only grant whose bytes never ride in this
// request (the runner's `POST /files` hydrate writes them), so the shell removal a read grant
// causes is applied here instead, for every engine.

/** The run's attachments as read-only grants, for the engine arm's denials. */
function attachmentGrantsFor(context: LaunchContext): readonly GrantedPath[] {
  return attachmentGrantsOf(context.attachments ?? []);
}

/** The met permissions, without `runCommands` when the run carries an attachment. */
function portablePermissionsFor(met: AgentPermissions, context: LaunchContext): AgentPermissions {
  return portablePermissionsOf(met, (context.attachments ?? []).length);
}

/** Records the run's tool connectors (C16); a run with tool connectors and no sink is refused. */
async function snapshotRunTools(
  runId: string,
  pendingTools: readonly PendingToolConnector[],
  snapshotTools: RunToolSnapshot | undefined,
): Promise<void> {
  if (pendingTools.length === 0) return;
  if (snapshotTools === undefined) {
    throw new Error('this run has tool connectors, but no tool snapshot is configured');
  }
  await snapshotTools(
    runId,
    pendingTools.map((connector) => connector.connectorId),
  );
}
