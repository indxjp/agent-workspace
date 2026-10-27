/**
 * S-13: compile-or-read, validate and serialize an agent's policy — the logic behind
 * `GET`/`PUT /api/agents/:id/policy`, kept apart from `Request`/`Response` the way `handlers.ts`
 * keeps the other five agent operations apart from them.
 *
 * ## `GET`: the stored policy, or the compiled one
 *
 * `agent.policy` is `null` for every agent until a `PUT` writes one — see
 * `packages/core/src/db/schema/agents.ts`'s `AgentStoredPolicy`. A `null` column reads as the
 * *compiled* policy: the same `tools` the engine's adapter derives from the four permission
 * booleans, an allowlist of the agent's currently assigned and enabled skills, and no limit.
 * {@link compiledPolicyFor} is built from `packages/contracts`' `claudeBaseToolPolicyFor` — the
 * *same function* the adapter compiles from, not a re-derivation of it — so the two cannot drift.
 *
 * ## `PUT`: strictly narrowing, and only onto what is assigned
 *
 * A `PUT` may restrict an agent past its permission checkboxes but never widen it past them — the
 * engine's adapter (`packages/engine-claude-agent-sdk/src/tools.ts`) unions the permission-derived
 * and file-grant denials into whatever `tools.deny` this module stores, rather than replacing them,
 * so the narrowing is enforced at compile time as well as here. This module's own refusals are the
 * ones the wire contract cannot express by itself: an `engine` this deployment does not register
 * (`400 unsupported_engine` — the contracts publish the catalogue, but which of it a deployment
 * installs is {@link ../engines/registry.ts}'s answer), the pre-ADR-0065 `provider` discriminant
 * (`400 invalid_body`), an engine that is registered but cannot honour a connector or a skill this agent is assigned
 * (`422 engine_capability_unsupported` — ADR-0065 D3's "refuse, never ignore"; see
 * {@link engineCapabilityRefusal}), a `skills.mode: 'allowlist'` naming a
 * skill this agent has no assignment for (`409 skill_not_assigned` — assignment, not enablement,
 * is what is checked, since `PATCH /api/skills/:name` can re-enable a skill without touching the
 * assignment), and a parseable `permissionMode: 'bypassPermissions'` (`400
 * dangerous_permission_mode_refused` — R-01 §10 makes it the one mode requiring a dangerous flag,
 * and nothing on the site offers it as an authoring choice; see the implementation plan's open
 * question 6).
 *
 * ## An engine switch carries the narrowing across (ADR-0074 D12)
 *
 * A `PUT` that changes `engine` is translated against the stored arm by the contracts'
 * `translatePolicyForEngineSwitch` before anything else is decided: whatever the old arm withheld
 * — a `tools.deny` rule, a `base` list, a narrowing `permissionMode` — is written into the new
 * arm, and a denial the new arm cannot express is refused `422 engine_switch_would_widen`, naming
 * each rule. See {@link carryEngineSwitch}.
 */
import type { AgentResourceAssignments } from '@agent-workspace/core/db';
import {
  connectorServerKey,
  describeToolRule,
  toolRuleConnectorServer,
} from '@indx-workspace/contracts/tool-connectors';

import {
  AGENT_POLICY_PROBLEM_CODES,
  AgentPolicySchema,
  claudeBaseToolPolicyFor,
  translatePolicyForEngineSwitch,
  type AgentPolicy,
  type AgentPolicySource,
  type AgentPermissions,
} from '../../contracts/agents';
import {
  engineCapabilityRefusalMessage,
  unsupportedEngineCapability,
  type EngineCapabilityDemand,
} from '../engines/capabilities';
import { registeredEngine, registeredEngineIds } from '../engines/registry';
import { DEFAULT_ENGINE_ID } from '../engines/session-engine';
import { formatIssues, problem, type ApiResult } from '../http/result';
import type { AgentRecord } from './contract';
import type { AgentResourceStoreProvider } from './resource-store';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';

/**
 * The compiled `tools`/`skills`/`limits`, built from the same permission floor a run compiles.
 *
 * `claudeBaseToolPolicyFor` is `packages/contracts`', and its own doc comment explains why that
 * table lives there rather than in the Claude adapter (ENG-04b, #325): this route and the adapter
 * are the two callers, `apps/web` may never import an adapter, and two spellings of one security
 * decision is the drift this repository refuses. The engine that runs the agent reads the very same
 * function, so the policy this route serves and the policy a run compiles cannot disagree about the
 * floor.
 *
 * This is the **base** policy, not the effective one. The engine's adapter applies two further
 * layers when it compiles a run, and neither is visible here: an `mcp__<server>__*` auto-approval
 * for every connector assigned to the agent, and `Write(…)`/`Edit(…)`/`NotebookEdit(…)`/`Bash`
 * denials for every read-only file grant. So the `autoApprove` and `deny` this returns — and that
 * `GET /api/agents/:id/policy` therefore answers — are what a run starts from, never the full set it
 * ends up with. Deliberate: the route reports what is stored or configured, and the run-time layers
 * depend on resources loaded per run. The same caveat is written on `AgentPolicySchema`
 * (`packages/contracts/src/agents.ts`) and in `docs/sdk/site/building/agents.mdx`, so a client
 * reading either is not misled.
 */
export function compiledPolicyFor(
  permissions: AgentPermissions,
  assignedEnabledSkillNames: readonly string[],
): Extract<AgentPolicy, { engine: typeof DEFAULT_ENGINE_ID }> {
  const tools = claudeBaseToolPolicyFor(permissions);
  return {
    // The same constant a run reads for an agent with no stored policy, so the policy this route
    // serves and the engine that run records cannot disagree (ADR-0065).
    engine: DEFAULT_ENGINE_ID,
    tools: {
      base: tools.base,
      autoApprove: [...tools.autoApprove],
      deny: [...tools.deny],
      permissionMode: tools.permissionMode,
      allowDangerouslySkipPermissions: tools.allowDangerouslySkipPermissions,
    },
    skills: { mode: 'allowlist', names: [...assignedEnabledSkillNames] },
    limits: { maxTurns: null, maxBudgetUsd: null },
  };
}

/** The policy `GET` answers: the stored one, or the compiled one when the column is NULL. */
export function policyFor(
  agent: AgentRecord,
  assignedEnabledSkillNames: readonly string[],
): AgentPolicy {
  return agent.policy ?? compiledPolicyFor(agent.permissions, assignedEnabledSkillNames);
}

/**
 * Whether {@link policyFor} answers a stored policy or a compiled one — the `source` of
 * `AgentPolicyResponseSchema`. A client that copies the policy elsewhere (K-1 export, ADR-0076 D2)
 * needs it so a compiled policy is not frozen into a stored one.
 */
export function policySourceOf(agent: AgentRecord): AgentPolicySource {
  return agent.policy === null ? 'compiled' : 'stored';
}

/**
 * Every catalog skill an agent's assignment row names, by name — regardless of whether it is
 * currently enabled. Assignment, not enablement, is the membership a `PUT` is checked against (see
 * the file header); enablement narrows what {@link compiledPolicyFor} lists for a `GET`.
 *
 * It takes the row rather than reading it, so a caller that also asks {@link demandsConnectors}
 * decides both against one read of the assignments, not two that a concurrent
 * `PUT /api/agents/:id/resources` could land between.
 */
export async function assignedSkillNames(
  workspaceId: string,
  assigned: AgentResourceAssignments | null,
  catalog: ResourceCatalogStoreProvider,
): Promise<ReadonlySet<string>> {
  if (assigned === null || assigned.skillIds.length === 0) return new Set();
  const rows = await (await catalog.forWorkspace(workspaceId)).listSkills();
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  const names = new Set<string>();
  for (const id of assigned.skillIds) {
    const name = byId.get(id);
    if (name !== undefined) names.add(name);
  }
  return names;
}

/** The same, but only the assigned skills that are also enabled — what {@link compiledPolicyFor} lists. */
export async function assignedEnabledSkillNames(
  workspaceId: string,
  agentId: string,
  assignments: AgentResourceStoreProvider,
  catalog: ResourceCatalogStoreProvider,
): Promise<readonly string[]> {
  const assigned = await assignments.forWorkspace(workspaceId).get(agentId);
  if (assigned === null || assigned.skillIds.length === 0) return [];
  const rows = await (await catalog.forWorkspace(workspaceId)).listSkills();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const names: string[] = [];
  for (const id of assigned.skillIds) {
    const row = byId.get(id);
    if (row !== undefined && row.enabled) names.push(row.name);
  }
  return names;
}

export type ParsedPolicyBody =
  | { readonly ok: true; readonly policy: AgentPolicy }
  | { readonly ok: false; readonly result: ApiResult };

/** A plain JSON object: not null, not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a `PUT` body against {@link AgentPolicySchema}, refusing a dangerous permission mode
 * before anything is stored.
 *
 * Three refusals are told apart from the generic shape failure, because each names a different
 * thing the client can fix:
 *
 *   * `invalid_body` — the body carries the pre-ADR-0065 `provider` discriminant. `provider` means
 *     the *model* provider everywhere else on the wire, so it is refused by name rather than
 *     reported as "`engine` is missing", and never read as the new shape.
 *   * `unsupported_engine` — the body names an engine this deployment does not register. Fixable by
 *     naming one it does; `invalid_policy` would hide that behind a zod enum complaint.
 *   * `dangerous_permission_mode_refused` — see the file header.
 *
 * `registered` is the deployment's engine ids, defaulting to the installed registry's. It is a
 * parameter so the refusal can be proven against an engine that is *not* installed — while
 * `claude-agent-sdk` is the only engine the contracts publish, no body could otherwise reach the
 * second branch with a parseable `engine`.
 */
export function parsePolicyBody(
  raw: unknown,
  registered: readonly string[] = registeredEngineIds(),
): ParsedPolicyBody {
  if (isPlainObject(raw) && !('engine' in raw) && 'provider' in raw) {
    return {
      ok: false,
      result: problem(
        AGENT_POLICY_PROBLEM_CODES.invalid_body,
        'invalid_body',
        "The policy discriminant is 'engine', naming the harness that runs the agent loop. " +
          "'provider' names the model provider and is no longer accepted here (ADR-0065).",
      ),
    };
  }
  if (isPlainObject(raw) && 'engine' in raw) {
    const unsupported = unsupportedEngineRefusal(raw['engine'], registered);
    if (unsupported !== null) return { ok: false, result: unsupported };
  }
  const parsed = AgentPolicySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      result: problem(
        AGENT_POLICY_PROBLEM_CODES.invalid_policy,
        'invalid_policy',
        'The policy body does not match the published shape.',
        formatIssues(parsed.error.issues),
      ),
    };
  }
  const dangerous = dangerousPermissionModeRefusal(parsed.data);
  if (dangerous !== null) return { ok: false, result: dangerous };
  return { ok: true, policy: parsed.data };
}

/**
 * `400 unsupported_engine` when `engine` is not one of the `registered` engine ids, otherwise
 * `null`. One implementation shared by {@link parsePolicyBody} and the version pipeline
 * (`../agent-versions/pipeline.ts`, S1-05), so the policy route and a saved version refuse an
 * engine with the same code and message. `engine` is whatever the body carried, unparsed.
 *
 * `details` is passed through: the policy route has never sent any, and the version contract
 * documents `[<engine>]` (`AGENT_VERSION_PROBLEM_CODES.unsupported_engine`), so each caller keeps
 * its own published shape.
 */
export function unsupportedEngineRefusal(
  engine: unknown,
  registered: readonly string[],
  details?: readonly string[],
): ApiResult | null {
  if (registered.includes(String(engine))) return null;
  return problem(
    AGENT_POLICY_PROBLEM_CODES.unsupported_engine,
    'unsupported_engine',
    `This deployment registers the engines ${registered.map((id) => `'${id}'`).join(', ')}; received ${JSON.stringify(engine)}.`,
    details,
  );
}

/**
 * `400 dangerous_permission_mode_refused` when a parsed policy asks for
 * `permissionMode: 'bypassPermissions'` (see the file header), otherwise `null`. Shared by
 * {@link parsePolicyBody} and the version pipeline (S1-05).
 */
export function dangerousPermissionModeRefusal(policy: AgentPolicy): ApiResult | null {
  if (!('tools' in policy) || policy.tools.permissionMode !== 'bypassPermissions') {
    return null;
  }
  return problem(
    AGENT_POLICY_PROBLEM_CODES.dangerous_permission_mode_refused,
    'dangerous_permission_mode_refused',
    "permissionMode 'bypassPermissions' cannot be set through this route.",
  );
}

/** `null` when every allowlisted name is assigned; otherwise the first name that is not. */
export function firstUnassignedSkillName(
  policy: AgentPolicy,
  assigned: ReadonlySet<string>,
): string | null {
  if (policy.skills.mode !== 'allowlist') return null;
  for (const name of policy.skills.names) {
    if (!assigned.has(name)) return name;
  }
  return null;
}

/**
 * Whether the saved `policy` lets any of this agent's **assigned** skills reach its engine.
 *
 * The demand is about assignment, narrowed only by what is saved: `mode: 'all'` demands every
 * assigned skill, an allowlist demands the assigned ones it names, and an allowlist naming nothing
 * demands none and is therefore not refused. `null` is the NULL column a one-call create leaves
 * behind, which a run reads as `compiledPolicyFor`'s allowlist of the assigned skills enabled *at
 * that run* — so, like `mode: 'all'`, it demands every assigned skill.
 *
 * This is deliberately not the whole of `apps/web/server/compose/run-request.ts`'s `agentConfigFor`
 * narrowing: a run also drops **disabled** skills and connectors
 * (`apps/web/server/compose/resource-loader.ts`), and this check does not. Enablement is flipped by
 * `PATCH /api/skills/:name` and the connector routes, which never pass through a save of the agent,
 * so a check that trusted today's enablement would let an agent be saved and then hand its engine
 * a skill it cannot honour the moment one is re-enabled — the silent drop ADR-0065 D3 forbids. The
 * same reason makes assignment, not enablement, what `skill_not_assigned` checks (the file header).
 *
 * `assigned` is read for its emptiness under `null` and `mode: 'all'`, and for membership by name
 * under an allowlist.
 */
export function demandsSkills(policy: AgentPolicy | null, assigned: ReadonlySet<string>): boolean {
  if (policy === null || policy.skills.mode === 'all') return assigned.size > 0;
  return policy.skills.names.some((name) => assigned.has(name));
}

/**
 * Whether this assignment row carries at least one MCP connector — assigned, whether or not it is
 * currently enabled, for the reason {@link demandsSkills} gives.
 */
export function demandsConnectors(
  assigned: Pick<AgentResourceAssignments, 'connectorIds'> | null,
): boolean {
  return assigned !== null && assigned.connectorIds.length > 0;
}

/**
 * `422 engine_capability_unsupported` when `engineId` cannot honour `demand`, otherwise `null`
 * (ADR-0065 D3 — refuse, never ignore).
 *
 * An engine this deployment does not register answers `null`: whether an engine may be *named* is
 * {@link parsePolicyBody}'s question and it has already answered `unsupported_engine` for that body,
 * so reporting a missing capability of an engine that is not installed would name the wrong fix.
 * The refusal's `details` is exactly the capability, which is what a client branches on
 * (`ENGINE_CAPABILITY_KEYS`, `packages/contracts/src/engines.ts`).
 */
export function engineCapabilityRefusal(
  engineId: string,
  demand: EngineCapabilityDemand,
): ApiResult | null {
  const engine = registeredEngine(engineId);
  if (engine === null) return null;
  const capability = unsupportedEngineCapability(engine.capabilities, demand);
  if (capability === null) return null;
  return problem(
    AGENT_POLICY_PROBLEM_CODES.engine_capability_unsupported,
    'engine_capability_unsupported',
    engineCapabilityRefusalMessage(engineId, capability),
    [capability],
  );
}

/** The server of an `mcp__<server>__…` rule: everything up to the first `__` after the prefix. */
const MCP_RULE_SERVER = /^mcp__(.+?)__/u;

const CONNECTOR_SERVER_PREFIX = 'connector-';

/** A server written as the fallback key `connector-<id>`: already the stored form. */
const CONNECTOR_ID_SERVER = /^connector-/u;

/**
 * Every server an MCP rule of `policy` names by a connector name rather than by `connector-<id>`,
 * de-duplicated: the names {@link withStoredConnectorIds} needs looked up.
 */
export function mcpRuleServerNames(policy: AgentPolicy): readonly string[] {
  if (!('tools' in policy)) return [];
  const { base, autoApprove, deny } = policy.tools;
  const rules = [...(base === 'claude_code_preset' ? [] : base), ...autoApprove, ...deny];
  const names = new Set<string>();
  for (const rule of rules) {
    const server = MCP_RULE_SERVER.exec(rule)?.[1];
    if (server !== undefined && !CONNECTOR_ID_SERVER.test(server)) names.add(server);
  }
  return [...names];
}

/**
 * `policy` with every rule written as `mcp__<name>__…`, where `<name>` names an MCP connector of the
 * workspace (`ids`, by name), stored as `mcp__connector-<id>__…` (ADR-0113 SD13, #1109).
 *
 * A run keys an MCP connector by its name when it can, so an owner writes rules that way, but a
 * name is not stable: a rename, or a same-named tool connector that sends the connector back to its
 * `connector-<id>` key, would make a stored `deny` stop matching, and a stored `autoApprove`
 * transfer to whichever connector next takes the name. Stored by id, compose points the rule at the
 * connector's key in that run (`withRunConnectorKeys`, `../compose/run-request.ts`). A name no MCP
 * connector has is left as written.
 */
export function withStoredConnectorIds(
  policy: AgentPolicy,
  ids: ReadonlyMap<string, string>,
): AgentPolicy {
  if (!('tools' in policy) || ids.size === 0) return policy;
  const rewrite = (rules: readonly string[]): string[] => [
    ...new Set(
      rules.map((rule) =>
        rule.replace(MCP_RULE_SERVER, (prefix, server: string) => {
          const id = ids.get(server);
          return id === undefined ? prefix : `mcp__connector-${id}__`;
        }),
      ),
    ),
  ];
  const { tools } = policy;
  return {
    ...policy,
    tools: {
      ...tools,
      base: tools.base === 'claude_code_preset' ? tools.base : rewrite(tools.base),
      autoApprove: rewrite(tools.autoApprove),
      deny: rewrite(tools.deny),
    },
  };
}

/**
 * Every `connector-<id>` server a rule of `policy` names (a rule stored by connector id,
 * ADR-0113 SD13), de-duplicated: the connectors whose current names a view looks up.
 */
export function storedConnectorServers(policy: AgentPolicy): readonly string[] {
  if (!('tools' in policy)) return [];
  const { base, autoApprove, deny } = policy.tools;
  const rules = [...(base === 'claude_code_preset' ? [] : base), ...autoApprove, ...deny];
  return [...new Set(rules.flatMap((rule) => toolRuleConnectorServer(rule) ?? []))];
}

/**
 * The current key ({@link connectorServerKey}) of each connector a rule of `policy` stores by id,
 * keyed by `connector-<id>` (display only, see {@link describeToolRule}). A connector the workspace
 * no longer has, or whose key falls back to `connector-<id>`, is absent, and a policy with no such
 * rule asks the store nothing.
 */
export async function connectorNamesOf(
  store: {
    namesOf(ids: {
      connector: readonly string[];
    }): Promise<{ connector: ReadonlyMap<string, string> }>;
  },
  policy: AgentPolicy,
): Promise<Record<string, string>> {
  const servers = storedConnectorServers(policy);
  if (servers.length === 0) return {};
  const { connector } = await store.namesOf({
    connector: servers.map((server) => server.slice(CONNECTOR_SERVER_PREFIX.length)),
  });
  const names: Record<string, string> = {};
  for (const [id, name] of connector) {
    // The run's tool connector keys are unknown here, so none is taken.
    const key = connectorServerKey(name, id, new Set());
    const server = `${CONNECTOR_SERVER_PREFIX}${id}`;
    if (key !== server) names[server] = key;
  }
  return names;
}

export type CarriedPolicy =
  | { readonly ok: true; readonly policy: AgentPolicy }
  | { readonly ok: false; readonly result: ApiResult };

/**
 * Carry the stored policy's narrowing into a `PUT` that switches engines (ADR-0074 D12), or refuse
 * `422 engine_switch_would_widen` naming every denial the new arm cannot express.
 *
 * `stored` is the column: `null` means no policy was ever stored, and the compiled policy a `GET`
 * would answer narrows nothing beyond the permission checkboxes, which every engine compiles from
 * already — so there is nothing to carry. A `PUT` on the same engine is a replacement, carried
 * verbatim: that is how an owner widens on purpose.
 */
export function carryEngineSwitch(
  stored: AgentPolicy | null,
  next: AgentPolicy,
  connectorNames: Readonly<Record<string, string>> = {},
): CarriedPolicy {
  if (stored === null) return { ok: true, policy: next };
  const translation = translatePolicyForEngineSwitch(stored, next);
  if (translation.ok) return { ok: true, policy: translation.policy };
  const rules = translation.refused.map((rule) => describeToolRule(rule, connectorNames));
  return {
    ok: false,
    result: problem(
      AGENT_POLICY_PROBLEM_CODES.engine_switch_would_widen,
      'engine_switch_would_widen',
      `Moving this agent from '${stored.engine}' to '${next.engine}' would drop ` +
        `${translation.refused.length === 1 ? 'a denial' : 'denials'} the '${next.engine}' policy cannot express, ` +
        'so the agent could use a tool its owner denied. Remove each named rule from the current ' +
        `policy first (or turn off the permission it guards), then switch. The rules: ${rules.join(', ')}.`,
      translation.refused,
    ),
  };
}
