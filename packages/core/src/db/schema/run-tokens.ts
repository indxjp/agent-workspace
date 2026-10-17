import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId } from './columns.js';
import { runs } from './runs.js';
import { workspaces } from './workspaces.js';

/** Issued gateway tokens. Only a digest is retained; the bearer value is never stored. */
export const runTokens = pgTable(
  'run_tokens',
  {
    id: primaryKeyId(),
    runId: uuid('run_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.runId, table.workspaceId],
      foreignColumns: [runs.id, runs.workspaceId],
      name: 'run_tokens_run_workspace_fk',
    }).onDelete('cascade'),
    uniqueIndex('run_tokens_hash_key').on(table.tokenHash),
    index('run_tokens_workspace_run_idx').on(table.workspaceId, table.runId),
    index('run_tokens_active_idx').on(
      table.workspaceId,
      table.runId,
      table.revokedAt,
      table.expiresAt,
    ),
    check('run_tokens_expiry_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'run_tokens_revoked_after_created',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export type RunToken = typeof runTokens.$inferSelect;
