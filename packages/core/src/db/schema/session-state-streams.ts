/**
 * `session_state_streams` — one stream of engine session state (ENG-06, #305).
 *
 * ## Why new tables rather than renamed columns
 *
 * `session_transcripts` and `session_messages` are Claude-shaped in their keys, not only in their
 * names: both are keyed by `(workspace_id, project_key, session_id, subpath)`, where `project_key`
 * and `subpath` are two fields of the Agent SDK's own `SessionKey`. An engine that keys a
 * conversation by anything else — pi's per-session JSONL file, the OpenAI Agents SDK's flat item
 * list, an ACP agent's state directory — has nowhere to put its key.
 *
 * So the key becomes `(workspace_id, session_id, engine, stream_key)`: the tenant, the *platform's*
 * session row, which engine wrote the state, and one opaque adapter-defined string. The Claude
 * adapter's `stream_key` is `projectKey + '/' + subpath` (`''` for the main transcript), which is
 * the whole of its old key in the one field the platform promises not to interpret.
 *
 * The migration is **additive** (0026, ADR-0071): these tables are created and the existing Claude
 * rows are copied into them, and `session_transcripts` / `session_messages` stay exactly as they
 * are. A release that predates this migration keeps working against the old tables, which is what
 * `docs/adr/0069-*` asks of any migration a running deployment has to survive.
 *
 * ## `session_id` is the platform's session id, not the engine's
 *
 * `session_transcripts.session_id` holds the *engine's* session id, and the tenant-paired foreign
 * key to `sessions (id, workspace_id)` only holds because the two are equal for a Claude session:
 * the platform passes `sessions.id` as `Options.sessionId`, so the id the SDK reports back is the
 * row's own. No other engine promises that. These tables therefore key on `sessions.id` — the id
 * the run token's `sessionId` claim already carries, and the only one the foreign key can be about
 * — and `sessions.engine_session_id` stays the place the engine's own identity is recorded.
 *
 * The entry and blob tables are `./session-state-entries.ts` and `./session-state-blobs.ts`; this
 * directory keeps one module per table (`tenancy.test.ts` §27 inventory).
 */
import { foreignKey, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

import { engineIds } from './agents.js';
import { createdAt, updatedAt } from './columns.js';
import { oneOf } from './one-of.js';
import { sessions } from './sessions.js';
import { workspaces } from './workspaces.js';

/**
 * The longest `stream_key` and `blob_key` this store accepts.
 *
 * Bounded because both are adapter-defined and travel in a URL query. The platform reads neither,
 * so the only property it can hold about them is that they fit in an index entry. The bound is
 * enforced where the values arrive, by `apps/web/server/sessions/state.ts`; no CHECK repeats it,
 * because a row that reached the database already passed that parser.
 */
export const SESSION_STATE_KEY_MAX_LENGTH = 512;

/**
 * One stream of engine session state: an append-only list of entries under one opaque key.
 *
 * A row exists even when a stream holds no entries, for the reason `session_transcripts` already
 * carried one: `load()` must be able to tell an empty resumable session apart from a session that
 * was never stored, and only the first of those resumes.
 */
export const sessionStateStreams = pgTable(
  'session_state_streams',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** `sessions.id` — the platform's own row id. See this file's header. */
    sessionId: uuid('session_id').notNull(),
    /** Which engine wrote this state. Never inferred; the writer declares it and the API checks it. */
    engine: text('engine', { enum: engineIds }).notNull(),
    /** Adapter-defined and opaque. Claude: `projectKey` + `/` + `subpath`. */
    streamKey: text('stream_key').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.sessionId, table.engine, table.streamKey],
      name: 'session_state_streams_pkey',
    }),
    // Session state is durable state *of* a platform session, so the reference is tenant-paired:
    // `(session_id, workspace_id)` must name one `sessions` row, which makes attaching a stream to
    // another workspace's session impossible and makes session deletion clean every stream up.
    foreignKey({
      columns: [table.sessionId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.workspaceId],
      name: 'session_state_streams_session_workspace_fk',
    }).onDelete('cascade'),
    index('session_state_streams_workspace_updated_idx').on(table.workspaceId, table.updatedAt),
    oneOf('session_state_streams_engine_valid', table.engine, engineIds),
  ],
);

export type SessionStateStream = typeof sessionStateStreams.$inferSelect;
