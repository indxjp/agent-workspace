/**
 * What the PostgreSQL page store (`page-store.ts`) shares between its reads and its writes: the
 * row shape, the quoted table names of one resource, the select list, and the SQL fragments every
 * statement uses. Identifiers come from validated snake_case names; every value is a bound parameter.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { Person } from '../person.js';
import { AUDIT_TABLE } from './audit.js';
import { PAGE_REVISION_COLUMN, quoted } from './columns.js';
import type { PageResource } from './page-policy.js';
import { pageRevisionsTableName } from './page-revisions.js';
import { readScopeOf } from './policy.js';
import { appSchemaName } from './schema-name.js';
import type { StoreOptions } from './store.js';

export type Row = Record<string, unknown> & {
  readonly id: string;
  readonly created_at: string;
  readonly revision_id: string;
};

export const TIMESTAMP_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** A text value as validated: the stores parse every value before it reaches a statement. */
export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A page field's value as a bound parameter cast to its column's type. */
export function valueOf(field: string, value: unknown): SQL {
  if (value === null || value === undefined) {
    return field === 'parent' || field === 'space' ? sql`NULL::uuid` : sql`NULL`;
  }
  switch (field) {
    case 'position':
      return sql`${Number(value)}::numeric`;
    case 'blocks':
      return sql`${JSON.stringify(value)}::jsonb`;
    case 'parent':
    case 'space':
      return sql`${textOf(value)}::uuid`;
    default:
      return sql`${textOf(value)}::text`;
  }
}

function recordOf(raw: Record<string, unknown>): Row {
  return { ...raw, position: Number(raw['position']) } as unknown as Row;
}

/** The rows of a statement's result, as page rows. */
export function recordsOf(rows: readonly Record<string, unknown>[]): Row[] {
  return rows.map(recordOf);
}

/** The page's own columns, selected with timestamps as text and `position` as text. */
function selectListOf(fieldNames: readonly string[]): SQL {
  return sql.raw(
    [
      '"id"',
      '"workspace_id"',
      '"created_by"',
      '"updated_by"',
      `to_char("created_at" AT TIME ZONE 'UTC', ${TIMESTAMP_US}) AS "created_at"`,
      `to_char("updated_at" AT TIME ZONE 'UTC', ${TIMESTAMP_US}) AS "updated_at"`,
      ...fieldNames.map((field) =>
        field === 'position' ? '"position"::text AS "position"' : quoted(field),
      ),
      `${quoted(PAGE_REVISION_COLUMN)} AS "revision_id"`,
    ].join(', '),
  );
}

/** The resource, its connection and its quoted names: what one page store's statements need. */
export interface PageContext {
  readonly resource: PageResource;
  readonly options: StoreOptions;
  readonly schema: string;
  readonly table: SQL;
  readonly revisionsTable: SQL;
  readonly auditTable: SQL;
  readonly fieldNames: readonly string[];
  readonly selectList: SQL;
}

export function pageContextOf(resource: PageResource, options: StoreOptions): PageContext {
  const schema = quoted(appSchemaName(options.appName));
  const tableIn = (name: string): SQL => sql.raw(`${schema}.${quoted(name)}`);
  const fieldNames = Object.keys(resource.fields);
  return {
    resource,
    options,
    schema,
    table: tableIn(resource.plural),
    revisionsTable: tableIn(pageRevisionsTableName(resource)),
    auditTable: tableIn(AUDIT_TABLE),
    fieldNames,
    selectList: selectListOf(fieldNames),
  };
}

/** The store's clock as a statement fragment: the injected `now`, or the database's. */
export function stampOf(context: PageContext): SQL {
  const at = context.options.now?.().toISOString() ?? null;
  return sql`coalesce(${at}::timestamptz, now())`;
}

/** The condition that the rows `person` may read satisfy. */
export function visibleTo(context: PageContext, person: Person): SQL {
  return readScopeOf(context.resource, person).all ? sql`TRUE` : sql`FALSE`;
}
