import {
  bigint,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt } from './columns.js';
import { runs } from './runs.js';
import { workspaces } from './workspaces.js';

/** Durable, ordered SSE events for one run. Sequence numbers are contiguous per run. */
export const runEvents = pgTable(
  'run_events',
  {
    runId: uuid('run_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
    type: text('type').notNull(),
    data: jsonb('data').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sequence], name: 'run_events_pkey' }),
    foreignKey({
      columns: [table.runId, table.workspaceId],
      foreignColumns: [runs.id, runs.workspaceId],
      name: 'run_events_run_workspace_fk',
    }).onDelete('cascade'),
    index('run_events_workspace_sequence_idx').on(table.workspaceId, table.runId, table.sequence),
    // No separate (run_id, sequence) index: `run_events_pkey` is that index already.
  ],
);

export type RunEvent = typeof runEvents.$inferSelect;
