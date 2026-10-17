/**
 * The Mastra tool mapping: §17 Step 4's four permission switches into Mastra's workspace tool set
 * (ENG-10, #309).
 *
 * Pure. The tool **names** and the switch each needs are declared once, in
 * `@indx-workspace/contracts/agents` (`MASTRA_TOOL_NAMES`, `MASTRA_TOOL_PERMISSION`), because the
 * control plane names them too when it carries an engine switch's narrowing across
 * (`translatePolicyForEngineSwitch`) and `apps/web` may never import this package. `./boundary.ts`
 * turns {@link MastraToolPlan.tools} into the `Workspace({ tools })` configuration, enabling exactly
 * these and disabling every other workspace tool, so a tool outside the plan is never declared to
 * the model.
 *
 * ## The switches
 *
 * | Switch                | Tools                                                             |
 * | --------------------- | ----------------------------------------------------------------- |
 * | `readFiles`           | `read_file`, `list_files`, `grep`, `file_stat`                    |
 * | `writeFiles`          | `write_file`, `edit_file`, `mkdir`, `delete`                      |
 * | `runCommands`         | `execute_command` and the process tools — withheld under a read-only grant |
 * | `unrestrictedNetwork` | `networkEgress`: the sandbox's open network                      |
 *
 * (each name carries Mastra's `mastra_workspace_` prefix). `execute_command` is withheld under a
 * read-only grant for the reason every other adapter withholds its shell: a redirect would write the
 * file the grant protects, and no filesystem wrapper sees a write a subprocess makes.
 *
 * Mastra adds three skill tools (`skill`, `skill_search`, `skill_read`) to a workspace that has
 * skills. No switch governs them — they read only what the platform placed under
 * `.mastra/skills` — so they are offered exactly when the run was granted a skill.
 */
import {
  MASTRA_TOOL_NAMES,
  MASTRA_TOOL_PERMISSION,
  type AgentPermissionKey,
  type AgentPermissions,
  type MastraToolName,
} from '@indx-workspace/contracts/agents';
import type { AgentToolKind } from '@indx-workspace/contracts/run-events';
import {
  permissionToolPlan,
  RUN_SKILL_SCRIPT_TOOL,
  toolPlanAllowsPermission,
} from '@agent-workspace/engine';

/** The neutral `agent.tool.call` kind of each Mastra workspace tool (ENG-03). */
export const MASTRA_TOOL_KIND: Readonly<Record<MastraToolName, AgentToolKind>> = {
  mastra_workspace_read_file: 'read',
  mastra_workspace_list_files: 'search',
  mastra_workspace_grep: 'search',
  mastra_workspace_file_stat: 'read',
  mastra_workspace_write_file: 'edit',
  mastra_workspace_edit_file: 'edit',
  mastra_workspace_mkdir: 'edit',
  mastra_workspace_delete: 'delete',
  mastra_workspace_execute_command: 'execute',
  mastra_workspace_get_process_output: 'execute',
  mastra_workspace_kill_process: 'execute',
};

/** The tools Mastra adds for a workspace with skills. Read-only over the placed skills. */
export const MASTRA_SKILL_TOOL_NAMES = ['skill', 'skill_search', 'skill_read'] as const;

/**
 * Workspace tools this adapter never offers, whatever the permissions say: they need an index, a
 * language server or an AST toolchain the platform does not provision, or duplicate a write tool
 * without passing through the same checks. Disabled by name so a Mastra default cannot enable them.
 */
export const MASTRA_ALWAYS_DISABLED_TOOLS = [
  'mastra_workspace_ast_edit',
  'mastra_workspace_search',
  'mastra_workspace_index',
  'mastra_workspace_lsp_inspect',
] as const;

/** The compiled tool set: the workspace tools offered, the skill tools, and network egress. */
export type MastraToolPlan = {
  readonly tools: readonly MastraToolName[];
  readonly skillTools: boolean;
  readonly networkEgress: boolean;
};

/**
 * The tool plan for one run. `hasReadOnlyGrant` withholds the command tools; `hasSkills` offers the
 * skill tools (see the module header).
 */
export function mastraToolPlan(
  permissions: AgentPermissions,
  hasReadOnlyGrant: boolean,
  hasSkills: boolean,
): MastraToolPlan {
  return {
    ...permissionToolPlan(MASTRA_TOOL_NAMES, MASTRA_TOOL_PERMISSION, permissions, hasReadOnlyGrant),
    skillTools: hasSkills,
  };
}

/**
 * The kind of a tool call Mastra reported, by the name the model called. A name under one of the
 * run's connectors (`<server>_<tool>`, `MCPClient.listTools()`'s namespacing) is `mcp`.
 */
export function mastraToolKind(name: string, connectors: readonly string[]): AgentToolKind {
  const workspaceKind = (MASTRA_TOOL_KIND as Readonly<Record<string, AgentToolKind>>)[name];
  if (workspaceKind !== undefined) return workspaceKind;
  if ((MASTRA_SKILL_TOOL_NAMES as readonly string[]).includes(name)) return 'read';
  if (name === RUN_SKILL_SCRIPT_TOOL) return 'execute';
  if (connectors.some((server) => name.startsWith(`${server}_`))) return 'mcp';
  return 'other';
}

/** Does a compiled plan still allow what this switch governs? The conformance kit's `permissionAllowed`. */
export function mastraPlanAllowsPermission(
  plan: Pick<MastraToolPlan, 'tools' | 'networkEgress'>,
  permission: AgentPermissionKey,
): boolean {
  return toolPlanAllowsPermission(plan, MASTRA_TOOL_PERMISSION, permission);
}
