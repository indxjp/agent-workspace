/**
 * The tool-and-approval half of the compile step: the compiled tool policy with the workspace
 * write approvals folded in, the approval refusals, and the approval split the SDK options carry.
 *
 * Split out of `./compile.ts`; the behaviour is unchanged.
 */
import type { RunRequest } from '@agent-workspace/run-protocol';
import type { AgentToolPolicy } from '@indx-workspace/contracts/agents';

import { CLAUDE_APPROVABLE_TOOLS, splitApprovals, unapprovableRules } from './approval-rules.js';
import type { ClaudeApprovalGate } from './options.js';
import type { ClaudeRunPolicy } from './policy.js';
import {
  compileClaudeToolPolicy,
  claudeCommandApprovalRules,
  claudeWriteFilesApprovals,
  claudeWriteFilesDenials,
} from './tools.js';

type ParsedPolicy = ReturnType<typeof ClaudeRunPolicy.parse>;

/**
 * The Claude tool policy, compiled from the portable permissions, the stored arm, the grant
 * denials and the assigned connectors. `./tools.ts` documents the order, which is the surface
 * ENG-04b's refinement theorem is about.
 *
 * Write files lets the run write inside its workspace without a prompt nobody can answer. The
 * allow rule covers the whole workspace, so the files Claude Code loads as instructions on the
 * next run are denied beside it (a deny wins).
 */
export function compileToolsWithWriteApprovals(
  request: RunRequest,
  policy: ParsedPolicy,
): AgentToolPolicy {
  const { portable } = request;
  const compiledTools = compileClaudeToolPolicy(portable.permissions, {
    stored: policy.tools,
    fileGrantDeny: policy.fileGrantDeny,
    mcpServers: portable.mcpServers,
  });
  const writeApprovals = claudeWriteFilesApprovals(
    portable.permissions,
    compiledTools,
    policy.requireApproval,
    request.cwd,
  );
  const writeDenials = writeApprovals.length === 0 ? [] : claudeWriteFilesDenials(request.cwd);
  return {
    ...compiledTools,
    autoApprove: [...compiledTools.autoApprove, ...writeApprovals],
    deny: [...new Set([...compiledTools.deny, ...writeDenials])],
  };
}

/**
 * ADR-0145: a gated call must reach `canUseTool`, which only `default` mode consults for every
 * call. `bypassPermissions` and `dontAsk` never call it, and `acceptEdits` approves edits first,
 * so the call would run unapproved or be denied without ever asking.
 */
function assertApprovalNeedsDefaultMode(
  tools: AgentToolPolicy,
  requireApproval: readonly string[],
): void {
  if (requireApproval.length > 0 && tools.permissionMode !== 'default') {
    throw new Error(
      `requireApproval needs permissionMode 'default', but this policy uses '${tools.permissionMode}', which would run or deny a gated call without asking. Set the stored policy's permissionMode to 'default' or remove requireApproval.`,
    );
  }
}

function assertApprovalRulesGateable(requireApproval: readonly string[]): void {
  const unasked = unapprovableRules(requireApproval);
  if (unasked.length > 0) {
    throw new Error(
      `requireApproval cannot gate ${unasked.map((rule) => JSON.stringify(rule)).join(', ')}: the SDK runs that tool without calling canUseTool, or Claude Code's permission rules cannot match that connector glob, so the call could run unapproved. Gate only ${CLAUDE_APPROVABLE_TOOLS.join(', ')}, an exact connector tool (mcp__<server>__<tool>) or a whole server (mcp__<server>__*).`,
    );
  }
}

/** What the run's approval split decided: the allow list, and the gate when anything is gated. */
export type CompiledApprovals = {
  readonly allowedTools: readonly string[];
  readonly gate: ClaudeApprovalGate | null;
};

/** Refuses an ungateable `requireApproval`, then splits the allow list from the gated rules. */
export function compileApprovals(
  request: RunRequest,
  policy: ParsedPolicy,
  tools: AgentToolPolicy,
): CompiledApprovals {
  assertApprovalNeedsDefaultMode(tools, policy.requireApproval);
  assertApprovalRulesGateable(policy.requireApproval);
  const split = splitApprovals(tools.autoApprove, policy.requireApproval);
  // #2091: Run commands asks about a command Claude Code would otherwise refuse. Not split against
  // `autoApprove`: an allowed command keeps running without asking (see the function).
  const gated = [
    ...policy.requireApproval,
    ...claudeCommandApprovalRules(request.portable.permissions, tools, policy.requireApproval),
  ];
  return {
    allowedTools: split.allowedTools,
    gate:
      gated.length === 0
        ? null
        : {
            requireApproval: gated,
            deferred: split.deferred,
            approvedToolCalls: policy.approvedToolCalls,
            ask: policy.requireApproval,
          },
  };
}
