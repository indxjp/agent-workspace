/**
 * Subagents on the compile path: the one error and the one check that keep a declared subagent
 * callable, and the translation of one subagent into an `agents` entry.
 *
 * Split out of `./compile.ts`; the behaviour is unchanged and `./compile.ts` re-exports these.
 */
import { claudeDeniedToolsFor, type AgentToolPolicy } from '@indx-workspace/contracts/agents';
import type { RunRequest } from '@agent-workspace/run-protocol';

import type { CompiledSdkAgent } from './options.js';

/** Thrown when subagents are declared but the parent's tool policy removes the tool that calls them. */
export class SubagentToolRemovedError extends Error {}

/**
 * The SDK's delegation tool: the model reaches an `agents` entry only by calling it.
 *
 * VERIFY: the pinned `sdk.d.ts` types tool names as `string`, so no type can pin this one. The
 * name is from https://code.claude.com/docs/en/agent-sdk/subagents, and `./boundary.test.ts`
 * checks it against the pinned `sdk-tools.d.ts` (`AgentInput` in `ToolInputSchemas`).
 */
export const CLAUDE_DELEGATION_TOOL = 'Agent';

export type PortableSubagent = NonNullable<RunRequest['portable']['subagents']>[number];

/** Refuses a policy that declares subagents yet removes the tool that calls them. */
export function assertSubagentsCallable(
  subagents: readonly PortableSubagent[],
  tools: AgentToolPolicy,
): void {
  if (subagents.length > 0 && removesDelegationTool(tools)) {
    throw new SubagentToolRemovedError(
      "the agent's tool policy removes Agent, so its subagents could never be called",
    );
  }
}

function removesDelegationTool(tools: AgentToolPolicy): boolean {
  return (
    tools.deny.includes(CLAUDE_DELEGATION_TOOL) ||
    (tools.base !== 'claude_code_preset' && !tools.base.includes(CLAUDE_DELEGATION_TOOL))
  );
}

/** The `agents` option for a run: nothing when it has no subagents. */
export function compileSubagents(
  subagents: readonly PortableSubagent[],
  parentDeny: readonly string[],
): { readonly agents?: Record<string, CompiledSdkAgent> } {
  if (subagents.length === 0) return {};
  return {
    agents: Object.fromEntries(
      subagents.map((subagent) => [subagent.name, compileSubagent(subagent, parentDeny)]),
    ),
  };
}

/**
 * One subagent as an `agents` entry. It inherits the parent's tools, so only what its own
 * permissions deny beyond the parent's is listed; the parent's denials already apply.
 */
function compileSubagent(
  subagent: PortableSubagent,
  parentDeny: readonly string[],
): CompiledSdkAgent {
  const own = claudeDeniedToolsFor(subagent.permissions).filter(
    (rule) => !parentDeny.includes(rule),
  );
  return {
    description: subagent.description,
    prompt: subagent.instructions,
    ...(subagent.model === null ? {} : { model: subagent.model }),
    ...(own.length === 0 ? {} : { disallowedTools: own }),
  };
}
