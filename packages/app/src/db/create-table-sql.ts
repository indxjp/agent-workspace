/**
 * `createTableSql`: a resource's table as one deterministic SQL text (issue #1502). The same
 * resource and app name always give the same bytes, so the generator writes it as a migration and
 * a test can snapshot it; drizzle-kit is never run. Pure.
 */
import { isPageResource } from '../pages/define-pages.js';
import type { DefinedResource } from '../resource.js';
import {
  checkNameOf,
  fieldColumnsOf,
  hiddenColumnsOf,
  indexNamesOf,
  quoted,
  RESERVED_COLUMNS,
  SEARCH_COLUMN,
  searchExpressionOf,
} from './columns.js';
import { createPageRevisionsSql } from './page-revisions.js';
import { appSchemaName } from './schema-name.js';

/**
 * `CREATE TABLE IF NOT EXISTS "app_<name>"."<plural>"` with the reserved columns, one column per
 * field (and a `money()` field's currency column), each field's CHECK as a named constraint, the
 * generated `_search` column when the resource declares search, then the newest-first list index
 * on `(workspace_id, created_at DESC, id DESC)` and, with search, its GIN index. A `definePages`
 * resource also has its two hidden columns (its search terms and its newest revision) and, after
 * it, its `<name>_revisions` table.
 *
 * Every row carries `workspace_id`; a reference to a platform row (a person, a file) is its id with
 * no foreign key, because the platform's tables are not the app's to constrain.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 */
export function createTableSql(resource: DefinedResource, appName: string): string {
  const schema = appSchemaName(appName);
  const table = `${quoted(schema)}.${quoted(resource.plural)}`;
  const fields = fieldColumnsOf(resource);
  const search = searchExpressionOf(resource);
  const lines = [
    ...RESERVED_COLUMNS.map((column) => `${quoted(column.name)} ${column.ddl}`),
    ...fields.map(
      (column) => `${quoted(column.name)} ${column.sql}${column.notNull ? ' NOT NULL' : ''}`,
    ),
    ...hiddenColumnsOf(resource).map((column) => `${quoted(column.name)} ${column.ddl}`),
    ...(search === undefined
      ? []
      : [`${quoted(SEARCH_COLUMN)} tsvector GENERATED ALWAYS AS (${search}) STORED`]),
    ...fields.flatMap((column) =>
      column.check === undefined
        ? []
        : [
            `CONSTRAINT ${quoted(checkNameOf(resource.plural, column.name))} CHECK (${column.check})`,
          ],
    ),
  ];
  const indexes = indexNamesOf(resource.plural);
  const sql = [
    `CREATE TABLE IF NOT EXISTS ${table} (\n${lines.map((line) => `  ${line}`).join(',\n')}\n);`,
    `CREATE INDEX IF NOT EXISTS ${quoted(indexes.list)} ON ${table} ("workspace_id", "created_at" DESC, "id" DESC);`,
    ...(search === undefined
      ? []
      : [
          `CREATE INDEX IF NOT EXISTS ${quoted(indexes.search)} ON ${table} USING gin (${quoted(SEARCH_COLUMN)});`,
        ]),
    '',
  ].join('\n');
  return isPageResource(resource) ? `${sql}${createPageRevisionsSql(resource, appName)}` : sql;
}
