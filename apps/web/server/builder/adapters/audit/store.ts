import {
  UnknownWorkspaceError,
  type BuilderToolCallRepositoryProvider,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { replayOf, tallyRun } from '../../core/facts';
import type { AuditPort } from '../../ports';
import { bounded, inputDigest } from './bounded';

export interface AuditDeps {
  readonly repositories: BuilderToolCallRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
}

/** The journal on PostgreSQL. The run counts are core's `tallyRun` over the run's rows. */
export function createAudit(deps: AuditDeps): AuditPort {
  async function repository(workspaceId: string) {
    const scope = await deps.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new UnknownWorkspaceError(workspaceId);
    return deps.repositories.forScope(scope);
  }

  return {
    async runCounts(ctx) {
      return tallyRun(await (await repository(ctx.workspaceId)).listForRun(ctx.runId));
    },
    async record(ctx, entry) {
      return (await repository(ctx.workspaceId)).record({
        runId: ctx.runId,
        callId: entry.callId,
        tool: entry.tool,
        decision: entry.decision,
        outcome: entry.outcome,
        code: entry.code,
        // The input column is NOT NULL, and an unparsed call may carry no input at all.
        inputJson: bounded(entry.input, {}, inputDigest(entry.tool)),
        resultJson: bounded(entry.result, null),
        traceId: ctx.traceId,
        modelId: ctx.modelId,
        promptVersion: ctx.promptVersion,
      });
    },
    async replay(ctx, callId, tool) {
      const row = await (await repository(ctx.workspaceId)).findCall(ctx.runId, callId);
      return row === null ? null : replayOf({ ...row, result: row.resultJson }, tool);
    },
    async spentInputs(ctx, tool) {
      return (await repository(ctx.workspaceId)).listSpentInputs(ctx.runId, tool);
    },
  };
}
