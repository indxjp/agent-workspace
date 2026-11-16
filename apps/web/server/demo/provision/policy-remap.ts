/**
 * A template agent's tool rules, carried into a visitor's copy. A stored rule on an MCP connector
 * names the connector by id (`mcp__connector-<id>__<tool>`, ADR-0113 SD13), and a stand-in in the
 * visitor's workspace has a new id, so a rule copied verbatim would match nothing: a tool the
 * template makes wait for a person's approval, or denies, would lose that rule in the demo. These
 * two functions keep the rules: the stand-in offers the tools the rules name, and each rule is
 * pointed at the stand-in that replaced its connector.
 */
import type { AgentPolicy } from '@indx-workspace/contracts/agents';

/** A rule on one connector, by id: the connector id and the rest of the rule (the tool part). */
const CONNECTOR_RULE = /^mcp__connector-(.+?)__(.*)$/u;

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

/** `policy` with each of its tool rules rewritten by `rewrite`, whatever else it holds kept. */
function mapRules(policy: AgentPolicy, rewrite: (rule: string) => string): AgentPolicy {
  if (!('tools' in policy)) return policy;
  const { tools } = policy;
  return {
    ...policy,
    tools: {
      ...tools,
      base: tools.base === 'claude_code_preset' ? tools.base : tools.base.map(rewrite),
      autoApprove: tools.autoApprove.map(rewrite),
      deny: tools.deny.map(rewrite),
    },
  };
}

/**
 * `policy` with every rule on a template connector in `standIns` (template id to stand-in id)
 * pointed at that stand-in. A rule on a connector the copy leaves out keeps the template id, which
 * names no connector of the visitor's workspace and so matches nothing.
 */
export function withStandInConnectorIds(
  policy: AgentPolicy,
  standIns: ReadonlyMap<string, string>,
): AgentPolicy {
  if (standIns.size === 0) return policy;
  return mapRules(policy, (rule) => {
    const match = CONNECTOR_RULE.exec(rule);
    const standIn = match?.[1] === undefined ? undefined : standIns.get(match[1]);
    return standIn === undefined ? rule : `mcp__connector-${standIn}__${match?.[2] ?? ''}`;
  });
}

/** A rule written on a connector by its name: `mcp__<name>__<tool>`. */
const NAMED_CONNECTOR_RULE = /^mcp__(?!connector-)(.+?)__(.*)$/u;

/**
 * `policy` with every rule written on a connector by name (`mcp__<name>__<tool>`, as a definition
 * carries them) stored by that connector's id (`mcp__connector-<id>__<tool>`, ADR-0113 SD13), for the
 * connectors in `idsByName`. A rule on any other name (a built-in tool's) is kept.
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
