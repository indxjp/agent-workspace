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
import { sessionTranscripts } from './session-transcripts.js';
import { workspaces } from './workspaces.js';

/**
 * Append-only transcript deliveries. A repeated SDK entry UUID gets a new sequence while retaining
 * its original position; reads fold the latest delivery into that position. This keeps retries
 * idempotent without rewriting a whole transcript or mutating historical deliveries.
 */
export const sessionMessages = pgTable(
  'session_messages',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectKey: text('project_key').notNull(),
    sessionId: uuid('session_id').notNull(),
    subpath: text('subpath').notNull().default(''),
    sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
    /** First-delivery sequence. Redeliveries retain it so load order never changes. */
    position: bigint('position', { mode: 'bigint' }).notNull(),
    entryUuid: text('entry_uuid'),
    entry: jsonb('entry').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.projectKey,
        table.sessionId,
        table.subpath,
        table.sequence,
      ],
      name: 'session_messages_pkey',
    }),
    foreignKey({
      columns: [table.workspaceId, table.projectKey, table.sessionId, table.subpath],
      foreignColumns: [
        sessionTranscripts.workspaceId,
        sessionTranscripts.projectKey,
        sessionTranscripts.sessionId,
        sessionTranscripts.subpath,
      ],
      name: 'session_messages_transcript_fk',
    }).onDelete('cascade'),
    index('session_messages_key_sequence_idx').on(
      table.workspaceId,
      table.projectKey,
      table.sessionId,
      table.subpath,
      table.sequence,
    ),
    index('session_messages_key_uuid_idx').on(
      table.workspaceId,
      table.projectKey,
      table.sessionId,
      table.subpath,
      table.entryUuid,
      table.sequence,
    ),
  ],
);

export type SessionMessage = typeof sessionMessages.$inferSelect;
