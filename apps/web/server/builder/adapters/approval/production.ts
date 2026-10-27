import { canonicalCall } from '@indx-workspace/contracts/agents';
import { AW_CONTROL_SERVER } from '@indx-workspace/contracts/builder';

import type { ApprovalPort, ApprovalRequest } from '../../ports';

/**
 * The text the gateway's backstop looks for in `runs.approved_tool_calls` (`awControlApprovalDecision`):
 * the same `canonicalCall` over the prefixed tool name and the raw arguments, `{}` when there are none.
 * `null` when the arguments are not JSON, which no approval ever covers.
 */
export function approvedCallText(call: ApprovalRequest): string | null {
  try {
    return canonicalCall(`mcp__${AW_CONTROL_SERVER}__${call.tool}`, call.arguments ?? {});
  } catch {
    return null;
  }
}

/** The slice of the database the port reads, generic over the scope type; a `DatabaseRoot` satisfies it. */
export interface ApprovalDependencies<Scope> {
  readonly scopes: { forWorkspaceId(workspaceId: string): Promise<Scope | null> };
  readonly runs: {
    forScope(scope: Scope): {
      get(runId: string): Promise<{
        readonly approvedToolCalls?: readonly { readonly canonicalCall: string }[];
      } | null>;
    };
  };
}

/**
 * `ApprovalPort` over the record the gateway's backstop consumes: the run's own `approved_tool_calls`,
 * read in the call's workspace, so another workspace's run is never found. It writes nothing and uses
 * nothing up; the backstop consumes the call before the request reaches the Builder.
 */
export function createApproval<Scope>(deps: ApprovalDependencies<Scope>): ApprovalPort {
  return {
    async status(ctx, call) {
      const text = approvedCallText(call);
      if (text === null) return 'missing';
      const scope = await deps.scopes.forWorkspaceId(ctx.workspaceId);
      if (scope === null) return 'missing';
      const run = await deps.runs.forScope(scope).get(ctx.runId);
      return run?.approvedToolCalls?.some((approved) => approved.canonicalCall === text) === true
        ? 'granted'
        : 'missing';
    },
  };
}
