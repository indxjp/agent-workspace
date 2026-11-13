import { canonicalCall, needsApproval } from '@indx-workspace/contracts/agents';

import type { ClaudeApprovalGate } from './options.js';

/** The call a run stopped on. The tool's arguments appear only in `canonicalCall`, never in a message. */
export type ApprovalRequest = {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly canonicalCall: string;
};

/**
 * What the approval gate remembers about one run. `consumed` holds single use within this
 * execution; across executions the control plane holds it, by stamping the continuation's approvals
 * consumed when the run starts and never queueing it again (ADR-0151). The gateway keeps its own
 * durable record per call (`runs.consumed_tool_calls`, ADR-0145 D2.1), because it runs the write.
 */
export type ApprovalState = {
  readonly consumed: Set<string>;
  request: ApprovalRequest | null;
  /**
   * The calls `canUseTool` refused because no rule allows them, not yet reported. Without
   * `canUseTool` the SDK refuses such a call itself and says so in a `system/permission_denied`
   * message, which the console shows (#2207); with it, the SDK says nothing, so the run reports
   * these in that same shape (`./boundary.ts`, `deniedEvents`).
   */
  readonly denied: DeniedCall[];
};

/** A call refused by the tool policy inside `canUseTool`. */
type DeniedCall = {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly message: string;
};

export type PermissionDecision =
  | { readonly behavior: 'allow'; readonly updatedInput: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string; readonly interrupt?: true };

/**
 * `canUseTool`, as a pure decision (ADR-0145 D2.1, D5). Only reached for a call no `allowedTools`
 * rule or `disallowedTools` rule already settled.
 *
 * A gated call runs only when its exact canonical text was approved, and each approval is good for
 * one call. A gated call that is not approved records itself and denies with `interrupt`, which ends
 * the run; the first one wins, because the model may issue several in one turn. A call to a tool the
 * gate does not name is denied, except for the `deferred` auto-approvals `splitApprovals` moved out of
 * `allowedTools`, which are allowed here — unscoped ones only: this decision reads the tool name, so a
 * scoped rule such as `Edit(//ws/**)` allowing here would allow the tool over every path.
 */
export function decideToolPermission(
  gate: ClaudeApprovalGate,
  state: ApprovalState,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
): PermissionDecision {
  if (!needsApproval(gate.requireApproval, toolName)) {
    const unscoped = gate.deferred.filter((rule) => !rule.includes('('));
    if (needsApproval(unscoped, toolName)) return { behavior: 'allow', updatedInput: input };
    const message = `${toolName} is not allowed by this agent's tool policy.`;
    state.denied.push({ toolName, toolUseId, message });
    return { behavior: 'deny', message };
  }
  let call: string;
  try {
    call = canonicalCall(toolName, input);
  } catch {
    return {
      behavior: 'deny',
      message: `approval_required: the arguments of ${toolName} are not JSON, so the call cannot be approved.`,
    };
  }
  if (gate.approvedToolCalls.includes(call)) {
    if (state.consumed.has(call)) {
      return {
        behavior: 'deny',
        message: `approval_already_used: the approval for this ${toolName} call was already used.`,
      };
    }
    state.consumed.add(call);
    return { behavior: 'allow', updatedInput: input };
  }
  if (gate.approvedToolCalls.length > 0) {
    return {
      behavior: 'deny',
      message: `approval_call_mismatch: ${toolName} was called with arguments nobody approved.`,
    };
  }
  state.request ??= { toolName, toolUseId, canonicalCall: call };
  return {
    behavior: 'deny',
    interrupt: true,
    message: `approval_required: ${toolName} needs a person's approval before it runs.`,
  };
}
