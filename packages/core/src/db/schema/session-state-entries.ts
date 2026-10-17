/**
 * `session_state_entries` — one entry of one engine session state stream (ENG-06, #305).
 *
 * `./session-state-streams.ts` carries the header for the three tables: why the store is keyed by
 * `(workspace_id, session_id, engine, stream_key)` and why `session_id` is the platform's session
 * id rather than the engine's.
 *
 * ## `entry_key` is nullable, and the unique index still says the right thing
 *
 * `entry_key` is the idempotency key: Claude's entry `uuid`, pi's entry `id`. R-01 §7 records that
 * the Agent SDK's retries can redeliver a batch, so an append must upsert on it — and that entries
 * *without* one (titles, tags, mode markers) are appended without dedup. A `NOT NULL` column would
 * force the store to invent a key for those, and an invented key is an idempotency claim about an
 * entry that has no identity.
 *
 * So the column is nullable, and the unique index over it needs no predicate: PostgreSQL treats
 * NULLs as **distinct** in a unique index by default, so one key means one row and any number of
 * keyless rows are admitted.
 */
import {
  bigint,
  foreignKey,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { engineIds } from './agents.js';
import { createdAt } from './columns.js';
import { oneOf } from './one-of.js';
import { sessionStateStreams } from './session-state-streams.js';
import { workspaces } from './workspaces.js';

/**
 * One entry of one stream, stored verbatim.
 *
 * `sequence` is the stream's order and is dense from 1 within a stream: `replace-all` rewrites it
 * from 1, and `delete-last` removes the highest. The platform reads no field of `entry` — an
 * engine owns its own state format, and a validator that dropped an unrecognised field would
 * silently corrupt a resume.
 */
export const sessionStateEntries = pgTable(
  'session_state_entries',
  {
    // The single-column root reference every tenant-scoped table carries, beside the composite key
    // to its stream. `packages/core/src/db/schema/tenancy.test.ts` rule 1 requires exactly one of
    // these on a scoped table, and it is what makes a deleted workspace take its state with it even
    // if a stream row were ever orphaned.
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    engine: text('engine', { enum: engineIds }).notNull(),
    streamKey: text('stream_key').notNull(),
    /**
     * `mode: 'number'`, unlike `session_messages.sequence`'s `bigint`.
     *
     * The column is a PostgreSQL `bigint` either way; what differs is the JavaScript value the
     * driver hands back. Every sequence this store issues is `count + 1` of one stream's entries, so
     * the values live in the low thousands and are exactly representable — and a plain number is
     * what lets a cursor travel in a URL query without a decimal-string codec on both sides.
     */
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    /** The idempotency key, or NULL for an entry the engine gave no identity. */
    entryKey: text('entry_key'),
    entry: jsonb('entry').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.sessionId, table.engine, table.streamKey, table.sequence],
      name: 'session_state_entries_pkey',
    }),
    foreignKey({
      columns: [table.workspaceId, table.sessionId, table.engine, table.streamKey],
      foreignColumns: [
        sessionStateStreams.workspaceId,
        sessionStateStreams.sessionId,
        sessionStateStreams.engine,
        sessionStateStreams.streamKey,
      ],
      name: 'session_state_entries_stream_fk',
    }).onDelete('cascade'),
    // The idempotency constraint, and it needs no `WHERE entry_key IS NOT NULL` to be the right
    // one: PostgreSQL treats NULLs as **distinct** in a unique index by default, so this refuses a
    // second row for a key the stream already has and admits any number of rows that carry no key
    // at all — which is exactly what R-01 §7 asks for an entry with no identity to dedup on. A
    // partial index would say the same thing and would additionally be a partial index, which the
    // ER model records as a shape of its own.
    uniqueIndex('session_state_entries_key_unique').on(
      table.workspaceId,
      table.sessionId,
      table.engine,
      table.streamKey,
      table.entryKey,
    ),
    oneOf('session_state_entries_engine_valid', table.engine, engineIds),
  ],
);

export type SessionStateEntry = typeof sessionStateEntries.$inferSelect;
