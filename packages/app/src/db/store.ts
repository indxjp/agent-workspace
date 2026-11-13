/**
 * `storeOf`: the `ResourceStore` port over PostgreSQL (issue #1502), the adapter every page, route
 * and agent tool of an app reads and writes a resource through.
 *
 * Every statement is scoped by `workspace_id`; a `person()` read rule is part of the `WHERE`, not a
 * filter after it, so pages stay full. The validation, access checks and paging are the shared
 * ones of `policy.ts`, which the in-memory twin uses too. Identifiers come from validated
 * snake_case names (`columns.ts`); every value is a bound parameter.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { Person } from '../person.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import { AUDIT_TABLE } from './audit.js';
import { fieldColumnsOf, quoted, SEARCH_COLUMN, type FieldColumn } from './columns.js';
import { AppStoreError } from './errors.js';
import {
  assertAgentMayWrite,
  assertAllowed,
  filtersOf,
  listKeyOf,
  notifyCommitted,
  pageOf,
  pageRequestOf,
  prepareCreate,
  prepareUpdate,
  readScopeOf,
  recordIdOf,
  searchTextOf,
  type FieldValues,
  type PageRequest,
} from './policy.js';
import type {
  AuditAction,
  CommittedEvent,
  ListOptions,
  Page,
  ResourceStore,
  SearchOptions,
  StoreClock,
  StoreHooks,
} from './port.js';
import { appSchemaName } from './schema-name.js';

/** What the store runs statements on: a Drizzle node-postgres database or transaction. */
export interface AppSqlRunner {
  execute(query: SQL): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

/** A Drizzle node-postgres database (`drizzle(pool)`), as the store uses it. */
export interface AppDatabase extends AppSqlRunner {
  transaction<T>(run: (tx: AppSqlRunner) => Promise<T>): Promise<T>;
}

/** What {@link storeOf} takes besides the resource. */
export interface StoreOptions extends StoreClock, StoreHooks {
  readonly db: AppDatabase;
  /** The app's name key; its data lives in the schema `app_<name>`. */
  readonly appName: string;
}

type Row = Record<string, unknown> & { readonly id: string; readonly created_at: string };

const TIMESTAMP_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const TIMESTAMP_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** How a column is read so it comes back as the field's value, whatever the driver's parsers. */
function readExpression(column: FieldColumn): string {
  const name = quoted(column.name);
  switch (column.sql) {
    case 'numeric':
      return `${name}::text`;
    case 'date':
      return `to_char(${name}, 'YYYY-MM-DD')`;
    case 'timestamptz':
      return `to_char(${name} AT TIME ZONE 'UTC', ${TIMESTAMP_MS})`;
    case 'uuid[]':
    case 'text[]':
      return `to_jsonb(${name})`;
    default:
      return name;
  }
}

function selectListOf(columns: readonly FieldColumn[]): SQL {
  const reserved = [
    '"id"',
    '"workspace_id"',
    '"created_by"',
    '"updated_by"',
    `to_char("created_at" AT TIME ZONE 'UTC', ${TIMESTAMP_US}) AS "created_at"`,
    `to_char("updated_at" AT TIME ZONE 'UTC', ${TIMESTAMP_US}) AS "updated_at"`,
  ];
  const fields = columns.map((column) => `${readExpression(column)} AS ${quoted(column.name)}`);
  return sql.raw([...reserved, ...fields].join(', '));
}

/** A text array as a bound JSON parameter, its order kept, so no driver array encoding is involved. */
function arrayParameter(items: readonly string[], type: 'uuid' | 'text'): SQL {
  return sql`ARRAY(SELECT e FROM jsonb_array_elements_text(${JSON.stringify(items)}::jsonb) WITH ORDINALITY AS t(e, n) ORDER BY n)::${sql.raw(type)}[]`;
}

function columnValue(column: FieldColumn, values: FieldValues): unknown {
  const value = values[column.field];
  if (value === null || value === undefined || column.part === 'value') return value ?? null;
  return (value as Record<string, unknown>)[column.part];
}

/** A column's value as a bound parameter cast to the column's type. */
function parameterOf(column: FieldColumn, values: FieldValues): SQL {
  const value = columnValue(column, values);
  if (value === null) return sql`NULL::${sql.raw(column.sql)}`;
  switch (column.sql) {
    case 'uuid[]':
      return arrayParameter(value as string[], 'uuid');
    case 'text[]':
      return arrayParameter(value as string[], 'text');
    case 'jsonb':
      return sql`${JSON.stringify(value)}::jsonb`;
    case 'numeric':
      return sql`${typeof value === 'number' ? String(value) : (value as string)}::numeric`;
    default:
      return sql`${value}::${sql.raw(column.sql)}`;
  }
}

function recordOf(resource: DefinedResource, raw: Record<string, unknown>): Row {
  const record: Record<string, unknown> = {
    id: raw['id'],
    workspace_id: raw['workspace_id'],
    created_by: raw['created_by'],
    updated_by: raw['updated_by'],
    created_at: raw['created_at'],
    updated_at: raw['updated_at'],
  };
  for (const [key, field] of Object.entries(resource.fields)) {
    const value = raw[key] ?? null;
    if (field.type === 'money') {
      const currency = raw[`${key}_${field.column.companion?.suffix ?? 'currency'}`];
      record[key] = value === null ? null : { amount: value, currency };
    } else if (field.type === 'number') {
      record[key] = value === null ? null : Number(value);
    } else {
      record[key] = value;
    }
  }
  return record as Row;
}

/**
 * The PostgreSQL store of `resource` in the schema of `options.appName`, whose table (and, when the
 * resource is audited, `app_audit_events`) the app's migrations created.
 *
 * Every refusal is an `AppStoreError`; any other failure (the driver's, the database's) becomes
 * `internal_error` with fixed prose, the original kept as `cause` for the server's log only.
 *
 * @throws {RangeError} when `options.appName` is not a valid app name.
 */
export function storeOf<F extends FieldMap>(
  resource: DefinedResource<F>,
  options: StoreOptions,
): ResourceStore<F> {
  const { db, appName } = options;
  const schema = quoted(appSchemaName(appName));
  const table = sql.raw(`${schema}.${quoted(resource.plural)}`);
  const auditTable = sql.raw(`${schema}.${quoted(AUDIT_TABLE)}`);
  const columns = fieldColumnsOf(resource);
  const selectList = selectListOf(columns);
  const stamp = (): SQL => {
    const at = options.now?.().toISOString() ?? null;
    return sql`coalesce(${at}::timestamptz, now())`;
  };

  const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AppStoreError) throw error;
      throw new AppStoreError('internal_error', { cause: error });
    }
  };

  const readPredicate = (person: Person): SQL => {
    const scope = readScopeOf(resource, person);
    if (scope.all) return sql`TRUE`;
    if (scope.personFields.length === 0) return sql`FALSE`;
    return sql`(${sql.join(
      scope.personFields.map(
        (field) => sql`${sql.raw(quoted(field))}::text = ${person.principalId}`,
      ),
      sql` OR `,
    )})`;
  };

  const records = (rows: readonly Record<string, unknown>[]): Row[] =>
    rows.map((raw) => recordOf(resource, raw));

  const page = async (
    person: Person,
    request: PageRequest,
    key: string,
    condition: SQL,
  ): Promise<Page<RecordOf<F>>> => {
    const after =
      request.after === null
        ? sql`TRUE`
        : sql`("created_at", "id") < (${request.after.createdAt}::timestamptz, ${request.after.id}::uuid)`;
    const result = await db.execute(
      sql`SELECT ${selectList} FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND ${readPredicate(person)} AND ${condition} AND ${after} ORDER BY "created_at" DESC, "id" DESC LIMIT ${request.limit + 1}`,
    );
    return pageOf(records(result.rows), request, key, person.workspaceId) as unknown as Page<
      RecordOf<F>
    >;
  };

  /** The visible record `id` of the person's workspace, locked for the write that follows. */
  const lockVisible = async (tx: AppSqlRunner, person: Person, id: string): Promise<Row> => {
    const key = recordIdOf(id);
    if (key === undefined) throw new AppStoreError('resource_not_found');
    const result = await tx.execute(
      sql`SELECT ${selectList} FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND "id" = ${key}::uuid AND ${readPredicate(person)} FOR UPDATE`,
    );
    const [row] = records(result.rows);
    if (row === undefined) throw new AppStoreError('resource_not_found');
    return row;
  };

  const writeAudit = async (
    tx: AppSqlRunner,
    person: Person,
    recordId: string,
    action: AuditAction,
    fields: readonly string[],
  ): Promise<void> => {
    if (!resource.audit) return;
    await tx.execute(
      sql`INSERT INTO ${auditTable} ("workspace_id", "actor", "via", "run_id", "resource", "record_id", "action", "fields", "at") VALUES (${person.workspaceId}, ${person.principalId}, ${person.via}, ${person.runId ?? null}, ${resource.name}, ${recordId}::uuid, ${action}, ${arrayParameter(fields, 'text')}, ${stamp()})`,
    );
  };

  /** The `afterWrite` hook, in the write's transaction: a throw rolls the write back. */
  const afterWrite = async (
    tx: AppSqlRunner,
    type: CommittedEvent,
    row: Row,
    person: Person,
  ): Promise<void> => {
    if (options.afterWrite === undefined) return;
    await options.afterWrite(tx, {
      resource: resource.name,
      type,
      row: structuredClone(row),
      person,
    });
  };

  const onlyRow = (rows: readonly Record<string, unknown>[]): Row => {
    const [row] = records(rows);
    if (row === undefined) throw new AppStoreError('resource_not_found');
    return row;
  };

  return {
    list: (person: Person, listOptions: ListOptions = {}) =>
      guarded(() => {
        const key = listKeyOf(appName, resource);
        const request = pageRequestOf(listOptions, key, person.workspaceId);
        const filters = filtersOf(resource, listOptions.where);
        const condition =
          filters.length === 0
            ? sql`TRUE`
            : sql.join(
                filters.map(([field, value]) => sql`${sql.raw(quoted(field))} = ${value}`),
                sql` AND `,
              );
        return page(person, request, key, condition);
      }),

    get: (person: Person, id: string) =>
      guarded(async () => {
        const predicate = readPredicate(person);
        const key = recordIdOf(id);
        if (key === undefined) throw new AppStoreError('resource_not_found');
        const result = await db.execute(
          sql`SELECT ${selectList} FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND "id" = ${key}::uuid AND ${predicate}`,
        );
        return onlyRow(result.rows) as unknown as RecordOf<F>;
      }),

    search: (person: Person, query: string, searchOptions: SearchOptions = {}) =>
      guarded(() => {
        const text = searchTextOf(resource, query);
        const key = listKeyOf(appName, resource, true);
        const request = pageRequestOf(searchOptions, key, person.workspaceId);
        return page(
          person,
          request,
          key,
          sql`${sql.raw(quoted(SEARCH_COLUMN))} @@ websearch_to_tsquery('simple', ${text})`,
        );
      }),

    create: (person: Person, input: unknown) =>
      guarded(async () => {
        const prepared = prepareCreate(resource, person, input);
        const names = sql.raw(columns.map((column) => quoted(column.name)).join(', '));
        const values = sql.join(
          columns.map((column) => parameterOf(column, prepared.values)),
          sql`, `,
        );
        const created = await db.transaction(async (tx) => {
          const at = stamp();
          const result = await tx.execute(
            sql`INSERT INTO ${table} ("workspace_id", "created_by", "updated_by", "created_at", "updated_at", ${names}) VALUES (${person.workspaceId}, ${person.principalId}, ${person.principalId}, ${at}, ${at}, ${values}) RETURNING ${selectList}`,
          );
          const row = onlyRow(result.rows);
          await writeAudit(tx, person, row.id, 'create', prepared.fields);
          await afterWrite(tx, 'created', row, person);
          return row;
        });
        await notifyCommitted(options.onCommitted, resource.name, 'created', created, person);
        return created as unknown as RecordOf<F>;
      }),

    update: (person: Person, id: string, patch: unknown) =>
      guarded(async () => {
        const prepared = prepareUpdate(resource, person, patch);
        const assignments = columns
          .filter((column) => prepared.fields.includes(column.field))
          .map(
            (column) =>
              sql`${sql.raw(quoted(column.name))} = ${parameterOf(column, prepared.values)}`,
          );
        const updated = await db.transaction(async (tx) => {
          const existing = await lockVisible(tx, person, id);
          assertAllowed('update', resource, person, existing);
          const result = await tx.execute(
            sql`UPDATE ${table} SET ${sql.join([...assignments, sql`"updated_by" = ${person.principalId}`, sql`"updated_at" = ${stamp()}`], sql`, `)} WHERE "workspace_id" = ${person.workspaceId} AND "id" = ${existing.id}::uuid RETURNING ${selectList}`,
          );
          const row = onlyRow(result.rows);
          await writeAudit(tx, person, row.id, 'update', prepared.fields);
          await afterWrite(tx, 'updated', row, person);
          return row;
        });
        await notifyCommitted(options.onCommitted, resource.name, 'updated', updated, person);
        return updated as unknown as RecordOf<F>;
      }),

    delete: (person: Person, id: string) =>
      guarded(async () => {
        assertAgentMayWrite(resource, person, []);
        const deleted = await db.transaction(async (tx) => {
          const existing = await lockVisible(tx, person, id);
          assertAllowed('delete', resource, person, existing);
          await tx.execute(
            sql`DELETE FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND "id" = ${existing.id}::uuid`,
          );
          await writeAudit(tx, person, existing.id, 'delete', []);
          await afterWrite(tx, 'deleted', existing, person);
          return existing;
        });
        await notifyCommitted(options.onCommitted, resource.name, 'deleted', deleted, person);
      }),
  };
}
