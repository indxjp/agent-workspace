/**
 * The pi tool mapping: §17 Step 4's four permission switches into pi's built-in tool set
 * (ENG-08, #307).
 *
 * Pure. The tool **names** and the switch each needs are declared once, in
 * `@indx-workspace/contracts/agents` (`PI_TOOL_NAMES`, `PI_TOOL_PERMISSION`), because the control
 * plane names them too when it carries an engine switch's narrowing across
 * (`translatePolicyForEngineSwitch`) and `apps/web` may never import this package. `./boundary.ts`
 * hands {@link PiToolPlan.tools} to `createAgentSession({ tools })` as pi's own allowlist, so a tool
 * that is not in the plan is never declared to the model.
 *
 * ## The switches
 *
 * | Switch                | Tools                                              |
 * | --------------------- | -------------------------------------------------- |
 * | `readFiles`           | `read`                                             |
 * | `writeFiles`          | `write`, `edit`                                    |
 * | `runCommands`         | `bash` — omitted while a read-only grant exists    |
 * | `unrestrictedNetwork` | `networkEgress`: the sandbox's open network        |
 *
 * `bash` is withheld under a read-only grant for the reason the Claude and OpenAI adapters withhold
 * their shells: a redirect would write the file the grant protects, and no guard can tell a
 * redirect from a read. pi has no command-level allowlist, and none is invented here.
 */
import {
  PI_TOOL_NAMES,
  PI_TOOL_PERMISSION,
  type AgentPermissionKey,
  type AgentPermissions,
  type PiToolName,
} from '@indx-workspace/contracts/agents';
import type { AgentToolKind } from '@indx-workspace/contracts/run-events';
import { permissionToolPlan, toolPlanAllowsPermission } from '@agent-workspace/engine';

/** The neutral `agent.tool.call` kind of each pi tool (ENG-03). */
export const PI_TOOL_KIND: Readonly<Record<PiToolName, AgentToolKind>> = {
  read: 'read',
  write: 'edit',
  edit: 'edit',
  bash: 'execute',
};

/** The compiled tool set: the tools offered, and whether the run may reach the open network. */
export type PiToolPlan = {
  readonly tools: readonly PiToolName[];
  readonly networkEgress: boolean;
};

/** The tool plan for one run. `hasReadOnlyGrant` withholds `bash` (see the module header). */
export function piToolPlan(permissions: AgentPermissions, hasReadOnlyGrant: boolean): PiToolPlan {
  return permissionToolPlan(PI_TOOL_NAMES, PI_TOOL_PERMISSION, permissions, hasReadOnlyGrant);
}

/** The kind of a tool call pi reported, by the name the model called. */
export function piToolKind(name: string): AgentToolKind {
  return (PI_TOOL_KIND as Readonly<Record<string, AgentToolKind>>)[name] ?? 'other';
}

/** Does a compiled plan still allow what this switch governs? The conformance kit's `permissionAllowed`. */
export function piPlanAllowsPermission(plan: PiToolPlan, permission: AgentPermissionKey): boolean {
  return toolPlanAllowsPermission(plan, PI_TOOL_PERMISSION, permission);
}
