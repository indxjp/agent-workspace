/**
 * `agent_files` — which files or folders an agent sees, and how (spec §16, §17 Step 3, §27).
 *
 * §16's list of what the UI must allow ends with two items this table carries and the other two
 * join tables do not: "assign folders/files to an agent" and "read-only or read-write access".
 * `access` is that second one, and it is the reason this table has an `updated_at` where
 * `agent_skills` and `agent_mcp_servers` do not — a grant can be narrowed or widened in place,
 * so there is something for the timestamp to record.
 *
 * The referenced row may be a folder, which is why the reference is to `files` rather than to
 * a file-only subset: `files.kind` already distinguishes the two, and §16 assigns either.
 */
import { foreignKey, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { files } from './files.js';
import { oneOf } from './one-of.js';
import { workspaces } from './workspaces.js';

/** §16's "read-only or read-write access", as the two values it names. */
export const fileAccessModes = ['read', 'read-write'] as const;
export type FileAccessMode = (typeof fileAccessModes)[number];

export const agentFiles = pgTable(
  'agent_files',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `agent_files_agent_workspace_fk`. */
    agentId: uuid('agent_id').notNull(),
    /** Tenant-paired below as `agent_files_file_workspace_fk`. May name a folder. */
    fileId: uuid('file_id').notNull(),
    /**
     * No database default. §17 Step 4 already refuses to guess an agent's permissions; the
     * same argument applies one level down — a grant whose breadth nobody chose is a grant
     * whose blast radius nobody chose.
     */
    access: text('access', { enum: fileAccessModes }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One grant per (agent, file): changing the breadth is an UPDATE of `access`, not a second
    // row that would leave two grants disagreeing about what the agent may do.
    unique('agent_files_workspace_agent_file_key').on(
      table.workspaceId,
      table.agentId,
      table.fileId,
    ),
    // "Which agents can see this file" — what a file's detail panel asks.
    index('agent_files_file_idx').on(table.fileId),
    foreignKey({
      columns: [table.agentId, table.workspaceId],
      foreignColumns: [agents.id, agents.workspaceId],
      name: 'agent_files_agent_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.fileId, table.workspaceId],
      foreignColumns: [files.id, files.workspaceId],
      name: 'agent_files_file_workspace_fk',
    }).onDelete('cascade'),
    oneOf('agent_files_access_valid', table.access, fileAccessModes),
  ],
);

export type AgentFile = typeof agentFiles.$inferSelect;
export type NewAgentFile = typeof agentFiles.$inferInsert;
