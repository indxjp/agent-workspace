/**
 * `session_state_blobs` — a snapshot of an engine's own state directory (ENG-06, #305).
 *
 * `./session-state-streams.ts` carries the header for the three tables: why the store is keyed by
 * `(workspace_id, session_id, engine, …)`, why `session_id` is the platform's session id rather than
 * the engine's, and what bounds `blob_key` (`SESSION_STATE_KEY_MAX_LENGTH`).
 */
import { bigint, foreignKey, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

import { engineIds } from './agents.js';
import { createdAt, updatedAt } from './columns.js';
import { fileStatuses } from './files.js';
import { oneOf } from './one-of.js';
import { sessions } from './sessions.js';
import { workspaces } from './workspaces.js';

/**
 * One opaque blob of engine session state — an ACP agent's state directory, snapshotted.
 *
 * The bytes live in the object store (`packages/core/src/storage`), not in a column: a snapshot is
 * measured in megabytes and a `bytea` that size makes every row read of this table expensive. What
 * is stored here is where the bytes are and what they were, so a read can prove it got the bytes it
 * recorded rather than whatever is at that key now.
 */
export const sessionStateBlobs = pgTable(
  'session_state_blobs',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    engine: text('engine', { enum: engineIds }).notNull(),
    /** Adapter-defined and opaque, exactly like `stream_key`. */
    blobKey: text('blob_key').notNull(),
    /** The workspace-relative object-store key the bytes are at. Derived, never caller-supplied. */
    storageKey: text('storage_key').notNull(),
    /** The permanent object ID (the storage design, §04); `null` for a blob written before object IDs, whose bytes are at `storage_key`. */
    objectId: uuid('object_id'),
    /** `ready` is the only status a read serves; `pending` and `deleting` are for the save and cleanup steps. */
    status: text('status', { enum: fileStatuses }).notNull().default('ready'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** Lower-case hex SHA-256 of the stored bytes, so a read can verify what it was handed. */
    sha256: text('sha256').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.sessionId, table.engine, table.blobKey],
      name: 'session_state_blobs_pkey',
    }),
    foreignKey({
      columns: [table.sessionId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.workspaceId],
      name: 'session_state_blobs_session_workspace_fk',
    }).onDelete('cascade'),
    index('session_state_blobs_workspace_updated_idx').on(table.workspaceId, table.updatedAt),
    oneOf('session_state_blobs_engine_valid', table.engine, engineIds),
    oneOf('session_state_blobs_status_valid', table.status, fileStatuses),
  ],
);

export type SessionStateBlob = typeof sessionStateBlobs.$inferSelect;
