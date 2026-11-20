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

import type { DefinedPages } from '../pages/define-pages.js';
import type { Person } from '../person.js';
import type { FieldMap } from '../resource.js';
import { quoted, SEARCH_COLUMN } from './columns.js';
import { AppStoreError } from './errors.js';
import {
  assertDeletable,
  assertExpectedRevision,
  assertMayRestore,
  assertPlacement,
  assertPlacementKept,
  CHILDREN_MAX,
  nextPosition,
  pageQueryOf,
  preparePageCreate,
  preparePageUpdate,
  prepareMove,
  revisionsKeyOf,
  type PreparedPageUpdate,
} from './page-policy.js';
import type {
  PageDeleteOptions,
  PageMove,
  PageRecord,
  PageRestoreOptions,
  PageRevision,
  PageStore,
} from './page-port.js';
import {
  pageContextOf,
  recordsOf,
  textOf,
  TIMESTAMP_US,
  valueOf,
  visibleTo,
  type PageContext,
  type Row,
} from './page-store-context.js';
import {
  chainOf,
  deleteSubtree,
  insert,
  lockParent,
  lockTree,
  lockVisible,
  save,
  stampAssignments,
  updateReturning,
  writeAudit,
  type Session,
} from './page-store-writes.js';
import {
  assertAgentMayWrite,
  assertAllowed,
  filtersOf,
  listKeyOf,
  notifyCommitted,
  pageOf,
  pageRequestOf,
  recordIdOf,
  type PageRequest,
} from './policy.js';
import type { ListOptions, Page, SearchOptions } from './port.js';
import type { StoreOptions } from './store.js';

type Event = 'created' | 'updated' | 'deleted';

const asRecord = <F extends FieldMap>(row: Row): PageRecord<F> => row as unknown as PageRecord<F>;

async function getVisible(context: PageContext, person: Person, id: string): Promise<Row> {
  const key = recordIdOf(id);
  if (key === undefined) throw new AppStoreError('resource_not_found');
  const { table, selectList } = context;
  const found = await context.options.db.execute(
    sql`SELECT ${selectList} FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND "id" = ${key}::uuid AND ${visibleTo(context, person)}`,
  );
  const [row] = recordsOf(found.rows);
  if (row === undefined) throw new AppStoreError('resource_not_found');
  return row;
}

async function committed<F extends FieldMap>(
  context: PageContext,
  event: Event,
  row: Row,
  person: Person,
): Promise<PageRecord<F>> {
  const { options, resource } = context;
  await notifyCommitted(options.onCommitted, resource.name, event, row, person);
  return asRecord<F>(row);
}

/** One page of the person's visible pages that satisfy `condition`, newest first. */
async function pageOfRows<F extends FieldMap>(
  context: PageContext,
  person: Person,
  request: PageRequest,
  paging: { readonly key: string; readonly condition: SQL },
): Promise<Page<PageRecord<F>>> {
  const { table, selectList } = context;
  const after =
    request.after === null
      ? sql`TRUE`
      : sql`("created_at", "id") < (${request.after.createdAt}::timestamptz, ${request.after.id}::uuid)`;
  const found = await context.options.db.execute(
    sql`SELECT ${selectList} FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND ${visibleTo(context, person)} AND ${paging.condition} AND ${after} ORDER BY "created_at" DESC, "id" DESC LIMIT ${request.limit + 1}`,
  );
  const paged = pageOf(recordsOf(found.rows), request, paging.key, person.workspaceId);
  return { items: paged.items.map((row) => asRecord<F>(row)), nextCursor: paged.nextCursor };
}

function listPages<F extends FieldMap>(
  context: PageContext,
  person: Person,
  listOptions: ListOptions,
): Promise<Page<PageRecord<F>>> {
  const key = listKeyOf(context.options.appName, context.resource);
  const request = pageRequestOf(listOptions, key, person.workspaceId);
  // A page has no enumOf() field, so any filter is refused here.
  filtersOf(context.resource, listOptions.where);
  return pageOfRows<F>(context, person, request, { key, condition: sql`TRUE` });
}

function searchPages<F extends FieldMap>(
  context: PageContext,
  person: Person,
  query: string,
  searchOptions: SearchOptions,
): Promise<Page<PageRecord<F>>> {
  const { tsquery } = pageQueryOf(context.resource, query);
  const key = listKeyOf(context.options.appName, context.resource, true);
  const request = pageRequestOf(searchOptions, key, person.workspaceId);
  const condition = sql`${sql.raw(quoted(SEARCH_COLUMN))} @@ to_tsquery('simple', ${tsquery})`;
  return pageOfRows<F>(context, person, request, { key, condition });
}

/** The position after the last child of `parent`, read in the create's transaction. */
async function nextChildPosition(session: Session, parent: string | null): Promise<number> {
  const { context, tx, person } = session;
  const found = await tx.execute(
    sql`SELECT "position"::float8 AS "position" FROM ${context.table} WHERE "workspace_id" = ${person.workspaceId} AND "parent" IS NOT DISTINCT FROM ${parent}::uuid ORDER BY "position" DESC LIMIT 1`,
  );
  return nextPosition(found.rows.map((row) => Number(row['position'])));
}

async function createPage(session: Session, input: unknown): Promise<Row> {
  await lockTree(session);
  const { resource } = session.context;
  const prepared = await preparePageCreate(resource, session.person, input, (parent) =>
    nextChildPosition(session, parent),
  );
  const parent = await lockParent(session, prepared.values['parent']);
  assertPlacement(resource, prepared.values, parent, []);
  const row = await insert(session, prepared.values);
  await writeAudit(session, 'create', row.id, prepared.fields);
  return row;
}

/** Saves a patch already validated by `preparePageUpdate`, before the transaction opened. */
async function updatePage(
  session: Session,
  id: string,
  prepared: PreparedPageUpdate,
): Promise<Row> {
  const { resource } = session.context;
  const existing = await lockVisible(session, id);
  assertAllowed('update', resource, session.person, existing);
  assertPlacementKept(existing, prepared.values);
  assertExpectedRevision(existing.revision_id, prepared.expectedRevisionId);
  return save(session, existing, {
    values: prepared.values,
    fields: prepared.fields,
    revise: false,
  });
}

/** The title and body of revision `revisionId` of the page `pageId`. */
async function findRevisionContent(
  { context, tx, person }: Session,
  pageId: string,
  revisionId: string,
): Promise<{ title: unknown; blocks: unknown }> {
  const key = recordIdOf(revisionId);
  const found =
    key === undefined
      ? { rows: [] }
      : await tx.execute(
          sql`SELECT "title", "blocks" FROM ${context.revisionsTable} WHERE "workspace_id" = ${person.workspaceId} AND "page_id" = ${pageId}::uuid AND "id" = ${key}::uuid`,
        );
  const [revision] = found.rows;
  if (revision === undefined) throw new AppStoreError('revision_not_found');
  return { title: revision['title'], blocks: revision['blocks'] };
}

async function restorePage(
  session: Session,
  id: string,
  revisionId: string,
  restoreOptions: PageRestoreOptions,
): Promise<Row> {
  const existing = await lockVisible(session, id);
  assertAllowed('update', session.context.resource, session.person, existing);
  assertExpectedRevision(existing.revision_id, restoreOptions.expectedRevisionId);
  const values = await findRevisionContent(session, existing.id, revisionId);
  return save(session, existing, { values, fields: ['title', 'blocks'], revise: true });
}

/** Moves the page to a target already validated by `prepareMove`, before the transaction opened. */
async function movePage(session: Session, id: string, target: PageMove): Promise<Row> {
  const { resource } = session.context;
  await lockTree(session);
  const existing = await lockVisible(session, id);
  assertAllowed('update', resource, session.person, existing);
  const parent = await lockParent(session, target.parent);
  assertPlacement(resource, existing, parent, await chainOf(session, parent));
  const row = await updateReturning(session, existing.id, [
    sql`"parent" = ${valueOf('parent', target.parent)}`,
    sql`"position" = ${valueOf('position', target.position)}`,
    ...stampAssignments(session),
  ]);
  await writeAudit(session, 'update', row.id, ['parent', 'position']);
  return row;
}

async function deletePages(
  session: Session,
  id: string,
  deleteOptions: PageDeleteOptions,
): Promise<Row[]> {
  const { context, tx, person } = session;
  await lockTree(session);
  const existing = await lockVisible(session, id);
  const below = await tx.execute(
    sql`SELECT 1 FROM ${context.table} WHERE "workspace_id" = ${person.workspaceId} AND "parent" = ${existing.id}::uuid LIMIT 1`,
  );
  assertDeletable(
    context.resource,
    person,
    existing,
    below.rows.length > 0,
    deleteOptions.cascade === true,
  );
  const rows = await deleteSubtree(session, existing.id);
  for (const row of rows) await writeAudit(session, 'delete', row.id, []);
  return rows;
}

async function childrenOf<F extends FieldMap>(
  context: PageContext,
  person: Person,
  parentId: string | null,
): Promise<PageRecord<F>[]> {
  const parent = parentId === null ? null : (await getVisible(context, person, parentId)).id;
  const { table, selectList } = context;
  const found = await context.options.db.execute(
    sql`SELECT ${selectList} FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND ${visibleTo(context, person)} AND "parent" IS NOT DISTINCT FROM ${parent}::uuid ORDER BY "position" ASC, "id" ASC LIMIT ${CHILDREN_MAX}`,
  );
  return recordsOf(found.rows).map((row) => asRecord<F>(row));
}

async function revisionsOf(
  context: PageContext,
  person: Person,
  id: string,
  revisionOptions: SearchOptions,
): Promise<Page<PageRevision>> {
  const existing = await getVisible(context, person, id);
  const key = revisionsKeyOf(context.options.appName, context.resource, existing.id);
  const request = pageRequestOf(revisionOptions, key, person.workspaceId);
  const after =
    request.after === null
      ? sql`TRUE`
      : sql`("at", "id") < (${request.after.createdAt}::timestamptz, ${request.after.id}::uuid)`;
  const found = await context.options.db.execute(
    sql`SELECT "id", "workspace_id", "page_id", "title", "blocks", "author_principal_id", "run_id", to_char("at" AT TIME ZONE 'UTC', ${sql.raw(TIMESTAMP_US)}) AS "at" FROM ${context.revisionsTable} WHERE "workspace_id" = ${person.workspaceId} AND "page_id" = ${existing.id}::uuid AND ${after} ORDER BY "at" DESC, "id" DESC LIMIT ${request.limit + 1}`,
  );
  const keyed = found.rows.map((row) => ({
    id: textOf(row['id']),
    created_at: textOf(row['at']),
    revision: row as unknown as PageRevision,
  }));
  const paged = pageOf(keyed, request, key, person.workspaceId);
  return { items: paged.items.map((item) => item.revision), nextCursor: paged.nextCursor };
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
  const context = pageContextOf(pages, options);
  const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AppStoreError) throw error;
      throw new AppStoreError('internal_error', { cause: error });
    }
  };
  /** Runs `work` in a transaction of `person`'s. */
  const inTransaction = <T>(person: Person, work: (session: Session) => Promise<T>): Promise<T> =>
    options.db.transaction((tx) => work({ context, tx, person }));
  /** Runs a write in a transaction, then tells the app it committed. */
  const written = async (event: Event, person: Person, work: (session: Session) => Promise<Row>) =>
    committed<F>(context, event, await inTransaction(person, work), person);

  return {
    list: (person, listOptions = {}) => guarded(() => listPages<F>(context, person, listOptions)),
    get: (person, id) => guarded(async () => asRecord<F>(await getVisible(context, person, id))),
    search: (person, query, searchOptions = {}) =>
      guarded(() => searchPages<F>(context, person, query, searchOptions)),
    create: (person, input) =>
      guarded(() => written('created', person, (session) => createPage(session, input))),
    update: (person, id, patch) =>
      guarded(() => {
        const prepared = preparePageUpdate(context.resource, person, patch);
        return written('updated', person, (session) => updatePage(session, id, prepared));
      }),
    restore: (person, id, revisionId, restoreOptions = {}) =>
      guarded(() => {
        assertMayRestore(context.resource, person);
        return written('updated', person, (session) =>
          restorePage(session, id, revisionId, restoreOptions),
        );
      }),
    move: (person, id, move) =>
      guarded(() => {
        const target = prepareMove(context.resource, person, move);
        return written('updated', person, (session) => movePage(session, id, target));
      }),
    delete: (person, id, deleteOptions = {}) =>
      guarded(async () => {
        assertAgentMayWrite(context.resource, person, []);
        const deleted = await inTransaction(person, (session) =>
          deletePages(session, id, deleteOptions),
        );
        for (const row of deleted) await committed<F>(context, 'deleted', row, person);
      }),
    children: (person, parentId) => guarded(() => childrenOf<F>(context, person, parentId)),
    revisions: (person, id, revisionOptions = {}) =>
      guarded(() => revisionsOf(context, person, id, revisionOptions)),
  };
}
