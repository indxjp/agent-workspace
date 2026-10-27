/**
 * `builder_tool_calls` — the Builder's tool-call journal (builder design §04, issue #1845).
 *
 * One row per tool call of a run: what was asked, what the core decided and how it ended. The
 * failed-check limit counts these rows, so the count survives a retry and a second web server, and
 * every run can be replayed (design §08 Agent basics rule 8). A call is written once; a retry with
 * the same `(run_id, call_id)` keeps the first row.
 */
import { BUILDER_TOOL_NAMES, type BuilderToolName } from '@indx-workspace/contracts/builder';
import { index, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { createdAt, primaryKeyId } from './columns.js';
import { oneOf } from './one-of.js';
import { workspaces } from './workspaces.js';

/** The database's copy of the core's `BuilderDecision['kind']`; a type test holds the two equal. */
export const BUILDER_TOOL_CALL_DECISIONS = ['refuse', 'ask', 'run'] as const;

/** The database's copy of the core's journal outcomes; a type test holds the two equal. */
export const BUILDER_TOOL_CALL_OUTCOMES = ['ok', 'refused', 'check_failed', 'error'] as const;

export const builderToolCalls = pgTable(
  'builder_tool_calls',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    /** The engine's tool-use id. */
    callId: text('call_id').notNull(),
    /**
     * Narrowed by `$type`: drizzle's `enum` option wants a tuple, `BUILDER_TOOL_NAMES` is a list.
     * Null for a call to a tool that does not exist; a NULL passes the check below.
     */
    tool: text('tool').$type<BuilderToolName>(),
    decision: text('decision', { enum: BUILDER_TOOL_CALL_DECISIONS }).notNull(),
    outcome: text('outcome', { enum: BUILDER_TOOL_CALL_OUTCOMES }).notNull(),
    /** The refusal or check code. */
    code: text('code'),
    /** Capped at the tool-output limit, with a `truncated` marker. */
    inputJson: jsonb('input_json').notNull(),
    /** Written by the write tools for idempotent replay (B1); null for a read. */
    resultJson: jsonb('result_json'),
    traceId: text('trace_id').notNull(),
    modelId: text('model_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('builder_tool_calls_run_call_key').on(table.workspaceId, table.runId, table.callId),
    index('builder_tool_calls_run_created_idx').on(table.workspaceId, table.runId, table.createdAt),
    oneOf('builder_tool_calls_tool_valid', table.tool, BUILDER_TOOL_NAMES, { snake: true }),
    oneOf('builder_tool_calls_decision_valid', table.decision, BUILDER_TOOL_CALL_DECISIONS),
    oneOf('builder_tool_calls_outcome_valid', table.outcome, BUILDER_TOOL_CALL_OUTCOMES, {
      snake: true,
    }),
  ],
);

export type BuilderToolCall = typeof builderToolCalls.$inferSelect;
