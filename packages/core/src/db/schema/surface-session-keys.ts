/**
 * `surface_session_keys` — issue #538 (S2-05b, C18, ADR-0105): the resume key of one hosted
 * surface session, so a visitor who reloads the page continues the same conversation.
 *
 * Modelled on `browser-tokens.ts`'s precedent — a stored SHA-256 digest of the key, never the key
 * itself — keyed by the session it resumes, because a session has at most one key. The surface
 * and the agent it was issued for are recorded so a key resumes only the session of the
 * (surface, agent) it was issued for. Both references are tenant-paired, so a key cannot name a
 * session or an agent of another workspace, and both cascade: a key is worthless without them.
 */
import { foreignKey, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { createdAt } from './columns.js';
import { sessions } from './sessions.js';
import { workspaces } from './workspaces.js';

export const surfaceSessionKeys = pgTable(
  'surface_session_keys',
  {
    sessionId: uuid('session_id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The surface's name-key; `isSurfaceName` validated it before any write. */
    surfaceName: text('surface_name').notNull(),
    agentId: uuid('agent_id').notNull(),
    keyHash: text('key_hash').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.sessionId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.workspaceId],
      name: 'surface_session_keys_session_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.agentId, table.workspaceId],
      foreignColumns: [agents.id, agents.workspaceId],
      name: 'surface_session_keys_agent_workspace_fk',
    }).onDelete('cascade'),
    index('surface_session_keys_workspace_idx').on(table.workspaceId),
  ],
);
