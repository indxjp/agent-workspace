/**
 * `mcp_servers` — one configured MCP connector (spec §8, §27).
 *
 * §8 prints the three transports the Agent SDK supports, as JSON, and the connector wizard as a
 * form. The columns below are that form, one column per field, rather than the JSON:
 *
 * ```text            ```json
 * Name               { "command": "npx", "args": ["-y", "…", "/workspace"] }   stdio
 * Type               { "type": "http", "url": "https://example.com/mcp" }      http
 *   Remote URL       { "type": "sse",  "url": "https://example.com/mcp/sse" }  sse
 *   Local command
 * URL / Command
 * Authentication
 * ```
 *
 * The raw MCP JSON is **not** a column. §8 says "Do not expose raw MCP JSON to normal users.
 * Put raw JSON under an optional 'Advanced' section" — an Advanced view renders the JSON from
 * these columns, and a second stored copy could disagree with the fields the wizard edits.
 *
 * **Credentials are a reference, never a value** (§8: "Credentials must not be included
 * directly in normal agent configuration. Store secrets separately and inject them at
 * runtime"). There is no `token` or `api_key` column for a caller to reach for;
 * `credential_secret_id` points at `secrets`, and `mcp_servers_credential_required` makes the
 * reference mandatory exactly when the chosen authentication needs one.
 *
 * ## One row per connector, of one of three kinds (issue #527, S2-02b, ADR-0113 C15/C16)
 *
 * `kind` says which kind of connector a row is: `mcp` (everything above, and every row that
 * existed before migration 0036), or one of the two **tool connector** kinds, `openapi` and
 * `postgres`. A tool connector has no transport, command, args or URL; its configuration is the
 * `tool_config` JSON object, which the contracts' `OpenApiToolConfigSchema` and
 * `PostgresToolConfigSchema` describe and the server parses (the database only asserts that it is
 * a JSON object). The name is unique across kinds, because a
 * tool connector is referenced by name (C15). A run's authorised tool connectors are snapshotted
 * onto `runs.tool_connector_ids` (C16).
 *
 * The per-kind checks make each kind's shape a database fact: `transport` is set exactly for
 * `mcp`, `tool_config` exactly for the tool kinds, the MCP-only columns are NULL on a tool row,
 * and the four transport/credential checks are guarded by `kind <> 'mcp' or (...)` so they keep
 * their exact meaning for MCP rows. A tool row pins `auth_type` to `none` (the column stays NOT
 * NULL so the migration is additive; the resource renders `authType: null` for a tool kind), and
 * a `postgres` connector always names its credential secret.
 *
 * Declared gap: for `openapi`, whether a credential is required depends on `tool_config.auth`.
 * That pairing is enforced by the server's admission (S2-02c) and by the contracts'
 * `ConnectorResourceSchema`, not by the database, which deliberately does not read inside the
 * JSON. There is still no secret-by-name column (SD3): a credential is only ever a reference by
 * id into `secrets`.
 *
 * Declared gap: `openapi_document` holds the registered text of an `openapi` connector (NULL for
 * every other kind and for rows created before migration 0052). That it is set only for `openapi`,
 * and its 1 MiB cap, are enforced by the server's admission (`OpenApiDocumentSchema`), not by a
 * CHECK, the same way the `tool_config.auth` pairing above is.
 */
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  CONNECTOR_AUTH_TYPES,
  CONNECTOR_KINDS,
  CONNECTOR_TRANSPORTS,
} from '@indx-workspace/contracts/connectors';
import { TOOL_CONNECTOR_KINDS } from '@indx-workspace/contracts/tool-connectors';

import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { memberships } from './memberships.js';
import { oneOf, renderValueList } from './one-of.js';
import { secrets } from './secrets.js';
import { workspaces } from './workspaces.js';
import { workspacePrincipals } from './workspace-principals.js';

/**
 * Every connector kind (ADR-0113 C15). It is the contracts' `CONNECTOR_KINDS` itself, the way
 * `agents.ts` takes the engine ids, so the CHECK constraints are rendered from the one list.
 */
export const connectorKinds = CONNECTOR_KINDS;
export type ConnectorKind = (typeof connectorKinds)[number];

/** The tool connector kinds: every kind except `mcp`. The contracts' `TOOL_CONNECTOR_KINDS` itself. */
export const toolConnectorKinds = TOOL_CONNECTOR_KINDS;
export type ToolConnectorKind = (typeof toolConnectorKinds)[number];

/**
 * `tool_config` for a tool connector: a JSON object. Its per-kind shape is the contracts'
 * `OpenApiToolConfigSchema` / `PostgresToolConfigSchema`, which the server applies; the database
 * and the repository assert only that it is an object (`mcp_servers_tool_config_is_object`) with
 * no U+0000 anywhere in it, the one string content `jsonb` refuses (22P05).
 */
export const ToolConfig = z.record(z.string(), z.unknown()).refine((value) => !containsNul(value), {
  message: 'tool_config may not contain U+0000, which jsonb cannot store',
});
export type ToolConfig = z.infer<typeof ToolConfig>;

/** Whether a JSON value holds U+0000 in any string or key — the one character jsonb refuses. */
function containsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(containsNul);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(
      ([key, entry]) => key.includes('\u0000') || containsNul(entry),
    );
  }
  return false;
}

/** Parse an `mcp_servers.tool_config` value read from or written to the database. Throws otherwise. */
export function parseToolConfig(value: unknown): ToolConfig {
  return ToolConfig.parse(value);
}

/** §8's three transports, in the order §8 introduces them. The contracts' `CONNECTOR_TRANSPORTS` itself. */
export const mcpTransports = CONNECTOR_TRANSPORTS;
export type McpTransport = (typeof mcpTransports)[number];

/** The transports that are reached over a URL rather than by launching a process. */
export const remoteMcpTransports = ['http', 'sse'] as const;

/** §8's Authentication radio group: None / API Key / Bearer Token / OAuth. The contracts' `CONNECTOR_AUTH_TYPES` itself. */
export const mcpAuthTypes = CONNECTOR_AUTH_TYPES;
export type McpAuthType = (typeof mcpAuthTypes)[number];

/** The authentication choices that need a stored credential. Every one except `none`. */
export const credentialedMcpAuthTypes = ['api-key', 'bearer', 'oauth'] as const;

/**
 * `args` for a stdio server — §8's `["-y", "@modelcontextprotocol/server-filesystem",
 * "/workspace"]`. A list of strings and nothing else.
 *
 * Zod is the source of truth and `$type` is derived from it (R-15 §4, W1-DB-01 decision 8).
 * `$type<T>()` is a compile-time hint Drizzle does not enforce, and this column carries no
 * `jsonb_typeof(args) = 'array'` CHECK, so the shape is asserted nowhere the database or the
 * runtime can see it. {@link parseMcpArgs} is the parse a reader has to apply to close that;
 * it is offered here so the rule is written once rather than at each call site. The pull request
 * declares the unguarded column as a gap for its first consumer, W2-CP-05.
 */
export const McpArgs = z.array(z.string());
export type McpArgs = z.infer<typeof McpArgs>;

/** Parse an `mcp_servers.args` value read from the database. Throws on anything else. */
export function parseMcpArgs(value: unknown): McpArgs {
  return McpArgs.parse(value);
}

export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** §8's "Name" — the connector's display name, e.g. "GitHub". Unique in the workspace. */
    name: text('name').notNull(),
    /**
     * Which kind of connector this row is (ADR-0113 C15). Defaults to `mcp`, so every row that
     * existed before migration 0036, and every insert by an older revision, is an MCP connector.
     * Never changes after insert.
     */
    kind: text('kind', { enum: connectorKinds }).notNull().default('mcp'),
    /** MCP only: §8's transport. NULL exactly for a tool connector (`mcp_servers_transport_by_kind`). */
    transport: text('transport', { enum: mcpTransports }),
    /** stdio only: the executable, §8's `"npx"`. NULL for http and sse. */
    command: text('command'),
    /** stdio only: §8's `["-y", "…"]`. NULL for http and sse. */
    args: jsonb('args').$type<McpArgs>(),
    /** http and sse only: §8's endpoint. NULL for stdio. */
    url: text('url'),
    /**
     * Tool connectors only: the kind's configuration, a JSON object (see {@link ToolConfig}).
     * NULL exactly for an MCP connector (`mcp_servers_tool_config_by_kind`).
     */
    toolConfig: jsonb('tool_config').$type<ToolConfig>(),
    /**
     * `openapi` connectors only: the document text the connector was registered with, byte for
     * byte. NULL for every other kind and for every row created before migration 0052. Never part
     * of a resource and never read by a list; only a platform export reads it.
     */
    openapiDocument: text('openapi_document'),
    authType: text('auth_type', { enum: mcpAuthTypes }).notNull().default('none'),
    /**
     * The credential, as a reference into `secrets` — never the credential itself.
     *
     * Tenant-paired in the table config below, so a connector cannot spend another workspace's
     * secret. `ON DELETE RESTRICT` (carried by that constraint): deleting a secret a connector
     * authenticates with must be an explicit decision, because the alternative is a connector
     * that silently stops authenticating.
     */
    credentialSecretId: uuid('credential_secret_id'),
    /** Whether this connector is offered to agents at all. */
    enabled: boolean('enabled').notNull().default(true),
    /**
     * Who created this row (issue #117). Tenant-paired below as
     * `mcp_servers_created_by_workspace_fk`. See `agents.ts`'s `createdBy` comment for why the
     * target is `memberships`, not `users`, and for the backfill this column's migration
     * performs on every existing row.
     */
    createdBy: uuid('created_by'),
    ownerPrincipalId: uuid('owner_principal_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('mcp_servers_workspace_name_key').on(table.workspaceId, table.name),
    // The target `agent_mcp_servers`' tenant-paired reference needs; see agents.ts for why this
    // is a table CONSTRAINT and not a unique INDEX.
    unique('mcp_servers_id_workspace_key').on(table.id, table.workspaceId),
    foreignKey({
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [memberships.workspaceId, memberships.userId],
      name: 'mcp_servers_created_by_workspace_fk',
    }),
    index('mcp_servers_credential_secret_idx').on(table.credentialSecretId),
    index('mcp_servers_owner_principal_idx').on(table.ownerPrincipalId),
    // §25: a connector must not be able to read another workspace's secret. `MATCH SIMPLE`
    // (PostgreSQL's default) leaves the key unenforced while `credential_secret_id` is NULL,
    // which is the wanted behaviour for `auth_type = 'none'`.
    foreignKey({
      columns: [table.credentialSecretId, table.workspaceId],
      foreignColumns: [secrets.id, secrets.workspaceId],
      name: 'mcp_servers_credential_secret_workspace_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.ownerPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'mcp_servers_owner_principal_workspace_fk',
    }),
    oneOf('mcp_servers_kind_valid', table.kind, connectorKinds),
    oneOf('mcp_servers_transport_valid', table.transport, mcpTransports),
    oneOf('mcp_servers_auth_type_valid', table.authType, mcpAuthTypes),
    // Per-kind shape (ADR-0113 C15). An MCP connector has a transport and no tool_config; a tool
    // connector has a tool_config object and none of the MCP-only columns. `tool_kind_fields` is
    // needed because the guarded transport checks below evaluate to NULL, and so pass, once
    // `transport` is NULL.
    check(
      'mcp_servers_transport_by_kind',
      sql`(${table.kind} = 'mcp') = (${table.transport} is not null)`,
    ),
    check(
      'mcp_servers_tool_kind_fields',
      sql`${table.kind} = 'mcp' or (${table.command} is null and ${table.args} is null and ${table.url} is null)`,
    ),
    check(
      'mcp_servers_tool_config_by_kind',
      sql`(${table.kind} = 'mcp') = (${table.toolConfig} is null)`,
    ),
    check(
      'mcp_servers_tool_config_is_object',
      sql`${table.toolConfig} is null or jsonb_typeof(${table.toolConfig}) = 'object'`,
    ),
    // A tool connector pins `auth_type` to `none` (its authentication lives in tool_config), and a
    // postgres connector always names its credential. The openapi auth/credential pairing is the
    // server's and the resource schema's to enforce (the header's declared gap).
    check(
      'mcp_servers_tool_credential',
      sql`${table.kind} = 'mcp' or (${table.authType} = 'none' and (${table.kind} <> 'postgres' or ${table.credentialSecretId} is not null))`,
    ),
    // A stdio server is a command and no URL; a remote server is a URL and no command. Written
    // as an equivalence in both directions so that neither half can be satisfied by omission:
    // a row that names both, or neither, is rejected. Guarded by `kind <> 'mcp'` since migration
    // 0036, so the rule means exactly what it meant for MCP connectors and nothing for tool rows.
    check(
      'mcp_servers_stdio_has_command',
      sql`${table.kind} <> 'mcp' or ((${table.transport} = 'stdio') = (${table.command} is not null))`,
    ),
    check(
      'mcp_servers_remote_has_url',
      sql`${table.kind} <> 'mcp' or ((${table.transport} in ${sql.raw(renderValueList(remoteMcpTransports))}) = (${table.url} is not null))`,
    ),
    // `args` belongs to stdio. A remote connector carrying argv is a row whose meaning nothing
    // reads, which is how a setting silently stops applying.
    check(
      'mcp_servers_args_are_stdio_only',
      sql`${table.kind} <> 'mcp' or (${table.args} is null or ${table.transport} = 'stdio')`,
    ),
    check(
      'mcp_servers_command_not_blank',
      sql`${table.command} is null or length(btrim(${table.command})) > 0`,
    ),
    // §8's URLs are absolute http(s) endpoints. A relative or scheme-less URL is one the
    // Test Connection probe would fail on in a way that reads as a network error.
    check('mcp_servers_url_shape', sql`${table.url} is null or ${table.url} ~ '^https?://'`),
    // The other half of "store secrets separately": every authentication choice except `none`
    // must name a secret, and `none` must not name one. Both directions, so a connector cannot
    // claim OAuth while carrying no credential, and cannot carry one it never uses.
    check(
      'mcp_servers_credential_required',
      sql`${table.kind} <> 'mcp' or ((${table.authType} in ${sql.raw(renderValueList(credentialedMcpAuthTypes))}) = (${table.credentialSecretId} is not null))`,
    ),
    check('mcp_servers_name_not_blank', sql`length(btrim(${table.name})) > 0`),
  ],
);

export type McpServer = typeof mcpServers.$inferSelect;
export type NewMcpServer = typeof mcpServers.$inferInsert;
