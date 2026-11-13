/**
 * The physical columns of a resource's table, derived once from its fields, so the Drizzle table,
 * the generated SQL and the store's queries cannot disagree (issue #1502). Pure.
 *
 * Every name here is a validated snake_case identifier of at most 63 characters (`names.ts`), and
 * every check expression is built from validated options (`fields/types.ts`), so both splice into
 * SQL as quoted identifiers and literals without escaping beyond the double quotes.
 */
import type { ColumnSql } from '../fields/types.js';
import { isPageResource } from '../pages/define-pages.js';
import type { DefinedResource } from '../resource.js';
import { derivedIdentifier } from './schema-name.js';

/** Which part of a field's value a column holds: the value itself, or a money amount or currency. */
type ColumnPart = 'value' | 'amount' | 'currency';

/** One column a field is stored in. */
export interface FieldColumn {
  readonly name: string;
  readonly field: string;
  readonly part: ColumnPart;
  readonly sql: ColumnSql;
  readonly notNull: boolean;
  /** The CHECK expression with the quoted column name in place, when the field has one. */
  readonly check?: string;
}

/** The reserved columns, in table order, with their DDL. */
export const RESERVED_COLUMNS = [
  { name: 'id', ddl: 'uuid PRIMARY KEY DEFAULT gen_random_uuid()' },
  { name: 'workspace_id', ddl: 'text NOT NULL' },
  { name: 'created_by', ddl: 'text NOT NULL' },
  { name: 'updated_by', ddl: 'text NOT NULL' },
  { name: 'created_at', ddl: 'timestamptz NOT NULL DEFAULT now()' },
  { name: 'updated_at', ddl: 'timestamptz NOT NULL DEFAULT now()' },
] as const;

/**
 * The generated full-text column, present when the resource declares `search`. Its leading
 * underscore keeps it apart from every field, whose names start with a letter (a field may itself
 * be named `search`).
 */
export const SEARCH_COLUMN = '_search';

/**
 * The page kind's search source (issue #1520): the space-separated terms of a page's title and the
 * text of its blocks, which the page store writes on every save. PostgreSQL cannot segment
 * Japanese, so the page's `_search` is generated from these terms (`search-terms.ts`), not from
 * the fields.
 */
export const PAGE_SEARCH_TEXT_COLUMN = '_search_text';

/** The page kind's pointer to its newest revision, which `expectedRevisionId` is checked against. */
export const PAGE_REVISION_COLUMN = '_revision_id';

/** A column the store keeps for itself, never a field: the page kind's two. */
interface HiddenColumn {
  readonly name: string;
  readonly sql: ColumnSql;
  readonly ddl: string;
}

/** The hidden columns of `resource`, in table order: none unless it is the page kind. */
export function hiddenColumnsOf(resource: DefinedResource): readonly HiddenColumn[] {
  if (!isPageResource(resource)) return [];
  return [
    { name: PAGE_SEARCH_TEXT_COLUMN, sql: 'text', ddl: `text NOT NULL DEFAULT ''` },
    { name: PAGE_REVISION_COLUMN, sql: 'uuid', ddl: 'uuid' },
  ];
}

/** `"name"`: the name is a validated identifier, so quoting is enough. */
export function quoted(name: string): string {
  return `"${name}"`;
}

/** `{ check }` with the quoted column name in place of `{column}`, or nothing. */
function checkOf(template: string | undefined, column: string): { readonly check?: string } {
  return template === undefined ? {} : { check: template.replaceAll('{column}', quoted(column)) };
}

/** The columns of every field, in field order; a `money()` field adds `<field>_currency`. */
export function fieldColumnsOf(resource: DefinedResource): readonly FieldColumn[] {
  return Object.entries(resource.fields).flatMap(([key, field]): FieldColumn[] => {
    const notNull = !field.optional;
    const own: FieldColumn = {
      name: key,
      field: key,
      part: field.type === 'money' ? 'amount' : 'value',
      sql: field.column.sql,
      notNull,
      ...checkOf(field.column.check, key),
    };
    const companion = field.column.companion;
    if (companion === undefined) return [own];
    const name = `${key}_${companion.suffix}`;
    return [
      own,
      {
        name,
        field: key,
        part: 'currency',
        sql: companion.sql,
        notNull,
        ...checkOf(companion.check, name),
      },
    ];
  });
}

/**
 * The expression the generated `search` column is: the `'simple'` text-search configuration
 * (ADR-0147's lexical search; no stemming, so every language tokenises alike) over each searched
 * field, an unset one as empty. `to_tsvector(regconfig, jsonb)` reads a rich-text field's string
 * values. `undefined` when the resource declares no search. A page's is over its terms column,
 * {@link PAGE_SEARCH_TEXT_COLUMN}.
 */
export function searchExpressionOf(resource: DefinedResource): string | undefined {
  if (resource.search.length === 0) return undefined;
  if (isPageResource(resource)) {
    return `to_tsvector('simple'::regconfig, ${quoted(PAGE_SEARCH_TEXT_COLUMN)})`;
  }
  return resource.search
    .map((key) => {
      const empty = resource.fields[key]?.type === 'richText' ? `'[]'::jsonb` : `''`;
      return `to_tsvector('simple'::regconfig, coalesce(${quoted(key)}, ${empty}))`;
    })
    .join(' || ');
}

/** The names of a resource table's indexes and constraints. */
export function indexNamesOf(plural: string): { readonly list: string; readonly search: string } {
  return {
    list: derivedIdentifier(plural, 'list_idx'),
    search: derivedIdentifier(plural, 'search_idx'),
  };
}

/** The name of a column's CHECK constraint: PostgreSQL's own `<table>_<column>_check`. */
export function checkNameOf(plural: string, column: string): string {
  return derivedIdentifier(plural, `${column}_check`);
}
