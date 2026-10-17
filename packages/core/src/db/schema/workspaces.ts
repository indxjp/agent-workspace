/**
 * `workspaces` — the tenant root (spec §21, §25, §27).
 *
 * This is one of exactly two tables in the schema that carry no `workspace_id`, because this
 * IS the workspace. The other is `users`. Every other table is tenant-scoped, and
 * `tenancy.test.ts` fails the build if a new table is neither.
 */
import {
  boolean,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { check } from 'drizzle-orm/pg-core';
import { modelConnections } from './model-connections.js';

/**
 * `model_connections.(id, workspace_id)`, explicitly typed as `AnyPgColumn`.
 *
 * `model-connections.ts` references `workspaces.id` back (every connection is tenant-owned), so
 * this pair is a genuine schema cycle: TypeScript cannot infer either exported table's type
 * without help, because each depends on resolving the other's first ("...is referenced directly
 * or indirectly in its own initializer"). The explicit `AnyPgColumn` annotation is Drizzle's own
 * documented shape for exactly this — it tells the compiler "trust the declared shape" instead of
 * asking it to infer `modelConnections`'s full type just to read two of its columns.
 */
function modelConnectionForeignColumns(): [AnyPgColumn, AnyPgColumn] {
  return [modelConnections.id, modelConnections.workspaceId];
}

export const workspaces = pgTable(
  'workspaces',
  {
    id: primaryKeyId(),
    /**
     * URL-safe stable identifier. It exists so that a bootstrap seed can be run twice without
     * creating a second workspace: without a natural key, `ON CONFLICT` has nothing to key on
     * and idempotency has to be faked by counting rows.
     */
    slug: text('slug').notNull(),
    /** Human-facing name, shown in the UI. Free text; the slug carries the format rules. */
    name: text('name').notNull(),
    /** Durable workspace policy; public shares are suspended when this is disabled. */
    publicSharingEnabled: boolean('public_sharing_enabled').notNull().default(true),
    /**
     * The workspace-wide model default (issue #129) — the last rung of the resolution ladder:
     * run override > agent override > project default > workspace default. `SET NULL` on delete,
     * the same recoverable-not-cascading shape `agents.model_connection_id` already uses:
     * deleting the connection must not delete the workspace, it must leave resolution to fail
     * closed here, at this named layer. Always written with {@link defaultModel} as one pair —
     * see `workspaces_default_model_pair` below. The FK's own `SET NULL` only clears this column,
     * never the paired text one, which is why `model-connections.ts`'s repository nulls both
     * columns together, in one statement, before a connection referenced here is deleted.
     */
    defaultModelConnectionId: uuid('default_model_connection_id').references(
      (): AnyPgColumn => modelConnectionForeignColumns()[0],
      { onDelete: 'set null' },
    ),
    /** The provider-side model id paired with {@link defaultModelConnectionId}. NULL together. */
    defaultModel: text('default_model'),
    /**
     * `NULL` while active; set once, to the moment archival happened, and cleared back to `NULL`
     * by restore (issue #119). Archiving is a timestamp rather than a boolean so "when" survives
     * alongside "whether" with no second column, matching `api_keys.revoked_at`'s shape for the
     * same reason. Archive is the whole lifecycle this wave builds — no purge, no `DELETE`
     * (`docs/adr/W9-WS-119-*.md`) — so this column and `restore` clearing it are the only two
     * states a workspace ever moves between after creation.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('workspaces_slug_key').on(table.slug),
    // A slug that is not URL-safe is a slug that will be silently escaped somewhere later.
    // Reject it at the boundary instead (ADR-0015).
    check('workspaces_slug_format', sql`${table.slug} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'`),
    check('workspaces_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    // #129: a connection with no chosen model is not a default, and a model id with no
    // connection to reach it is not one either. Written and cleared as one pair, never one
    // without the other.
    check(
      'workspaces_default_model_pair',
      sql`(${table.defaultModelConnectionId} is null) = (${table.defaultModel} is null)`,
    ),
    // §25: a workspace must not be able to default to another workspace's connection. `id` here
    // IS the workspace id (this table has no separate `workspace_id` column — see the file
    // header), so this pairs the reference against `model_connections(id, workspace_id)` using
    // the row's own primary key as the tenant half.
    foreignKey({
      columns: [table.defaultModelConnectionId, table.id],
      foreignColumns: modelConnectionForeignColumns(),
      name: 'workspaces_default_model_connection_workspace_fk',
    }),
  ],
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
