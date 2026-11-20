/**
 * The statements of the PostgreSQL page store (`page-store.ts`) that run inside a transaction: the
 * tree lock, the locked reads, the revision and audit rows, and the saves, inserts and deletes.
 * A `Session` bundles the context, the transaction and the person every one of them needs.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { RichTextBlock } from '../fields/rich-text.js';
import type { Person } from '../person.js';
import { PAGE_REVISION_COLUMN, PAGE_SEARCH_TEXT_COLUMN, quoted } from './columns.js';
import { AppStoreError } from './errors.js';
import { isRevision, pageSearchText } from './page-policy.js';
import {
  recordsOf,
  stampOf,
  valueOf,
  visibleTo,
  type PageContext,
  type Row,
} from './page-store-context.js';
import { recordIdOf, type FieldValues } from './policy.js';
import type { AuditAction } from './port.js';
import type { AppSqlRunner } from './store.js';

/** The deepest chain of parents a move's cycle check follows: far above any real tree. */
const CHAIN_MAX = 10_000;

export interface Session {
  readonly context: PageContext;
  readonly tx: AppSqlRunner;
  readonly person: Person;
}

/** The change a save applies: the values, the field names it audits, and whether it is a revision. */
interface PageChange {
  readonly values: FieldValues;
  readonly fields: readonly string[];
  readonly revise: boolean;
}

/** Serialises the tree changes of one workspace's pages until the transaction ends. */
export async function lockTree({ context, tx, person }: Session): Promise<void> {
  const key = `aw-app-pages:${context.schema}.${context.resource.plural}:${person.workspaceId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

/** The visible page `id`, locked (`FOR UPDATE`, or `FOR SHARE` for a parent), or `undefined`. */
async function findLocked(
  { context, tx, person }: Session,
  id: string,
  mode: 'UPDATE' | 'SHARE',
): Promise<Row | undefined> {
  const key = recordIdOf(id);
  if (key === undefined) return undefined;
  const { table, selectList } = context;
  const found = await tx.execute(
    sql`SELECT ${selectList} FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND "id" = ${key}::uuid AND ${visibleTo(context, person)} FOR ${sql.raw(mode)}`,
  );
  return recordsOf(found.rows)[0];
}

export async function lockVisible(session: Session, id: string): Promise<Row> {
  const row = await findLocked(session, id, 'UPDATE');
  if (row === undefined) throw new AppStoreError('resource_not_found');
  return row;
}

/** The parent a write names, held for the transaction; it must be a page the person may read. */
export async function lockParent(session: Session, parent: unknown): Promise<Row | null> {
  if (typeof parent !== 'string') return null;
  const row = await findLocked(session, parent, 'SHARE');
  if (row === undefined) throw new AppStoreError('invalid_body', { details: ['parent'] });
  return row;
}

/** `parent` and every page above it, by a recursive walk up the tree. */
export async function chainOf(
  { context, tx, person }: Session,
  parent: Row | null,
): Promise<string[]> {
  if (parent === null) return [];
  const { table } = context;
  const found = await tx.execute(
    sql`WITH RECURSIVE chain ("id", "parent", "depth") AS (SELECT "id", "parent", 0 FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND "id" = ${parent.id}::uuid UNION ALL SELECT p."id", p."parent", c."depth" + 1 FROM ${table} p JOIN chain c ON p."id" = c."parent" WHERE p."workspace_id" = ${person.workspaceId} AND c."depth" < ${CHAIN_MAX}) SELECT "id" FROM chain`,
  );
  return found.rows.map((row) => String(row['id']));
}

/** The audit row of `action` on `recordId`, when the resource is audited. */
export async function writeAudit(
  { context, tx, person }: Session,
  action: AuditAction,
  recordId: string,
  fields: readonly string[],
): Promise<void> {
  const { resource, auditTable } = context;
  if (!resource.audit) return;
  const names = JSON.stringify(fields);
  await tx.execute(
    sql`INSERT INTO ${auditTable} ("workspace_id", "actor", "via", "run_id", "resource", "record_id", "action", "fields", "at") VALUES (${person.workspaceId}, ${person.principalId}, ${person.via}, ${person.runId ?? null}, ${resource.name}, ${recordId}::uuid, ${action}, ARRAY(SELECT jsonb_array_elements_text(${names}::jsonb)), ${stampOf(context)})`,
  );
}

/** Inserts the revision of `pageId` in its saved state; its id, which the page then points at. */
async function writeRevision(
  { context, tx, person }: Session,
  pageId: string,
  values: FieldValues,
): Promise<string> {
  const id = crypto.randomUUID();
  const runId = person.via === 'agent' ? (person.runId ?? null) : null;
  await tx.execute(
    sql`INSERT INTO ${context.revisionsTable} ("id", "workspace_id", "page_id", "title", "blocks", "author_principal_id", "via", "run_id", "at") VALUES (${id}::uuid, ${person.workspaceId}, ${pageId}::uuid, ${String(values['title'])}, ${JSON.stringify(values['blocks'])}::jsonb, ${person.principalId}, ${person.via}, ${runId}, ${stampOf(context)})`,
  );
  return id;
}

function searchTextOf(values: FieldValues): string {
  return pageSearchText(String(values['title']), values['blocks'] as RichTextBlock[]);
}

/** The pointer and search terms a save that is a revision also writes. */
function revisionAssignments(revisionId: string, values: FieldValues): SQL[] {
  return [
    sql`${sql.raw(quoted(PAGE_REVISION_COLUMN))} = ${revisionId}::uuid`,
    sql`${sql.raw(quoted(PAGE_SEARCH_TEXT_COLUMN))} = ${searchTextOf(values)}`,
  ];
}

/** The `UPDATE ... RETURNING` of the page `id`: its one row, which must exist. */
export async function updateReturning(
  { context, tx, person }: Session,
  id: string,
  assignments: readonly SQL[],
): Promise<Row> {
  const { table, selectList } = context;
  const updated = await tx.execute(
    sql`UPDATE ${table} SET ${sql.join([...assignments], sql`, `)} WHERE "workspace_id" = ${person.workspaceId} AND "id" = ${id}::uuid RETURNING ${selectList}`,
  );
  const [row] = recordsOf(updated.rows);
  if (row === undefined) throw new AppStoreError('resource_not_found');
  return row;
}

/** The assignments that stamp who changed a page, and when. */
export function stampAssignments({ context, person }: Session): SQL[] {
  return [sql`"updated_by" = ${person.principalId}`, sql`"updated_at" = ${stampOf(context)}`];
}

/** Saves the change over `existing`: a new revision when the title or body changed, or `revise`. */
export async function save(session: Session, existing: Row, change: PageChange): Promise<Row> {
  const { values, fields, revise } = change;
  const merged = { ...existing, ...values };
  const changed = session.context.fieldNames.filter(
    (field) => Object.hasOwn(values, field) && field !== 'parent' && field !== 'space',
  );
  const revision =
    revise || isRevision(existing, values)
      ? revisionAssignments(await writeRevision(session, existing.id, merged), merged)
      : [];
  const row = await updateReturning(session, existing.id, [
    ...changed.map((field) => sql`${sql.raw(quoted(field))} = ${valueOf(field, values[field])}`),
    ...revision,
    ...stampAssignments(session),
  ]);
  await writeAudit(session, 'update', row.id, fields);
  return row;
}

/** Inserts a new page with its first revision. */
export async function insert(session: Session, values: FieldValues): Promise<Row> {
  const { context, tx, person } = session;
  const { fieldNames, table, selectList } = context;
  const id = crypto.randomUUID();
  const revisionId = await writeRevision(session, id, values);
  const names = sql.raw(fieldNames.map(quoted).join(', '));
  const parameters = sql.join(
    fieldNames.map((field) => valueOf(field, values[field])),
    sql`, `,
  );
  const at = stampOf(context);
  const inserted = await tx.execute(
    sql`INSERT INTO ${table} ("id", "workspace_id", "created_by", "updated_by", "created_at", "updated_at", ${names}, ${sql.raw(quoted(PAGE_SEARCH_TEXT_COLUMN))}, ${sql.raw(quoted(PAGE_REVISION_COLUMN))}) VALUES (${id}::uuid, ${person.workspaceId}, ${person.principalId}, ${person.principalId}, ${at}, ${at}, ${parameters}, ${searchTextOf(values)}, ${revisionId}::uuid) RETURNING ${selectList}`,
  );
  const [row] = recordsOf(inserted.rows);
  if (row === undefined) throw new AppStoreError('internal_error');
  return row;
}

/** Deletes the subtree rooted at `rootId`, root first; its revisions stay, as page_id has no foreign key. */
export async function deleteSubtree(
  { context, tx, person }: Session,
  rootId: string,
): Promise<Row[]> {
  const { table, selectList } = context;
  const removed = await tx.execute(
    sql`WITH RECURSIVE subtree ("id", "depth") AS (SELECT ${rootId}::uuid, 0 UNION ALL SELECT p."id", s."depth" + 1 FROM ${table} p JOIN subtree s ON p."parent" = s."id" WHERE p."workspace_id" = ${person.workspaceId} AND s."depth" < ${CHAIN_MAX}) DELETE FROM ${table} WHERE "workspace_id" = ${person.workspaceId} AND "id" IN (SELECT "id" FROM subtree) RETURNING ${selectList}`,
  );
  return recordsOf(removed.rows);
}
