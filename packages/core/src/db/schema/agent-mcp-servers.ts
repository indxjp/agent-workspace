/**
 * `agent_mcp_servers` — which connectors an agent may call (spec §8, §17 Step 3, §27).
 *
 * This is also the only route by which a secret reaches a runtime in this wave. §23 says "The
 * runtime receives only the secrets required by that particular agent"; the set of secrets an
 * agent requires is derived by joining this table to `mcp_servers.credential_secret_id`, which
 * is why there is no `agent_secrets` table here and none in §27. What that does not cover is
 * declared as a gap on this task's pull request rather than pre-built.
 *
 * Like `agent_skills`, a link is created or removed and never edited, so there is no
 * `updated_at`.
 */
import { foreignKey, index, pgTable, unique, uuid } from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { createdAt, primaryKeyId } from './columns.js';
import { mcpServers } from './mcp-servers.js';
import { workspaces } from './workspaces.js';

export const agentMcpServers = pgTable(
  'agent_mcp_servers',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `agent_mcp_servers_agent_workspace_fk`. */
    agentId: uuid('agent_id').notNull(),
    /** Tenant-paired below as `agent_mcp_servers_server_workspace_fk`. */
    mcpServerId: uuid('mcp_server_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('agent_mcp_servers_workspace_agent_server_key').on(
      table.workspaceId,
      table.agentId,
      table.mcpServerId,
    ),
    // "Which agents use this connector" — the direction the unique key above cannot serve, and
    // the one a connector's detail page asks.
    index('agent_mcp_servers_server_idx').on(table.mcpServerId),
    foreignKey({
      columns: [table.agentId, table.workspaceId],
      foreignColumns: [agents.id, agents.workspaceId],
      name: 'agent_mcp_servers_agent_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.mcpServerId, table.workspaceId],
      foreignColumns: [mcpServers.id, mcpServers.workspaceId],
      name: 'agent_mcp_servers_server_workspace_fk',
    }).onDelete('cascade'),
  ],
);

export type AgentMcpServer = typeof agentMcpServers.$inferSelect;
export type NewAgentMcpServer = typeof agentMcpServers.$inferInsert;
