/**
 * The OpenAI Agents tool mapping: §17 Step 4's four permission switches into this engine's tool
 * set (ENG-09, #308).
 *
 * Pure. The tool **names** and the switch each needs are declared once, in
 * `@indx-workspace/contracts/agents` (`OPENAI_AGENTS_TOOL_NAMES`, `OPENAI_AGENTS_TOOL_PERMISSION`),
 * because the control plane names them too when it carries an engine switch's narrowing across
 * (`translatePolicyForEngineSwitch`, ADR-0074 D12) and `apps/web` may never import this package.
 * `./boundary.ts` builds one SDK function tool per name in {@link OpenAiAgentsToolPlan.tools}, and
 * nothing else: a tool that is not in the plan is never offered to the model.
 *
 * ## Why every tool is a function tool
 *
 * Issue #308 asked for `shellTool` and `applyPatchTool`. Both are Responses-API tool *types*
 * (`{"type":"shell"}`, `{"type":"apply_patch"}`), and neither survives this platform's path to a
 * model:
 *
 *   * the gateway's hosted-tool rule (ADR-0068 D4) relays a `tools` entry only when its `type` is
 *     `function` or `custom`, so both are refused `400 hosted_tool_not_permitted` before anything
 *     is sent upstream;
 *   * the SDK itself refuses them on the other two protocols — `OpenAIChatCompletionsModel`
 *     throws *"Hosted tools are not supported with the ChatCompletions API"* and the AI SDK
 *     adapter throws *"Unsupported tool type"*.
 *
 * So the adapter supplies the same executors the issue describes — our Shell and our Editor, run
 * inside the container under `cwd` — behind SDK **function** tools, which every protocol relays.
 * Nothing is emulated: the SDK has no executor of its own for a local shell or a patch either, and
 * the Editor applies a patch with the SDK's own `applyDiff`. ADR-0074 records the choice.
 *
 * ## The switches
 *
 * | Switch                | Tools                                         |
 * | --------------------- | --------------------------------------------- |
 * | `readFiles`           | `read_file`, `list_files`, `search_files`     |
 * | `writeFiles`          | `apply_patch`                                 |
 * | `runCommands`         | `shell` — omitted while a read-only grant exists |
 * | `unrestrictedNetwork` | `networkEgress`: the sandbox's open network   |
 *
 * `shell` is withheld under a read-only grant for the reason the Claude adapter withholds `Bash`
 * (`applyFileGrantPolicy`): a redirect would write the file the grant protects, and no executor can
 * tell a redirect from a read. `unrestrictedNetwork` has no tool of its own on this engine — the
 * SDK's web search is vendor-hosted and refused — so it compiles to `networkEgress`, the statement
 * that the run may reach the open network. Remote (`http`/`sse`) MCP connectors do **not** depend
 * on it: they are allowed without the switch, as on the Claude engine (Owner decision on #308,
 * ADR-0074 D2).
 */
import {
  OPENAI_AGENTS_TOOL_NAMES,
  OPENAI_AGENTS_TOOL_PERMISSION,
  type AgentPermissionKey,
  type AgentPermissions,
  type OpenAiAgentsToolName,
} from '@indx-workspace/contracts/agents';
import type { AgentToolKind } from '@indx-workspace/contracts/run-events';
import {
  permissionToolPlan,
  RUN_SKILL_SCRIPT_TOOL,
  toolPlanAllowsPermission,
} from '@agent-workspace/engine';

/** The neutral `agent.tool.call` kind of each tool (ENG-03). An MCP tool is always `mcp`. */
export const OPENAI_AGENTS_TOOL_KIND: Readonly<Record<OpenAiAgentsToolName, AgentToolKind>> = {
  read_file: 'read',
  list_files: 'read',
  search_files: 'search',
  apply_patch: 'edit',
  shell: 'execute',
};

/** The compiled tool set: the tools offered, and whether the run may reach the open network. */
export type OpenAiAgentsToolPlan = {
  readonly tools: readonly OpenAiAgentsToolName[];
  readonly networkEgress: boolean;
};

/**
 * The tool plan for one run. `hasReadOnlyGrant` withholds `shell` (see the module header).
 */
export function openAiAgentsToolPlan(
  permissions: AgentPermissions,
  hasReadOnlyGrant: boolean,
): OpenAiAgentsToolPlan {
  return permissionToolPlan(
    OPENAI_AGENTS_TOOL_NAMES,
    OPENAI_AGENTS_TOOL_PERMISSION,
    permissions,
    hasReadOnlyGrant,
  );
}

/** The kind of a tool call the SDK reported, by the name the model called. */
export function openAiAgentsToolKind(name: string, isMcp: boolean): AgentToolKind {
  if (isMcp) return 'mcp';
  if (name === RUN_SKILL_SCRIPT_TOOL) return 'execute';
  return (OPENAI_AGENTS_TOOL_KIND as Readonly<Record<string, AgentToolKind>>)[name] ?? 'other';
}

/**
 * Does a compiled plan still allow what this switch governs? The conformance kit's
 * `permissionAllowed`.
 */
export function openAiAgentsPlanAllowsPermission(
  plan: OpenAiAgentsToolPlan,
  permission: AgentPermissionKey,
): boolean {
  return toolPlanAllowsPermission(plan, OPENAI_AGENTS_TOOL_PERMISSION, permission);
}
