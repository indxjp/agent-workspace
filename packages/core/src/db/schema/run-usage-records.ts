import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId } from './columns.js';
import { runs } from './runs.js';
import { workspaces } from './workspaces.js';

/**
 * The gateway dialects a usage row may name (ADR-0068 D5). One extractor per value, and the closed
 * set is carried both by the column's check constraint and by {@link WireProtocol}.
 */
export const wireProtocols = [
  'anthropic-messages',
  'openai-responses',
  'openai-chat-completions',
] as const;
export type WireProtocol = (typeof wireProtocols)[number];

/**
 * One retry-idempotent provider usage settlement.
 *
 * `price_table_version` is nullable (issue #134): a response captured while its model has no
 * catalogue entry is still recorded, at `cost_usd = '0'`, rather than dropped — the accounting
 * state on `runs` says the zero is unpriced, not measured. `price_table_version` and `cost_usd`
 * are the one pair a later, priced attempt for the **same** `provider_response_id` may update in
 * place ("a late arrival updates counters, cost and state"); the token counts, captured correctly
 * on first insert, are never rewritten.
 *
 * Keeping provider response ids beside the counters is what lets a delayed streaming usage frame
 * be retried without charging the run twice. Aggregated columns on `runs` remain the fast read
 * model; this table is the authoritative reconciliation ledger.
 */
export const runUsageRecords = pgTable(
  'run_usage_records',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull(),
    providerResponseId: text('provider_response_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadInputTokens: integer('cache_read_input_tokens').notNull().default(0),
    cacheCreationInputTokens: integer('cache_creation_input_tokens').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull(),
    costCurrency: text('cost_currency').notNull().default('USD'),
    /**
     * Which gateway dialect served this response (ADR-0068).
     *
     * `NOT NULL DEFAULT 'anthropic-messages'` on purpose: `migrate` runs at container start on Cloud
     * Run and Azure Container Apps, so a gateway pod from the previous release keeps inserting rows
     * that name no protocol while the column already exists. Rollback is a plain column drop, and no
     * backfill rewrites a token count.
     */
    wireProtocol: text('wire_protocol', { enum: wireProtocols })
      .notNull()
      .default('anthropic-messages'),
    /** NULL when this response was captured with no price catalogue entry for its model. */
    priceTableVersion: text('price_table_version'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('run_usage_records_response_unique').on(table.runId, table.providerResponseId),
    index('run_usage_records_workspace_run_idx').on(table.workspaceId, table.runId),
    foreignKey({
      columns: [table.runId, table.workspaceId],
      foreignColumns: [runs.id, runs.workspaceId],
      name: 'run_usage_records_run_workspace_fk',
    }).onDelete('cascade'),
    check(
      'run_usage_records_counters_non_negative',
      sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0 and ${table.cacheReadInputTokens} >= 0 and ${table.cacheCreationInputTokens} >= 0 and ${table.toolCalls} >= 0 and ${table.costUsd} >= 0`,
    ),
    check('run_usage_records_currency_usd', sql`${table.costCurrency} = 'USD'`),
    check(
      'run_usage_records_wire_protocol_known',
      // Rendered from `wireProtocols` so the constraint and the type cannot drift apart. `sql.raw`
      // is safe here and only here: every value is a compile-time literal of that `as const`.
      sql`${table.wireProtocol} in (${sql.raw(wireProtocols.map((value) => `'${value}'`).join(', '))})`,
    ),
  ],
);

export type RunUsageRecord = typeof runUsageRecords.$inferSelect;
export type NewRunUsageRecord = typeof runUsageRecords.$inferInsert;
