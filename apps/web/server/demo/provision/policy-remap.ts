/**
 * A template agent's tool rules, carried into a visitor's copy. A stored rule on an MCP connector
 * names the connector by id (`mcp__connector-<id>__<tool>`, ADR-0113 SD13), and a stand-in in the
 * visitor's workspace has a new id, so a rule copied verbatim would match nothing: a tool the
 * template makes wait for a person's approval, or denies, would lose that rule in the demo. These
 * two functions keep the rules: the stand-in offers the tools the rules name, and each rule is
 * pointed at the stand-in that replaced its connector.
 *
 * The approval gates (`requireApproval`) are pointed at the stand-in too, and by its id: a template
 * seeded before #2439 holds them on the connector's name (`mcp__tracker__create_task`, as a
 * definition carries them; a seed now stores them by id, {@link withConnectorIdsByName}),
 * and a stand-in does not always keep that name (`tracker-incident` when another entry's stand-in
 * holds it, ADR-0171 D3). A gate left on the name would match no tool of the run, and the write it
 * guards would run without a person's approval. Compose points an id rule at the run's server key.
 */
import type { AgentPolicy } from '@indx-workspace/contracts/agents';

/** A rule on one connector, by id: the connector id and the rest of the rule (the tool part). */
const CONNECTOR_RULE = /^mcp__connector-(.+?)__(.*)$/u;

/** A rule written on a connector by its name: `mcp__<name>__<tool>`. */
const NAMED_CONNECTOR_RULE = /^mcp__(?!connector-)(.+?)__(.*)$/u;

/** A tool name a stand-in can offer: a plain name, not a pattern. */
const PLAIN_TOOL_NAME = /^[A-Za-z0-9_-]+$/u;

function rulesOf(policy: AgentPolicy): readonly string[] {
  if (!('tools' in policy)) return [];
  const { base, autoApprove, deny } = policy.tools;
  return [...(base === 'claude_code_preset' ? [] : base), ...autoApprove, ...deny];
}

/** The plain tool names the policy's rules name on the connector `connectorId`, de-duplicated. */
export function toolsNamedOn(policy: AgentPolicy, connectorId: string): readonly string[] {
  const names = new Set<string>();
  for (const rule of rulesOf(policy)) {
    const match = CONNECTOR_RULE.exec(rule);
    const tool = match?.[2];
    if (match?.[1] === connectorId && tool !== undefined && PLAIN_TOOL_NAME.test(tool)) {
      names.add(tool);
    }
  }
  return [...names];
}

/**
 * `policy` with each of its tool rules rewritten by `rewrite` and each approval gate by
 * `rewriteGate`, whatever else it holds kept.
 */
function mapRules(
  policy: AgentPolicy,
  rewrite: (rule: string) => string,
  rewriteGate: (rule: string) => string = rewrite,
): AgentPolicy {
  if (!('tools' in policy)) return policy;
  const { tools, requireApproval } = policy;
  return {
    ...policy,
    tools: {
      ...tools,
      base: tools.base === 'claude_code_preset' ? tools.base : tools.base.map(rewrite),
      autoApprove: tools.autoApprove.map(rewrite),
      deny: tools.deny.map(rewrite),
    },
    ...(requireApproval === undefined ? {} : { requireApproval: requireApproval.map(rewriteGate) }),
  };
}

/**
 * `policy` with every rule on a template connector in `standIns` (template id to stand-in id)
 * pointed at that stand-in. A rule on a connector the copy leaves out keeps the template id, which
 * names no connector of the visitor's workspace and so matches nothing.
 *
 * Its approval gates are pointed at the stand-in as well, whether the template wrote them on the
 * connector's id or on its name (`templateNames`, template id to the connector's name): each
 * becomes a rule on the stand-in's id, so the write still waits whatever name the stand-in has.
 */
export function withStandInConnectorIds(
  policy: AgentPolicy,
  standIns: ReadonlyMap<string, string>,
  templateNames: ReadonlyMap<string, string>,
): AgentPolicy {
  if (standIns.size === 0) return policy;
  const byId = (rule: string): string => {
    const match = CONNECTOR_RULE.exec(rule);
    const standIn = match?.[1] === undefined ? undefined : standIns.get(match[1]);
    return standIn === undefined ? rule : `mcp__connector-${standIn}__${match?.[2] ?? ''}`;
  };
  const standInByName = new Map<string, string>();
  for (const [templateId, standIn] of standIns) {
    const name = templateNames.get(templateId);
    if (name !== undefined) standInByName.set(name, standIn);
  }
  const gate = (rule: string): string => {
    const match = NAMED_CONNECTOR_RULE.exec(rule);
    const standIn = match?.[1] === undefined ? undefined : standInByName.get(match[1]);
    return standIn === undefined ? byId(rule) : `mcp__connector-${standIn}__${match?.[2] ?? ''}`;
  };
  return mapRules(policy, byId, gate);
}

/**
 * Thrown when a copy would keep an approval gate on a template connector no stand-in replaced: on
 * the stale name or id it would match no tool of the run, so the copy fails rather than run a write
 * unguarded. The message names tool rules only, never an address or a secret.
 */
export class UnmappedApprovalGateError extends Error {
  override readonly name = 'UnmappedApprovalGateError';
  constructor(readonly gates: readonly string[]) {
    super(
      `the demo copy's approval gates ${gates.join(', ')} name a connector no stand-in replaced`,
    );
  }
}

/**
 * The approval gates of `policy` (a copy's, after {@link withStandInConnectorIds}) still written on
 * one of the template agent's connectors (`templateNames`, template id to name), by its id or its
 * name. A gate on any other server (the platform's `agent-workspace` tools, a team member) is not
 * a template connector's and is not listed.
 */
export function unmappedApprovalGates(
  policy: AgentPolicy,
  templateNames: ReadonlyMap<string, string>,
): readonly string[] {
  if (!('tools' in policy)) return [];
  const names = new Set(templateNames.values());
  return (policy.requireApproval ?? []).filter((rule) => {
    const id = CONNECTOR_RULE.exec(rule)?.[1];
    if (id !== undefined) return templateNames.has(id);
    const name = NAMED_CONNECTOR_RULE.exec(rule)?.[1];
    return name !== undefined && names.has(name);
  });
}

/**
 * `policy` with every rule written on a connector by name (`mcp__<name>__<tool>`, as a definition
 * carries them) stored by that connector's id (`mcp__connector-<id>__<tool>`, ADR-0113 SD13), for the
 * connectors in `idsByName`. A rule on any other name (a built-in tool's) is kept.
 *
 * The approval gates are stored by id too (ADR-0145, amendment #2439): a gate left on the name would
 * match no tool once the template's connector is renamed, and the write would run unguarded.
 */
export function withConnectorIdsByName(
  policy: AgentPolicy,
  idsByName: ReadonlyMap<string, string>,
): AgentPolicy {
  return mapRules(policy, (rule) => {
    const match = NAMED_CONNECTOR_RULE.exec(rule);
    const id = match?.[1] === undefined ? undefined : idsByName.get(match[1]);
    return id === undefined ? rule : `mcp__connector-${id}__${match?.[2] ?? ''}`;
  });
}
