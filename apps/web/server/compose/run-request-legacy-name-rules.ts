/**
 * A stored tool rule written by an MCP connector's name, `mcp__<name>__<tool>`, read in the run's
 * terms (#2446). A save has stored such rules by connector id since #1109 (ADR-0113 SD13), but a
 * version saved before then holds them by name, and versions are immutable. A connector's run key is
 * its name or `connector-<id>`, when a same-named tool connector takes the name (#1109) or the name
 * is not usable as a key, so a name rule can name a key that is no longer its connector's:
 *
 * - a `deny` would stop matching the connector's tool, or land on the tool connector instead. It is
 *   given the key of the run's MCP connector of that name as well, and kept as written: a deny on one
 *   more key only narrows.
 * - an `autoApprove`, or a `tools.base` entry, would grant the tool of whichever server now holds the
 *   key. It is never moved to another key. It is dropped when the run's MCP connector of that name
 *   has another key, since the key it names then belongs to a different server; otherwise it is kept
 *   as written (it names its own connector, a tool connector's key, or nothing in this run).
 *
 * A name rule whose connector has since been renamed names no connector of the run and nothing links
 * it to the renamed one: the deny matches nothing until the agent is saved again (ADR-0145,
 * amendment #2439).
 */
import type { AgentToolPolicy } from '@indx-workspace/contracts/agents';

import type { AgentRunResourceSelection } from './resource-loader';

/** A rule on a server written by name: never `connector-<id>`, which is a rule stored by id. */
const NAME_RULE_SERVER = /^mcp__(?!connector-)(.+?)__/u;

/** What a name rule is read against: the run's MCP servers and the connector name behind each. */
export type LegacyNameRuleResources = Pick<
  AgentRunResourceSelection,
  'mcpServers' | 'connectorNames'
>;

/**
 * `tools` with each rule written by an MCP connector's name read in this run's terms (see the file
 * header). A rule by id, a built-in tool's rule and a rule whose name no MCP connector of the run
 * has are left as they are.
 */
export function withLegacyNameRules<T extends AgentToolPolicy>(
  tools: T,
  resources: LegacyNameRuleResources,
): T {
  const names = resources.connectorNames ?? {};
  const served = Object.keys(resources.mcpServers);
  /** The run keys, other than `name` itself, of the served MCP connector named `name`. */
  const otherKeysOf = (name: string): readonly string[] =>
    served.filter((key) => key !== name && names[key] === name);
  const denied = (rules: readonly string[]): readonly string[] => [
    ...new Set(
      rules.flatMap((rule) => {
        const name = NAME_RULE_SERVER.exec(rule)?.[1];
        if (name === undefined) return [rule];
        const tool = rule.slice(`mcp__${name}__`.length);
        return [rule, ...otherKeysOf(name).map((key) => `mcp__${key}__${tool}`)];
      }),
    ),
  ];
  const granted = (rules: readonly string[]): readonly string[] =>
    rules.filter((rule) => {
      const name = NAME_RULE_SERVER.exec(rule)?.[1];
      return name === undefined || otherKeysOf(name).length === 0;
    });
  return {
    ...tools,
    base: tools.base === 'claude_code_preset' ? tools.base : granted(tools.base),
    autoApprove: granted(tools.autoApprove),
    deny: denied(tools.deny),
  };
}
