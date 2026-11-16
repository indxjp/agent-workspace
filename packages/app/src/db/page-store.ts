/**
 * `pageStoreOf`: the `PageStore` port over PostgreSQL (issue #1520), the store of a `definePages`
 * resource. It is a resource store (workspace-scoped, access-checked, cursor-paged, audited, the
 * decisions of `policy.ts`) that also keeps the tree and the revisions, with the decisions of
 * `page-policy.ts` the in-memory twin shares:
 *
 * - every save of a page's title or body inserts its `<name>_revisions` row, and moves the page's
 *   `_revision_id` to it, in the transaction of the save;
 * - a change to the tree (a create, a move, a delete) holds the workspace's tree lock, a
 *   transaction-scoped advisory lock, so two concurrent moves cannot make a cycle the recursive
 *   check of each would miss, and a page cannot be created under one a cascade is deleting;
 * - search reads the page's `_search_text`, the terms of `search-terms.ts`, which every save
 *   rewrites, with a `to_tsquery('simple', …)` of the query's terms.
 *
 * Identifiers come from validated snake_case names; every value is a bound parameter.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { RichTextBlock } from '../fields/rich-text.js';
import type { DefinedPages } from '../pages/define-pages.js';
import type { Person } from '../person.js';
import type { FieldMap } from '../resource.js';
import { AUDIT_TABLE } from './audit.js';
import { PAGE_REVISION_COLUMN, PAGE_SEARCH_TEXT_COLUMN, quoted, SEARCH_COLUMN } from './columns.js';
import { AppStoreError } from './errors.js';
import {
  assertDeletable,
  assertExpectedRevision,
  assertMayRestore,
  assertPlacement,
  assertPlacementKept,
  CHILDREN_MAX,
  isRevision,
  nextPosition,
  pageQueryOf,
  pageSearchText,
  preparePageCreate,
  preparePageUpdate,
  prepareMove,
  revisionsKeyOf,
  type PageResource,
} from './page-policy.js';
import type {
  PageDeleteOptions,
  PageRecord,
  PageRestoreOptions,
  PageRevision,
  PageStore,
} from './page-port.js';
import { pageRevisionsTableName } from './page-revisions.js';
import {
  assertAgentMayWrite,
  assertAllowed,
  filtersOf,
  listKeyOf,
  notifyCommitted,
  pageOf,
  pageRequestOf,
  readScopeOf,
  recordIdOf,
  type FieldValues,
  type PageRequest,
} from './policy.js';
import type { AuditAction, ListOptions, Page, SearchOptions } from './port.js';
import { appSchemaName } from './schema-name.js';
import type { AppSqlRunner, StoreOptions } from './store.js';

type Row = Record<string, unknown> & {
  readonly id: string;
  readonly created_at: string;
  readonly revision_id: string;
};

const TIMESTAMP_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** The deepest chain of parents a move's cycle check follows: far above any real tree. */
const CHAIN_MAX = 10_000;

/** A text value as validated: the stores parse every value before it reaches a statement. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A page field's value as a bound parameter cast to its column's type. */
function valueOf(field: string, value: unknown): SQL {
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

/**
 * The PostgreSQL page store of `resource` in the schema of `options.appName`, whose page table and
 * revisions table (and, when audited, `app_audit_events`) the app's migrations created from
 * `createTableSql`.
 *
 * Every refusal is an `AppStoreError`; any other failure becomes `internal_error` with fixed
 * prose, the original kept as `cause` for the server's log only.
 *
 * @throws {RangeError} when `options.appName` is not a valid app name.
 */
export function pageStoreOf<F extends FieldMap>(
  pages: DefinedPages<F>,
  options: StoreOptions,
): PageStore<F> {
  const resource = pages as unknown as PageResource;
  const { db, appName } = options;
  const schema = quoted(appSchemaName(appName));
  const table = sql.raw(`${schema}.${quoted(resource.plural)}`);
  const revisionsTable = sql.raw(`${schema}.${quoted(pageRevisionsTableName(resource))}`);
  const auditTable = sql.raw(`${schema}.${quoted(AUDIT_TABLE)}`);
  const fieldNames = Object.keys(resource.fields);
  const selectList = sql.raw(
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

  const visible = (person: Person): SQL =>
    readScopeOf(resource, person).all ? sql`TRUE` : sql`FALSE`;
  const records = (rows: readonly Record<string, unknown>[]): Row[] => rows.map(recordOf);
  const result = (row: Row): PageRecord<F> => row as unknown as PageRecord<F>;

  /** Serialises the tree changes of one workspace's pages until the transaction ends. */
  const lockTree = async (tx: AppSqlRunner, person: Person): Promise<void> => {
    const key = `aw-app-pages:${schema}.${resource.plural}:${person.workspaceId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  };

  /** The visible page `id`, locked (`FOR UPDATE`, or `FOR SHARE` for a parent), or `undefined`. */
  const findLocked = async (
    tx: AppSqlRunner,
    person: Person,
    id: string,
    mode: 'UPDATE' | 'SHARE',
  ): Promise<Row | undefined> => {
    const key = recordIdOf(id);
    if (key === undefined) return undefined;
    const found = await tx.execute(
      sql`SELECT ${selectList} FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND "id" = ${key}::uuid AND ${visible(person)} FOR ${sql.raw(mode)}`,
    );
    return records(found.rows)[0];
  };

  const lockVisible = async (tx: AppSqlRunner, person: Person, id: string): Promise<Row> => {
    const row = await findLocked(tx, person, id, 'UPDATE');
    if (row === undefined) throw new AppStoreError('resource_not_found');
    return row;
  };

  /** The parent a write names, held for the transaction; it must be a page the person may read. */
  const lockParent = async (
    tx: AppSqlRunner,
    person: Person,
    parent: unknown,
  ): Promise<Row | null> => {
    if (typeof parent !== 'string') return null;
    const row = await findLocked(tx, person, parent, 'SHARE');
    if (row === undefined) throw new AppStoreError('invalid_body', { details: ['parent'] });
    return row;
  };

  const getVisible = async (person: Person, id: string): Promise<Row> => {
    const key = recordIdOf(id);
    if (key === undefined) throw new AppStoreError('resource_not_found');
    const found = await db.execute(
      sql`SELECT ${selectList} FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND "id" = ${key}::uuid AND ${visible(person)}`,
    );
    const [row] = records(found.rows);
    if (row === undefined) throw new AppStoreError('resource_not_found');
    return row;
  };

  /** `parent` and every page above it, by a recursive walk up the tree. */
  const chainOf = async (
    tx: AppSqlRunner,
    person: Person,
    parent: Row | null,
  ): Promise<string[]> => {
    if (parent === null) return [];
    const found = await tx.execute(
      sql`WITH RECURSIVE chain ("id", "parent", "depth") AS (SELECT "id", "parent", 0 FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND "id" = ${parent.id}::uuid UNION ALL SELECT p."id", p."parent", c."depth" + 1 FROM ${table} p JOIN chain c ON p."id" = c."parent" WHERE p."workspace_id" = ${person.workspaceId} AND c."depth" < ${CHAIN_MAX}) SELECT "id" FROM chain`,
    );
    return found.rows.map((row) => String(row['id']));
  };

  const writeAudit = async (
    tx: AppSqlRunner,
    person: Person,
    recordId: string,
    action: AuditAction,
    fields: readonly string[],
  ): Promise<void> => {
    if (!resource.audit) return;
    const names = JSON.stringify(fields);
    await tx.execute(
      sql`INSERT INTO ${auditTable} ("workspace_id", "actor", "via", "run_id", "resource", "record_id", "action", "fields", "at") VALUES (${person.workspaceId}, ${person.principalId}, ${person.via}, ${person.runId ?? null}, ${resource.name}, ${recordId}::uuid, ${action}, ARRAY(SELECT jsonb_array_elements_text(${names}::jsonb)), ${stamp()})`,
    );
  };

  /** Inserts the revision of `page` in its saved state; its id, which the page then points at. */
  const writeRevision = async (
    tx: AppSqlRunner,
    person: Person,
    pageId: string,
    values: FieldValues,
  ): Promise<string> => {
    const id = crypto.randomUUID();
    const runId = person.via === 'agent' ? (person.runId ?? null) : null;
    await tx.execute(
      sql`INSERT INTO ${revisionsTable} ("id", "workspace_id", "page_id", "title", "blocks", "author_principal_id", "via", "run_id", "at") VALUES (${id}::uuid, ${person.workspaceId}, ${pageId}::uuid, ${String(values['title'])}, ${JSON.stringify(values['blocks'])}::jsonb, ${person.principalId}, ${person.via}, ${runId}, ${stamp()})`,
    );
    return id;
  };

  /** The pointer and search terms a save that is a revision also writes. */
  const revisionAssignments = (revisionId: string, values: FieldValues): SQL[] => [
    sql`${sql.raw(quoted(PAGE_REVISION_COLUMN))} = ${revisionId}::uuid`,
    sql`${sql.raw(quoted(PAGE_SEARCH_TEXT_COLUMN))} = ${pageSearchText(String(values['title']), values['blocks'] as RichTextBlock[])}`,
  ];

  /** Saves `values` over `existing` in `tx`: a new revision when the title or body changed, or `revise`. */
  const save = async (
    tx: AppSqlRunner,
    person: Person,
    existing: Row,
    values: FieldValues,
    fields: readonly string[],
    revise: boolean,
  ): Promise<Row> => {
    const merged = { ...existing, ...values };
    const changed = fieldNames.filter(
      (field) => Object.hasOwn(values, field) && field !== 'parent' && field !== 'space',
    );
    const revision =
      revise || isRevision(existing, values)
        ? revisionAssignments(await writeRevision(tx, person, existing.id, merged), merged)
        : [];
    const assignments = [
      ...changed.map((field) => sql`${sql.raw(quoted(field))} = ${valueOf(field, values[field])}`),
      ...revision,
      sql`"updated_by" = ${person.principalId}`,
      sql`"updated_at" = ${stamp()}`,
    ];
    const updated = await tx.execute(
      sql`UPDATE ${table} SET ${sql.join(assignments, sql`, `)} WHERE "workspace_id" = ${person.workspaceId} AND "id" = ${existing.id}::uuid RETURNING ${selectList}`,
    );
    const [row] = records(updated.rows);
    if (row === undefined) throw new AppStoreError('resource_not_found');
    await writeAudit(tx, person, row.id, 'update', fields);
    return row;
  };

  const committed = async (
    event: 'created' | 'updated' | 'deleted',
    row: Row,
    person: Person,
  ): Promise<PageRecord<F>> => {
    await notifyCommitted(options.onCommitted, resource.name, event, row, person);
    return result(row);
  };

  const page = async (
    person: Person,
    request: PageRequest,
    key: string,
    condition: SQL,
  ): Promise<Page<PageRecord<F>>> => {
    const after =
      request.after === null
        ? sql`TRUE`
        : sql`("created_at", "id") < (${request.after.createdAt}::timestamptz, ${request.after.id}::uuid)`;
    const found = await db.execute(
      sql`SELECT ${selectList} FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND ${visible(person)} AND ${condition} AND ${after} ORDER BY "created_at" DESC, "id" DESC LIMIT ${request.limit + 1}`,
    );
    const paged = pageOf(records(found.rows), request, key, person.workspaceId);
    return { items: paged.items.map(result), nextCursor: paged.nextCursor };
  };

  const insert = async (tx: AppSqlRunner, person: Person, values: FieldValues): Promise<Row> => {
    const id = crypto.randomUUID();
    const revisionId = await writeRevision(tx, person, id, values);
    const names = sql.raw(fieldNames.map(quoted).join(', '));
    const parameters = sql.join(
      fieldNames.map((field) => valueOf(field, values[field])),
      sql`, `,
    );
    const at = stamp();
    const searchText = pageSearchText(String(values['title']), values['blocks'] as RichTextBlock[]);
    const inserted = await tx.execute(
      sql`INSERT INTO ${table} ("id", "workspace_id", "created_by", "updated_by", "created_at", "updated_at", ${names}, ${sql.raw(quoted(PAGE_SEARCH_TEXT_COLUMN))}, ${sql.raw(quoted(PAGE_REVISION_COLUMN))}) VALUES (${id}::uuid, ${person.workspaceId}, ${person.principalId}, ${person.principalId}, ${at}, ${at}, ${parameters}, ${searchText}, ${revisionId}::uuid) RETURNING ${selectList}`,
    );
    const [row] = records(inserted.rows);
    if (row === undefined) throw new AppStoreError('internal_error');
    return row;
  };

  return {
    list: (person: Person, listOptions: ListOptions = {}) =>
      guarded(() => {
        const key = listKeyOf(appName, resource);
        const request = pageRequestOf(listOptions, key, person.workspaceId);
        // A page has no enumOf() field, so any filter is refused here.
        filtersOf(resource, listOptions.where);
        return page(person, request, key, sql`TRUE`);
      }),

    get: (person: Person, id: string) => guarded(async () => result(await getVisible(person, id))),

    search: (person: Person, query: string, searchOptions: SearchOptions = {}) =>
      guarded(() => {
        const { tsquery } = pageQueryOf(resource, query);
        const key = listKeyOf(appName, resource, true);
        const request = pageRequestOf(searchOptions, key, person.workspaceId);
        return page(
          person,
          request,
          key,
          sql`${sql.raw(quoted(SEARCH_COLUMN))} @@ to_tsquery('simple', ${tsquery})`,
        );
      }),

    create: (person: Person, input: unknown) =>
      guarded(async () => {
        const created = await db.transaction(async (tx) => {
          await lockTree(tx, person);
          const prepared = await preparePageCreate(resource, person, input, async (parent) => {
            const found = await tx.execute(
              sql`SELECT "position"::float8 AS "position" FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND "parent" IS NOT DISTINCT FROM ${parent}::uuid ORDER BY "position" DESC LIMIT 1`,
            );
            return nextPosition(found.rows.map((row) => Number(row['position'])));
          });
          const parent = await lockParent(tx, person, prepared.values['parent']);
          assertPlacement(resource, prepared.values, parent, []);
          const row = await insert(tx, person, prepared.values);
          await writeAudit(tx, person, row.id, 'create', prepared.fields);
          return row;
        });
        return committed('created', created, person);
      }),

    update: (person: Person, id: string, patch: unknown) =>
      guarded(async () => {
        const prepared = preparePageUpdate(resource, person, patch);
        const updated = await db.transaction(async (tx) => {
          const existing = await lockVisible(tx, person, id);
          assertAllowed('update', resource, person, existing);
          assertPlacementKept(existing, prepared.values);
          assertExpectedRevision(existing.revision_id, prepared.expectedRevisionId);
          return save(tx, person, existing, prepared.values, prepared.fields, false);
        });
        return committed('updated', updated, person);
      }),

    restore: (
      person: Person,
      id: string,
      revisionId: string,
      restoreOptions: PageRestoreOptions = {},
    ) =>
      guarded(async () => {
        assertMayRestore(resource, person);
        const restored = await db.transaction(async (tx) => {
          const existing = await lockVisible(tx, person, id);
          assertAllowed('update', resource, person, existing);
          assertExpectedRevision(existing.revision_id, restoreOptions.expectedRevisionId);
          const key = recordIdOf(revisionId);
          const found =
            key === undefined
              ? { rows: [] }
              : await tx.execute(
                  sql`SELECT "title", "blocks" FROM ${revisionsTable} WHERE "workspace_id" = ${person.workspaceId} AND "page_id" = ${existing.id}::uuid AND "id" = ${key}::uuid`,
                );
          const [revision] = found.rows;
          if (revision === undefined) throw new AppStoreError('revision_not_found');
          const values = { title: revision['title'], blocks: revision['blocks'] };
          return save(tx, person, existing, values, ['title', 'blocks'], true);
        });
        return committed('updated', restored, person);
      }),

    move: (person: Person, id: string, move: unknown) =>
      guarded(async () => {
        const target = prepareMove(resource, person, move);
        const moved = await db.transaction(async (tx) => {
          await lockTree(tx, person);
          const existing = await lockVisible(tx, person, id);
          assertAllowed('update', resource, person, existing);
          const parent = await lockParent(tx, person, target.parent);
          assertPlacement(resource, existing, parent, await chainOf(tx, person, parent));
          const updated = await tx.execute(
            sql`UPDATE ${table} SET "parent" = ${valueOf('parent', target.parent)}, "position" = ${valueOf('position', target.position)}, "updated_by" = ${person.principalId}, "updated_at" = ${stamp()} WHERE "workspace_id" = ${person.workspaceId} AND "id" = ${existing.id}::uuid RETURNING ${selectList}`,
          );
          const [row] = records(updated.rows);
          if (row === undefined) throw new AppStoreError('resource_not_found');
          await writeAudit(tx, person, row.id, 'update', ['parent', 'position']);
          return row;
        });
        return committed('updated', moved, person);
      }),

    delete: (person: Person, id: string, deleteOptions: PageDeleteOptions = {}) =>
      guarded(async () => {
        assertAgentMayWrite(resource, person, []);
        const deleted = await db.transaction(async (tx) => {
          await lockTree(tx, person);
          const existing = await lockVisible(tx, person, id);
          const below = await tx.execute(
            sql`SELECT 1 FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND "parent" = ${existing.id}::uuid LIMIT 1`,
          );
          const cascade = deleteOptions.cascade === true;
          assertDeletable(resource, person, existing, below.rows.length > 0, cascade);
          // The subtree, root first; its revisions stay, as page_id has no foreign key.
          const removed = await tx.execute(
            sql`WITH RECURSIVE subtree ("id", "depth") AS (SELECT ${existing.id}::uuid, 0 UNION ALL SELECT p."id", s."depth" + 1 FROM ${table} p JOIN subtree s ON p."parent" = s."id" WHERE p."workspace_id" = ${person.workspaceId} AND s."depth" < ${CHAIN_MAX}) DELETE FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND "id" IN (SELECT "id" FROM subtree) RETURNING ${selectList}`,
          );
          const rows = records(removed.rows);
          for (const row of rows) await writeAudit(tx, person, row.id, 'delete', []);
          return rows;
        });
        for (const row of deleted) await committed('deleted', row, person);
      }),

    children: (person: Person, parentId: string | null) =>
      guarded(async () => {
        const parent = parentId === null ? null : (await getVisible(person, parentId)).id;
        const found = await db.execute(
          sql`SELECT ${selectList} FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND ${visible(person)} AND "parent" IS NOT DISTINCT FROM ${parent}::uuid ORDER BY "position" ASC, "id" ASC LIMIT ${CHILDREN_MAX}`,
        );
        return records(found.rows).map(result);
      }),

    revisions: (person: Person, id: string, revisionOptions: SearchOptions = {}) =>
      guarded(async () => {
        const existing = await getVisible(person, id);
        const key = revisionsKeyOf(appName, resource, existing.id);
        const request = pageRequestOf(revisionOptions, key, person.workspaceId);
        const after =
          request.after === null
            ? sql`TRUE`
            : sql`("at", "id") < (${request.after.createdAt}::timestamptz, ${request.after.id}::uuid)`;
        const found = await db.execute(
          sql`SELECT "id", "workspace_id", "page_id", "title", "blocks", "author_principal_id", "run_id", to_char("at" AT TIME ZONE 'UTC', ${sql.raw(TIMESTAMP_US)}) AS "at" FROM ${revisionsTable} WHERE "workspace_id" = ${person.workspaceId} AND "page_id" = ${existing.id}::uuid AND ${after} ORDER BY "at" DESC, "id" DESC LIMIT ${request.limit + 1}`,
        );
        const keyed = found.rows.map((row) => ({
          id: textOf(row['id']),
          created_at: textOf(row['at']),
          revision: row as unknown as PageRevision,
        }));
        const paged = pageOf(keyed, request, key, person.workspaceId);
        return {
          items: paged.items.map((item) => item.revision),
          nextCursor: paged.nextCursor,
        };
      }),
  };
}
