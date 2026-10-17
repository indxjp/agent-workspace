/**
 * The permission → tool plan every withholding adapter computes (#951).
 *
 * An engine names its tools, the contracts map each tool to the portable switch that governs it, and
 * the plan is the tools whose switch is on. A read-only grant withholds every `runCommands` tool: a
 * shell redirect would write the file the grant protects, and no guard can tell a redirect from a
 * read.
 */
import type { AgentPermissionKey, AgentPermissions } from '@indx-workspace/contracts/agents';

/** Tools whose switch is on, in `names` order; every `runCommands` tool withheld while a read-only grant exists. */
export function permissionToolPlan<const T extends string>(
  names: readonly T[],
  permissionOf: Readonly<Record<T, AgentPermissionKey>>,
  permissions: AgentPermissions,
  hasReadOnlyGrant: boolean,
): { readonly tools: readonly T[]; readonly networkEgress: boolean } {
  const tools = names.filter((name) => {
    const permission = permissionOf[name];
    if (!permissions[permission]) return false;
    return !(permission === 'runCommands' && hasReadOnlyGrant);
  });
  return { tools, networkEgress: permissions.unrestrictedNetwork };
}

/** Does a compiled plan still allow what this switch governs? */
export function toolPlanAllowsPermission<T extends string>(
  plan: { readonly tools: readonly T[]; readonly networkEgress: boolean },
  permissionOf: Readonly<Record<T, AgentPermissionKey>>,
  permission: AgentPermissionKey,
): boolean {
  if (permission === 'unrestrictedNetwork') return plan.networkEgress;
  return plan.tools.some((name) => permissionOf[name] === permission);
}
