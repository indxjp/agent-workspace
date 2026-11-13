/**
 * `tablesOf`: a resource's table as a Drizzle table in the app's schema `app_<name>` (issue
 * #1502), for an app's own queries. It describes the table {@link createTableSql} creates; the
 * migrations come from that text, never from drizzle-kit.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  date,
  index,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uuid,
  type PgColumnBuilderBase,
} from 'drizzle-orm/pg-core';

import type { ColumnSql } from '../fields/types.js';
import type { DefinedResource } from '../resource.js';
import {
  checkNameOf,
  fieldColumnsOf,
  hiddenColumnsOf,
  indexNamesOf,
  SEARCH_COLUMN,
  searchExpressionOf,
} from './columns.js';
import { appSchemaName } from './schema-name.js';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

function builderOf(name: string, kind: ColumnSql): PgColumnBuilderBase {
  switch (kind) {
    case 'text':
      return text(name);
    case 'jsonb':
      return jsonb(name);
    case 'numeric':
      return numeric(name);
    case 'boolean':
      return boolean(name);
    case 'date':
      return date(name, { mode: 'string' });
    case 'timestamptz':
      return timestamp(name, { withTimezone: true, mode: 'string' });
    case 'uuid':
      return uuid(name);
    case 'uuid[]':
      return uuid(name).array();
    case 'text[]':
      return text(name).array();
  }
}

function fieldBuilderOf(name: string, kind: ColumnSql, notNull: boolean): PgColumnBuilderBase {
  const builder = builderOf(name, kind) as PgColumnBuilderBase & {
    notNull(): PgColumnBuilderBase;
  };
  return notNull ? builder.notNull() : builder;
}

/**
 * The Drizzle table of `resource` in the schema of `appName`: the reserved columns (`id`,
 * `workspace_id`, `created_by`, `updated_by`, `created_at`, `updated_at`), a column per field (a
 * `money()` field's amount and currency), each field's CHECK, the newest-first list index and,
 * when the resource declares `search`, the generated `_search` tsvector column and its GIN index.
 * A `definePages` resource has its hidden columns too; its revisions are `pageRevisionsTable`.
 *
 * A reference to a platform row is its id, never a foreign key.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 */
export function tablesOf(resource: DefinedResource, appName: string) {
  const fields = fieldColumnsOf(resource);
  const search = searchExpressionOf(resource);
  const columns: Record<string, PgColumnBuilderBase> = {
    id: uuid('id').primaryKey().defaultRandom(),
    workspace_id: text('workspace_id').notNull(),
    created_by: text('created_by').notNull(),
    updated_by: text('updated_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    ...Object.fromEntries(
      fields.map((column) => [
        column.name,
        fieldBuilderOf(column.name, column.sql, column.notNull),
      ]),
    ),
    ...Object.fromEntries(
      hiddenColumnsOf(resource).map((column) => [
        column.name,
        column.sql === 'text' ? text(column.name).notNull().default('') : uuid(column.name),
      ]),
    ),
    ...(search === undefined
      ? {}
      : { [SEARCH_COLUMN]: tsvector(SEARCH_COLUMN).generatedAlwaysAs(sql.raw(search)) }),
  };
  const names = indexNamesOf(resource.plural);
  return pgSchema(appSchemaName(appName)).table(resource.plural, columns, (table) => [
    index(names.list).on(table['workspace_id']!, table['created_at']!.desc(), table['id']!.desc()),
    ...(search === undefined ? [] : [index(names.search).using('gin', table[SEARCH_COLUMN]!)]),
    ...fields.flatMap((column) =>
      column.check === undefined
        ? []
        : [check(checkNameOf(resource.plural, column.name), sql.raw(column.check))],
    ),
  ]);
}
