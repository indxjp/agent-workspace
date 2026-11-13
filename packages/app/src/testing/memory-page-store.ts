/**
 * `memoryPageStoreOf`: the in-memory twin of `pageStoreOf` (issue #1520), for an app's own tests.
 * It implements the same `PageStore` port with the same validation, access checks, tree rules,
 * revisions and errors (it shares them, `db/policy.ts` and `db/page-policy.ts`), and searches with
 * the same terms (`db/search-terms.ts`); one conformance suite holds both stores to it.
 */
import type { DefinedPages } from '../pages/define-pages.js';
import type { Person } from '../person.js';
import type { FieldMap } from '../resource.js';
import { AppStoreError } from '../db/errors.js';
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
} from '../db/page-policy.js';
import type {
  PageDeleteOptions,
  PageRecord,
  PageRestoreOptions,
  PageRevision,
  PageStore,
} from '../db/page-port.js';
import {
  assertAgentMayWrite,
  assertAllowed,
  filtersOf,
  isVisible,
  listKeyOf,
  notifyCommitted,
  pageOf,
  pageRequestOf,
  readScopeOf,
  recordIdOf,
  type FieldValues,
  type PageRequest,
} from '../db/policy.js';
import type {
  AuditAction,
  AuditEvent,
  CommittedEvent,
  ListOptions,
  Page,
  SearchOptions,
} from '../db/port.js';
import { termsMatch } from '../db/search-terms.js';
import type { RichTextBlock } from '../fields/rich-text.js';
import {
  copyOf,
  isAfter,
  newestFirst,
  type KeyedRow,
  type MemoryStoreOptions,
  type StoreOperation,
} from './memory-store.js';

/** The in-memory page store: the port, plus what a test inspects. */
export interface MemoryPageStore<F extends FieldMap = FieldMap> extends PageStore<F> {
  /** How many times each `ResourceStore` operation was called, refused calls included. */
  readonly calls: Readonly<Record<StoreOperation, number>>;
  /** The audit rows written so far, oldest first. */
  auditEvents(): readonly AuditEvent[];
  /** Every revision kept of `pageId`, oldest first, those of a deleted page included. */
  storedRevisions(pageId: string): readonly PageRevision[];
}

type Row = KeyedRow & { readonly revision_id: string };

/** A kept revision, keyed by `(at, id)` for the shared paging. */
interface RevisionRow {
  readonly id: string;
  readonly created_at: string;
  readonly revision: PageRevision;
}

function byPosition(a: Row, b: Row): number {
  const order = Number(a['position']) - Number(b['position']);
  return order !== 0 ? order : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The in-memory page store of `resource`: a `Map` of pages per workspace and a list of revisions,
 * behaving as `pageStoreOf` does. Each call returns copies.
 */
export function memoryPageStoreOf<F extends FieldMap>(
  pages: DefinedPages<F>,
  options: MemoryStoreOptions = {},
): MemoryPageStore<F> {
  const resource = pages as unknown as PageResource;
  const appName = options.appName ?? 'app';
  const now = options.now ?? (() => new Date());
  const workspaces = new Map<string, Map<string, Row>>();
  const searchTexts = new Map<string, string>();
  const revisionRows: RevisionRow[] = [];
  const audit: AuditEvent[] = [];
  const calls: Record<StoreOperation, number> = {
    list: 0,
    get: 0,
    search: 0,
    create: 0,
    update: 0,
    delete: 0,
  };

  const rowsOf = (workspaceId: string): Map<string, Row> => {
    let rows = workspaces.get(workspaceId);
    if (rows === undefined) {
      rows = new Map();
      workspaces.set(workspaceId, rows);
    }
    return rows;
  };

  /** The page `id` of the person's workspace, if they may read it. */
  const findVisible = (person: Person, id: string): Row | undefined => {
    const scope = readScopeOf(resource, person);
    const key = recordIdOf(id);
    const row = key === undefined ? undefined : workspaces.get(person.workspaceId)?.get(key);
    return row !== undefined && isVisible(scope, person, row) ? row : undefined;
  };

  const visibleRow = (person: Person, id: string): Row => {
    const row = findVisible(person, id);
    if (row === undefined) throw new AppStoreError('resource_not_found');
    return row;
  };

  /** The parent a write names, which must be a page the person may read. */
  const parentRow = (person: Person, parent: unknown): Row | null => {
    if (typeof parent !== 'string') return null;
    const row = findVisible(person, parent);
    if (row === undefined) throw new AppStoreError('invalid_body', { details: ['parent'] });
    return row;
  };

  const childrenOf = (workspaceId: string, parent: string | null): Row[] =>
    [...rowsOf(workspaceId).values()]
      .filter((row) => (row['parent'] ?? null) === parent)
      .sort(byPosition);

  /** `row` and every page above it, nearest first. */
  const chainOf = (workspaceId: string, row: Row | null): string[] => {
    const chain: string[] = [];
    for (let at = row; at !== null && !chain.includes(at.id);) {
      chain.push(at.id);
      const up = at['parent'];
      at = typeof up === 'string' ? (rowsOf(workspaceId).get(up) ?? null) : null;
    }
    return chain;
  };

  const subtreeOf = (workspaceId: string, root: Row): Row[] => {
    const found: Row[] = [root];
    for (let index = 0; index < found.length; index += 1) {
      found.push(...childrenOf(workspaceId, found[index]?.id ?? ''));
    }
    return found;
  };

  const record = (row: Row): PageRecord<F> => copyOf(row) as unknown as PageRecord<F>;

  const writeAudit = (
    person: Person,
    recordId: string,
    action: AuditAction,
    fields: readonly string[],
    at: string,
  ): void => {
    if (!resource.audit) return;
    audit.push({
      id: crypto.randomUUID(),
      workspace_id: person.workspaceId,
      actor: person.principalId,
      via: person.via,
      run_id: person.runId ?? null,
      resource: resource.name,
      record_id: recordId,
      action,
      fields: [...fields],
      at,
    });
  };

  /** Records `row`'s title and body as a revision, and indexes them; the revision's id. */
  const writeRevision = (person: Person, row: KeyedRow, at: string): string => {
    const id = crypto.randomUUID();
    const title = String(row['title']);
    const blocks = row['blocks'] as RichTextBlock[];
    const revision: PageRevision = {
      id,
      workspace_id: person.workspaceId,
      page_id: row.id,
      title,
      blocks: copyOf(blocks),
      author_principal_id: person.principalId,
      run_id: person.via === 'agent' ? (person.runId ?? null) : null,
      at,
    };
    revisionRows.push({ id, created_at: at, revision });
    searchTexts.set(row.id, pageSearchText(title, blocks));
    return id;
  };

  const committed = async (
    event: CommittedEvent,
    row: Row,
    person: Person,
  ): Promise<PageRecord<F>> => {
    await notifyCommitted(options.onCommitted, resource.name, event, row, person);
    return record(row);
  };

  /** Saves `values` over `existing`: a new revision when the title or body changed, or `revise`. */
  const save = (
    person: Person,
    existing: Row,
    values: FieldValues,
    fields: readonly string[],
    revise: boolean,
  ): Promise<PageRecord<F>> => {
    const at = now().toISOString();
    const next: KeyedRow = {
      ...existing,
      ...copyOf(values),
      updated_by: person.principalId,
      updated_at: at,
    };
    const revisionId =
      revise || isRevision(existing, values)
        ? writeRevision(person, next, at)
        : existing.revision_id;
    const row: Row = { ...next, revision_id: revisionId };
    rowsOf(person.workspaceId).set(row.id, row);
    writeAudit(person, row.id, 'update', fields, at);
    return committed('updated', row, person);
  };

  const page = (
    person: Person,
    request: PageRequest,
    key: string,
    keep: (row: Row) => boolean,
  ): Page<PageRecord<F>> => {
    const scope = readScopeOf(resource, person);
    const rows = [...(workspaces.get(person.workspaceId)?.values() ?? [])]
      .filter((row) => isVisible(scope, person, row) && keep(row) && isAfter(row, request))
      .sort(newestFirst)
      .slice(0, request.limit + 1);
    const result = pageOf(rows, request, key, person.workspaceId);
    return { items: result.items.map(record), nextCursor: result.nextCursor };
  };

  const later = <T>(run: () => T | Promise<T>): Promise<T> => Promise.resolve().then(run);

  return {
    calls,
    auditEvents: () => copyOf(audit),
    storedRevisions: (pageId) =>
      revisionRows
        .filter((row) => row.revision.page_id === pageId)
        .map((row) => copyOf(row.revision)),

    list(person: Person, listOptions: ListOptions = {}) {
      calls.list += 1;
      return later(() => {
        const key = listKeyOf(appName, resource);
        const request = pageRequestOf(listOptions, key, person.workspaceId);
        const filters = filtersOf(resource, listOptions.where);
        return page(person, request, key, (row) =>
          filters.every(([field, value]) => row[field] === value),
        );
      });
    },

    get(person: Person, id: string) {
      calls.get += 1;
      return later(() => record(visibleRow(person, id)));
    },

    search(person: Person, query: string, searchOptions: SearchOptions = {}) {
      calls.search += 1;
      return later(() => {
        const { text } = pageQueryOf(resource, query);
        const key = listKeyOf(appName, resource, true);
        const request = pageRequestOf(searchOptions, key, person.workspaceId);
        return page(person, request, key, (row) =>
          termsMatch((searchTexts.get(row.id) ?? '').split(' '), text),
        );
      });
    },

    create(person: Person, input: unknown) {
      calls.create += 1;
      return later(async () => {
        const prepared = await preparePageCreate(resource, person, input, (parent) =>
          Promise.resolve(
            nextPosition(
              childrenOf(person.workspaceId, parent).map((row) => Number(row['position'])),
            ),
          ),
        );
        const parent = parentRow(person, prepared.values['parent']);
        assertPlacement(resource, prepared.values, parent, []);
        const at = now().toISOString();
        const draft: KeyedRow = {
          ...copyOf(prepared.values),
          id: crypto.randomUUID(),
          workspace_id: person.workspaceId,
          created_by: person.principalId,
          updated_by: person.principalId,
          created_at: at,
          updated_at: at,
        };
        const row: Row = { ...draft, revision_id: writeRevision(person, draft, at) };
        rowsOf(person.workspaceId).set(row.id, row);
        writeAudit(person, row.id, 'create', prepared.fields, at);
        return committed('created', row, person);
      });
    },

    update(person: Person, id: string, patch: unknown) {
      calls.update += 1;
      return later(() => {
        const prepared = preparePageUpdate(resource, person, patch);
        const existing = visibleRow(person, id);
        assertAllowed('update', resource, person, existing);
        assertPlacementKept(existing, prepared.values);
        assertExpectedRevision(existing.revision_id, prepared.expectedRevisionId);
        return save(person, existing, prepared.values, prepared.fields, false);
      });
    },

    restore(
      person: Person,
      id: string,
      revisionId: string,
      restoreOptions: PageRestoreOptions = {},
    ) {
      return later(() => {
        assertMayRestore(resource, person);
        const existing = visibleRow(person, id);
        assertAllowed('update', resource, person, existing);
        assertExpectedRevision(existing.revision_id, restoreOptions.expectedRevisionId);
        const key = recordIdOf(revisionId);
        const revision = revisionRows.find(
          (row) =>
            row.id === key &&
            row.revision.workspace_id === person.workspaceId &&
            row.revision.page_id === existing.id,
        );
        if (revision === undefined) throw new AppStoreError('revision_not_found');
        const values = { title: revision.revision.title, blocks: copyOf(revision.revision.blocks) };
        return save(person, existing, values, ['title', 'blocks'], true);
      });
    },

    move(person: Person, id: string, move: unknown) {
      return later(() => {
        const target = prepareMove(resource, person, move);
        const existing = visibleRow(person, id);
        assertAllowed('update', resource, person, existing);
        const parent = parentRow(person, target.parent);
        assertPlacement(resource, existing, parent, chainOf(person.workspaceId, parent));
        const at = now().toISOString();
        const row: Row = {
          ...existing,
          parent: target.parent,
          position: target.position,
          updated_by: person.principalId,
          updated_at: at,
        };
        rowsOf(person.workspaceId).set(row.id, row);
        writeAudit(person, row.id, 'update', ['parent', 'position'], at);
        return committed('updated', row, person);
      });
    },

    delete(person: Person, id: string, deleteOptions: PageDeleteOptions = {}) {
      calls.delete += 1;
      return later(async () => {
        assertAgentMayWrite(resource, person, []);
        const existing = visibleRow(person, id);
        const hasChildren = childrenOf(person.workspaceId, existing.id).length > 0;
        assertDeletable(resource, person, existing, hasChildren, deleteOptions.cascade === true);
        const at = now().toISOString();
        const deleted = subtreeOf(person.workspaceId, existing);
        for (const row of deleted) {
          rowsOf(person.workspaceId).delete(row.id);
          searchTexts.delete(row.id);
          writeAudit(person, row.id, 'delete', [], at);
        }
        for (const row of deleted) await committed('deleted', row, person);
      });
    },

    children(person: Person, parentId: string | null) {
      return later(() => {
        readScopeOf(resource, person);
        const parent = parentId === null ? null : visibleRow(person, parentId).id;
        return childrenOf(person.workspaceId, parent).slice(0, CHILDREN_MAX).map(record);
      });
    },

    revisions(person: Person, id: string, revisionOptions: SearchOptions = {}) {
      return later(() => {
        const existing = visibleRow(person, id);
        const key = revisionsKeyOf(appName, resource, existing.id);
        const request = pageRequestOf(revisionOptions, key, person.workspaceId);
        const rows = revisionRows
          .filter(
            (row) =>
              row.revision.workspace_id === person.workspaceId &&
              row.revision.page_id === existing.id &&
              isAfter(row, request),
          )
          .sort(newestFirst)
          .slice(0, request.limit + 1);
        const result = pageOf(rows, request, key, person.workspaceId);
        return {
          items: result.items.map((row) => copyOf(row.revision)),
          nextCursor: result.nextCursor,
        };
      });
    },
  };
}
