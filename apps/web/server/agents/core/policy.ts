/**
 * The agent policy rules, pure (refactoring plan part 07, step 1): what `GET`/`PUT
 * /api/agents/:id/policy` decides, with no store, no engine registry and no HTTP. Every input is
 * passed in, and a refusal comes back as data, a {@link PolicyRefusal}. `../policy.ts` is the shell:
 * it loads the facts, reads the engine registry, and turns a refusal into the route's problem
 * answer. The reasons behind each rule are written there, next to the route.
 */
import {
  AGENT_POLICY_PROBLEM_CODES,
  AgentPolicySchema,
  claudeBaseToolPolicyFor,
  translatePolicyForEngineSwitch,
  type AgentPermissions,
  type AgentPolicy,
  type AgentPolicyProblemCode,
  type AgentPolicySource,
} from '@indx-workspace/contracts/agents';
import { DEFAULT_ENGINE_ID } from '@indx-workspace/contracts/engines';
import {
  describeToolRule,
  toolRuleConnectorServer,
} from '@indx-workspace/contracts/tool-connectors';

/** A refusal as data. The shell answers it as `problem(status, code, message, details)`. */
export interface PolicyRefusal {
  readonly status: number;
  readonly code: AgentPolicyProblemCode;
  readonly message: string;
  /** Lines given verbatim. */
  readonly details?: readonly string[];
  /** Schema issues; the shell formats them into the details lines. */
  readonly issues?: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}

/** The ids an agent's resource assignment row holds, in this domain's words. */
export interface AssignedResourceIds {
  readonly skillIds: readonly string[];
  readonly connectorIds: readonly string[];
}

function refusal(
  code: AgentPolicyProblemCode,
  message: string,
  extra: Pick<PolicyRefusal, 'details' | 'issues'> = {},
): PolicyRefusal {
  return { status: AGENT_POLICY_PROBLEM_CODES[code], code, message, ...extra };
}

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

/** The part of an agent the policy rules read. */
export interface PolicyHolder {
  readonly policy: AgentPolicy | null;
  readonly permissions: AgentPermissions;
}

/** The policy `GET` answers: the stored one, or the compiled one when the column is NULL. */
export function policyFor(
  agent: PolicyHolder,
  assignedEnabledSkillNames: readonly string[],
): AgentPolicy {
  return agent.policy ?? compiledPolicyFor(agent.permissions, assignedEnabledSkillNames);
}

/**
 * Whether {@link policyFor} answers a stored policy or a compiled one — the `source` of
 * `AgentPolicyResponseSchema`. A client that copies the policy elsewhere (K-1 export, ADR-0076 D2)
 * needs it so a compiled policy is not frozen into a stored one.
 */
export function policySourceOf(agent: Pick<PolicyHolder, 'policy'>): AgentPolicySource {
  return agent.policy === null ? 'compiled' : 'stored';
}

export type ParsedPolicy =
  | { readonly ok: true; readonly policy: AgentPolicy }
  | { readonly ok: false; readonly refusal: PolicyRefusal };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `PUT` body against the published shape, the registered engines and the dangerous mode. */
export function parsePolicy(raw: unknown, registered: readonly string[]): ParsedPolicy {
  if (isPlainObject(raw) && !('engine' in raw) && 'provider' in raw) {
    return {
      ok: false,
      refusal: refusal(
        'invalid_body',
        "The policy discriminant is 'engine', naming the harness that runs the agent loop. " +
          "'provider' names the model provider and is no longer accepted here (ADR-0065).",
      ),
    };
  }
  if (isPlainObject(raw) && 'engine' in raw) {
    const unsupported = unsupportedEngine(raw['engine'], registered);
    if (unsupported !== null) return { ok: false, refusal: unsupported };
  }
  const parsed = AgentPolicySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      refusal: refusal('invalid_policy', 'The policy body does not match the published shape.', {
        issues: parsed.error.issues,
      }),
    };
  }
  const dangerous = dangerousPermissionMode(parsed.data);
  if (dangerous !== null) return { ok: false, refusal: dangerous };
  return { ok: true, policy: parsed.data };
}

/** `400 unsupported_engine` for an engine the given registry does not hold; `null` otherwise. */
export function unsupportedEngine(
  engine: unknown,
  registered: readonly string[],
  details?: readonly string[],
): PolicyRefusal | null {
  if (registered.includes(String(engine))) return null;
  return refusal(
    'unsupported_engine',
    `This deployment registers the engines ${registered.map((id) => `'${id}'`).join(', ')}; received ${JSON.stringify(engine)}.`,
    details === undefined ? {} : { details },
  );
}

/** `400 dangerous_permission_mode_refused` for a `bypassPermissions` policy; `null` otherwise. */
export function dangerousPermissionMode(policy: AgentPolicy): PolicyRefusal | null {
  if (!('tools' in policy) || policy.tools.permissionMode !== 'bypassPermissions') {
    return null;
  }
  return refusal(
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
 * same reason makes assignment, not enablement, what `skill_not_assigned` checks (`../policy.ts`'s header).
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
  assigned: Pick<AssignedResourceIds, 'connectorIds'> | null,
): boolean {
  return assigned !== null && assigned.connectorIds.length > 0;
}

const MCP_RULE_SERVER = /^mcp__(.+?)__/u;

/** The prefix a connector-id server name carries (`connector-<id>`). */
export const CONNECTOR_SERVER_PREFIX = 'connector-';

const CONNECTOR_ID_SERVER = /^connector-/u;

function policyRules(policy: AgentPolicy): readonly string[] {
  if (!('tools' in policy)) return [];
  const { base, autoApprove, deny } = policy.tools;
  return [...(base === 'claude_code_preset' ? [] : base), ...autoApprove, ...deny];
}

/**
 * Every server an MCP rule of `policy` names by a connector name rather than by `connector-<id>`,
 * de-duplicated: the names {@link withStoredConnectorIds} needs looked up.
 */
export function mcpRuleServerNames(policy: AgentPolicy): readonly string[] {
  const names = new Set<string>();
  for (const rule of policyRules(policy)) {
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
  return [...new Set(policyRules(policy).flatMap((rule) => toolRuleConnectorServer(rule) ?? []))];
}

export type CarriedPolicy =
  | { readonly ok: true; readonly policy: AgentPolicy }
  | { readonly ok: false; readonly refusal: PolicyRefusal };

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
    refusal: refusal(
      'engine_switch_would_widen',
      `Moving this agent from '${stored.engine}' to '${next.engine}' would drop ` +
        `${translation.refused.length === 1 ? 'a denial' : 'denials'} the '${next.engine}' policy cannot express, ` +
        'so the agent could use a tool its owner denied. Remove each named rule from the current ' +
        `policy first (or turn off the permission it guards), then switch. The rules: ${rules.join(', ')}.`,
      { details: translation.refused },
    ),
  };
}
