/**
 * `model_connections` — one configured way to reach a model provider (spec §9, §10, §13, §27).
 *
 * This table holds the *non-secret* half of a provider configuration: which provider, and the
 * endpoint-shaped values §13's "Add Provider" form asks for. The secret half — the API key —
 * is deliberately absent, and that is not an oversight:
 *
 *   * spec §23 gives secrets their own table with its own encryption story, and that table is
 *     Wave 2 work;
 *   * a nullable `secret_id` pointing at a table that does not exist yet is a foreign key that
 *     cannot be declared and an invariant that cannot be enforced.
 *
 * So this wave stores the connection and Wave 2 attaches the credential to it. Declared as a
 * gap on this task's pull request rather than papered over with a `text` column that means
 * "some secret, somewhere".
 */
import { MODEL_PROVIDERS } from '@indx-workspace/contracts/runs';
import { jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { oneOf } from './one-of.js';
import { workspaces } from './workspaces.js';

/** Spec §10's provider list; the canonical `MODEL_PROVIDERS` lives in contracts. */
export const modelProviders = MODEL_PROVIDERS;
export type ModelProvider = (typeof modelProviders)[number];

/**
 * The non-secret provider settings, exactly §13's Azure form minus the API key.
 *
 * Zod is the source of truth and `$type` is derived from it, per R-15 §4: `$type<T>()` is a
 * compile-time hint that Drizzle does not enforce at runtime — `mapFromDriverValue` hands back
 * unparseable input as a raw string still typed as `T`. Every read of this column therefore
 * goes through {@link parseModelConnectionConfig}, never through the inferred type alone.
 */
export const ModelConnectionConfig = z
  .object({
    /** Provider base URL. `ANTHROPIC_BASE_URL`-shaped; absent means the provider default. */
    baseUrl: z.url().optional(),
    /** Azure OpenAI `api-version`. */
    apiVersion: z.string().min(1).optional(),
    /** Azure OpenAI deployment name. */
    deployment: z.string().min(1).optional(),
  })
  .strict();
export type ModelConnectionConfig = z.infer<typeof ModelConnectionConfig>;

/** Parse a `model_connections.config` value read from the database. Throws on anything else. */
export function parseModelConnectionConfig(value: unknown): ModelConnectionConfig {
  return ModelConnectionConfig.parse(value);
}

export const modelConnections = pgTable(
  'model_connections',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Display name, §13's "Claude Sonnet" / "GPT". */
    name: text('name').notNull(),
    provider: text('provider', { enum: modelProviders }).notNull(),
    /**
     * No database default. A caller that has not decided what the connection settings are has
     * not finished configuring the connection; `{}` is a decision and must be written as one.
     */
    config: jsonb('config').$type<ModelConnectionConfig>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('model_connections_workspace_name_key').on(table.workspaceId, table.name),
    // The target `agents_model_connection_workspace_fk` needs: PostgreSQL only accepts
    // `REFERENCES model_connections (id, workspace_id)` when that pair is unique. `id` is
    // already the primary key, so this adds no new restriction on the data.
    // Declared as a table CONSTRAINT rather than a unique INDEX on purpose. drizzle-kit
    // emits every `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` before it emits any
    // `CREATE UNIQUE INDEX`, so a composite foreign key pointing at a unique *index*
    // fails the migration with "there is no unique constraint matching the given keys".
    // A constraint is emitted inside CREATE TABLE, which is early enough.
    unique('model_connections_id_workspace_key').on(table.id, table.workspaceId),
    oneOf('model_connections_provider_valid', table.provider, modelProviders),
  ],
);

export type ModelConnection = typeof modelConnections.$inferSelect;
export type NewModelConnection = typeof modelConnections.$inferInsert;
