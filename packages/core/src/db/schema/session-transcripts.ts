import { foreignKey, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { createdAt } from './columns.js';
import { sessions } from './sessions.js';
import { workspaces } from './workspaces.js';

/**
 * One durable SDK transcript key. A row exists even when the SDK appends an empty batch, because
 * `load()` must distinguish an empty resumable session from a session that was never stored.
 */
export const sessionTranscripts = pgTable(
  'session_transcripts',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectKey: text('project_key').notNull(),
    sessionId: uuid('session_id').notNull(),
    /** The empty string is the database representation of the main transcript. */
    subpath: text('subpath').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.projectKey, table.sessionId, table.subpath],
      name: 'session_transcripts_pkey',
    }),
    // A transcript is durable state *of* a platform session, not an independently-owned blob.
    // The tenant-paired FK prevents attaching it to another workspace and makes session/agent
    // deletion clean up every main and subagent transcript through the existing message cascade.
    foreignKey({
      columns: [table.sessionId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.workspaceId],
      name: 'session_transcripts_session_workspace_fk',
    }).onDelete('cascade'),
    index('session_transcripts_workspace_updated_idx').on(table.workspaceId, table.updatedAt),
    index('session_transcripts_project_updated_idx').on(table.projectKey, table.updatedAt),
  ],
);

export type SessionTranscript = typeof sessionTranscripts.$inferSelect;
