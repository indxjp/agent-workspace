/**
 * `endpoint_clients` — what an external agent platform may reach
 * (ADR-0134). A client names exactly one resource: an MCP project tool endpoint, one agent's
 * A2A endpoint, or the Builder's MCP door (`builder`, no agent). Credentials are bound to a client (`endpoint_client_api_keys`), never
 * free-floating, so revoking the client revokes everything that could reach the resource.
 *
 * `acts_for_principal_id` is the membership principal that created the client. A credential bound
 * to the client acts for that member, the same acts-for mechanism ADR-0105's surface publisher uses.
 */
import {
  ENDPOINT_CLIENT_KINDS,
  type EndpointClientKind,
} from '@indx-workspace/contracts/endpoint-clients';
import {
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { oneOf } from './one-of.js';
import { workspacePrincipals } from './workspace-principals.js';
import { workspaces } from './workspaces.js';

/** The kinds live in contracts and the CHECK below derives from them, as `audit-events.ts` does. */
export type { EndpointClientKind };

export const endpointClients = pgTable(
  'endpoint_clients',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** For `mcp-project` the project name in `/mcp/projects/{name}`; for `a2a-agent` the agent name; for `builder` a label. */
    name: text('name').notNull(),
    kind: text('kind', { enum: ENDPOINT_CLIENT_KINDS }).notNull(),
    /** `mcp-project` only: tool-name allow-list. NULL means every code tool of the listed agents. */
    toolNames: text('tool_names').array(),
    actsForPrincipalId: uuid('acts_for_principal_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    /** SHA-256 hex of the OAuth client secret (ADR-0134 part 3); NULL is a public client. */
    clientSecretHash: text('client_secret_hash'),
    /** OAuth redirect URIs, compared as exact strings. */
    redirectUris: text('redirect_uris')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    clientSecretRotatedAt: timestamp('client_secret_rotated_at', {
      withTimezone: true,
      mode: 'date',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('endpoint_clients_workspace_id_key').on(table.workspaceId, table.id),
    uniqueIndex('endpoint_clients_workspace_kind_name_key').on(
      table.workspaceId,
      table.kind,
      table.name,
    ),
    foreignKey({
      columns: [table.workspaceId, table.actsForPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'endpoint_clients_acts_for_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.createdByPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'endpoint_clients_created_by_workspace_fk',
    }).onDelete('cascade'),
    oneOf('endpoint_clients_kind_valid', table.kind, ENDPOINT_CLIENT_KINDS),
    check(
      'endpoint_clients_tool_names_mcp_only',
      sql`${table.toolNames} is null or ${table.kind} = 'mcp-project'`,
    ),
    check('endpoint_clients_redirect_uris_max', sql`cardinality(${table.redirectUris}) <= 10`),
    check(
      'endpoint_clients_revoked_after_created',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export type EndpointClient = typeof endpointClients.$inferSelect;
export type NewEndpointClient = typeof endpointClients.$inferInsert;
