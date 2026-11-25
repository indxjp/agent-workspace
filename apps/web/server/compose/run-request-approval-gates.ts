/**
 * A stored approval gate (`requireApproval`, ADR-0145 D3) pointed at the server key its connector
 * has in this run, or the run refused (#2439).
 *
 * A gate names a connector tool as `mcp__<server>__<tool>`, and Claude Code matches it against the
 * tool names of the run, which carry the run's server keys. A connector's key is not stable: it is
 * its name, or `connector-<id>` when the name is not usable or a same-named tool connector takes it
 * (ADR-0113 SD13, #1109), and the name changes on a rename. A gate left on a key the run no longer
 * uses matches no tool, and the write it guards runs without a person's approval and without an
 * error. So:
 *
 * - a gate stored by connector id (`mcp__connector-<id>__…`, what a save writes since #2439) is
 *   given the connector's key in this run;
 * - a gate stored by connector name (a version saved before #2439) is also given the key of the
 *   run's connector of that name, and is kept as written as well, so a tool connector keyed by that
 *   name stays gated too: gating one tool more only asks once more, gating one less skips a person;
 * - a gate whose connector is served by this run but which still names none of the run's servers is
 *   refused with `approval_gate_unresolved` rather than dropped.
 *
 * A gate whose connector is not served by this run at all (not assigned, disabled, or left out by
 * the policy ceiling) is kept as written. It matches nothing, and there is nothing for it to guard:
 * the run cannot call a tool of a connector it does not have. Refusing it would stop every run of
 * an agent whose gated connector is switched off, for no protection.
 */
import { DomainError } from '../errors';
import type { AgentRunResourceSelection } from './resource-loader';

const MCP_RULE_SERVER = /^mcp__(.+?)__/u;

const CONNECTOR_ID_RULE_PREFIX = /^mcp__connector-([0-9a-f-]{36})__/u;

/** What a gate is resolved against: the run's MCP servers and their connectors. */
export type ApprovalGateResources = Pick<
  AgentRunResourceSelection,
  'mcpServers' | 'connectorNames' | 'connectorKeys'
>;

/** One stored gate in the run's terms, and whether its connector is served by the run. */
interface ResolvedGate {
  readonly rules: readonly string[];
  readonly connectorServed: boolean;
}

function resolveIdGate(
  gate: string,
  id: string,
  served: ReadonlySet<string>,
  keys: Readonly<Record<string, string>>,
): ResolvedGate {
  const key = keys[id];
  return {
    rules: [key === undefined ? gate : gate.replace(CONNECTOR_ID_RULE_PREFIX, `mcp__${key}__`)],
    connectorServed: (key !== undefined && served.has(key)) || served.has(`connector-${id}`),
  };
}

function resolveNameGate(
  gate: string,
  name: string,
  served: ReadonlySet<string>,
  names: Readonly<Record<string, string>>,
): ResolvedGate {
  const tool = gate.slice(`mcp__${name}__`.length);
  const keysOfName = [...served].filter((key) => names[key] === name);
  return {
    rules: [gate, ...keysOfName.filter((key) => key !== name).map((key) => `mcp__${key}__${tool}`)],
    connectorServed: keysOfName.length > 0,
  };
}

function resolveGate(
  gate: string,
  served: ReadonlySet<string>,
  resources: ApprovalGateResources,
): ResolvedGate {
  const id = CONNECTOR_ID_RULE_PREFIX.exec(gate)?.[1];
  if (id !== undefined) return resolveIdGate(gate, id, served, resources.connectorKeys ?? {});
  const name = MCP_RULE_SERVER.exec(gate)?.[1];
  if (name === undefined) return { rules: [gate], connectorServed: false };
  return resolveNameGate(gate, name, served, resources.connectorNames ?? {});
}

const namesServedServer = (rule: string, served: ReadonlySet<string>): boolean => {
  const server = MCP_RULE_SERVER.exec(rule)?.[1];
  return server !== undefined && served.has(server);
};

/**
 * `gates` with every gate on an MCP connector pointed at the connector's key in this run (see the
 * file header); any other gate (`Write`, a tool connector's key, a member tool) is left as it is.
 *
 * @throws {DomainError} `approval_gate_unresolved` when a gate's connector is served by this run and
 *   no rule the gate became names one of the run's servers: the run is refused rather than started
 *   with a gate that guards nothing.
 */
export function approvalGatesForRun(
  gates: readonly string[],
  resources: ApprovalGateResources,
): readonly string[] {
  const served = new Set(Object.keys(resources.mcpServers));
  return gates.flatMap((gate) => {
    const resolved = resolveGate(gate, served, resources);
    if (
      resolved.connectorServed &&
      !resolved.rules.some((rule) => namesServedServer(rule, served))
    ) {
      throw new DomainError({
        category: 'validation',
        code: 'approval_gate_unresolved',
        publicMessage:
          `approval_gate_unresolved: the approval gate ${JSON.stringify(gate)} is on a connector ` +
          "this run has, but it matches none of the run's tools, so the run is refused rather " +
          'than started without the approval.',
      });
    }
    return resolved.rules;
  });
}
