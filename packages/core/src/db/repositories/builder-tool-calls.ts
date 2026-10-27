import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { builderToolCalls, type BuilderToolCall } from '../schema/builder-tool-calls.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

/** One call to journal; the workspace comes from the scope. */
type NewBuilderToolCall = Pick<
  BuilderToolCall,
  | 'runId'
  | 'callId'
  | 'tool'
  | 'decision'
  | 'outcome'
  | 'code'
  | 'inputJson'
  | 'resultJson'
  | 'traceId'
  | 'modelId'
  | 'promptVersion'
>;

interface BuilderToolCallRepository {
  /**
   * Keeps the first row for a `(runId, callId)`; a later `ok` of the same tool replaces an `error`
   * row, nothing else. Answers whether a row was inserted or replaced.
   */
  record(call: NewBuilderToolCall): Promise<boolean>;
  /** The run's calls, oldest first, as far as the failed-check count needs them. */
  listForRun(runId: string): Promise<readonly Pick<BuilderToolCall, 'tool' | 'outcome'>[]>;
  /** The inputs of the run's calls of `tool` that wrote or may have written (`ok` or `error`), as journaled. */
  listSpentInputs(
    runId: string,
    tool: NonNullable<BuilderToolCall['tool']>,
  ): Promise<readonly unknown[]>;
  /** The journaled row of a `(runId, callId)`, or `null`. */
  findCall(
    runId: string,
    callId: string,
  ): Promise<Pick<BuilderToolCall, 'tool' | 'outcome' | 'resultJson'> | null>;
}

export interface BuilderToolCallRepositoryProvider {
  forScope(scope: WorkspaceScope): BuilderToolCallRepository;
}

export function createDatabaseBuilderToolCallRepositoryProvider(
  db: Database,
): BuilderToolCallRepositoryProvider {
  return {
    forScope(scope) {
      const checked = requireWorkspaceScope(scope, 'BuilderToolCallRepositoryProvider');
      return {
        async record(call) {
          const target = [
            builderToolCalls.workspaceId,
            builderToolCalls.runId,
            builderToolCalls.callId,
          ];
          const insert = db
            .insert(builderToolCalls)
            .values({ ...call, workspaceId: checked.workspaceId });
          // A success replaces an earlier `error` row of the same call and tool, so a retry after a
          // transient failure still replays; every other row stays the first one.
          const written = await (
            call.outcome === 'ok' && call.tool !== null
              ? insert.onConflictDoUpdate({
                  target,
                  set: {
                    decision: call.decision,
                    outcome: call.outcome,
                    code: call.code,
                    inputJson: call.inputJson,
                    resultJson: call.resultJson,
                  },
                  setWhere: sql`${builderToolCalls.outcome} = 'error' AND ${builderToolCalls.tool} = ${call.tool}`,
                })
              : insert.onConflictDoNothing({ target })
          ).returning({ id: builderToolCalls.id });
          return written.length > 0;
        },
        // ponytail: orders by created_at then id; two calls in one microsecond could swap. Calls of a
        // run are sequential, so add a sequence column only if a tie is ever seen.
        listForRun(runId) {
          return db
            .select({ tool: builderToolCalls.tool, outcome: builderToolCalls.outcome })
            .from(builderToolCalls)
            .where(
              and(
                eq(builderToolCalls.workspaceId, checked.workspaceId),
                eq(builderToolCalls.runId, runId),
              ),
            )
            .orderBy(asc(builderToolCalls.createdAt), asc(builderToolCalls.id));
        },
        async listSpentInputs(runId, tool) {
          const rows = await db
            .select({ inputJson: builderToolCalls.inputJson })
            .from(builderToolCalls)
            .where(
              and(
                eq(builderToolCalls.workspaceId, checked.workspaceId),
                eq(builderToolCalls.runId, runId),
                eq(builderToolCalls.tool, tool),
                inArray(builderToolCalls.outcome, ['ok', 'error']),
              ),
            );
          return rows.map((row) => row.inputJson);
        },
        async findCall(runId, callId) {
          const [row] = await db
            .select({
              tool: builderToolCalls.tool,
              outcome: builderToolCalls.outcome,
              resultJson: builderToolCalls.resultJson,
            })
            .from(builderToolCalls)
            .where(
              and(
                eq(builderToolCalls.workspaceId, checked.workspaceId),
                eq(builderToolCalls.runId, runId),
                eq(builderToolCalls.callId, callId),
              ),
            );
          return row ?? null;
        },
      };
    },
  };
}
