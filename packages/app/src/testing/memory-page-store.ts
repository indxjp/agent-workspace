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
  nextPosition,
  pageQueryOf,
  preparePageCreate,
  preparePageUpdate,
  prepareMove,
  revisionsKeyOf,
} from '../db/page-policy.js';
import type {
  PageDeleteOptions,
  PageRestoreOptions,
  PageRevision,
  PageStore,
} from '../db/page-port.js';
import {
  assertAgentMayWrite,
  assertAllowed,
  filtersOf,
  listKeyOf,
  pageOf,
  pageRequestOf,
  readScopeOf,
  recordIdOf,
} from '../db/policy.js';
import type { AuditEvent, ListOptions, SearchOptions } from '../db/port.js';
import { termsMatch } from '../db/search-terms.js';
import { MemoryPageState, type Row } from './memory-page-state.js';
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

type State<F extends FieldMap> = MemoryPageState<F>;

const later = <T>(run: () => T | Promise<T>): Promise<T> => Promise.resolve().then(run);

function listPages<F extends FieldMap>(state: State<F>, person: Person, options: ListOptions) {
  state.calls.list += 1;
  return later(() => {
    const key = listKeyOf(state.appName, state.resource);
    const request = pageRequestOf(options, key, person.workspaceId);
    const filters = filtersOf(state.resource, options.where);
    return state.page(person, request, key, (row) =>
      filters.every(([field, value]) => row[field] === value),
    );
  });
}

function searchPages<F extends FieldMap>(
  state: State<F>,
  person: Person,
  query: string,
  options: SearchOptions,
) {
  state.calls.search += 1;
  return later(() => {
    const { text } = pageQueryOf(state.resource, query);
    const key = listKeyOf(state.appName, state.resource, true);
    const request = pageRequestOf(options, key, person.workspaceId);
    return state.page(person, request, key, (row) =>
      termsMatch((state.searchTexts.get(row.id) ?? '').split(' '), text),
    );
  });
}

function createPage<F extends FieldMap>(state: State<F>, person: Person, input: unknown) {
  state.calls.create += 1;
  return later(async () => {
    const { resource } = state;
    const prepared = await preparePageCreate(resource, person, input, (parent) =>
      Promise.resolve(
        nextPosition(
          state.childrenOf(person.workspaceId, parent).map((row) => Number(row['position'])),
        ),
      ),
    );
    const parent = state.parentRow(person, prepared.values['parent']);
    assertPlacement(resource, prepared.values, parent, []);
    const at = state.timestamp();
    const draft: KeyedRow = {
      ...copyOf(prepared.values),
      id: crypto.randomUUID(),
      workspace_id: person.workspaceId,
      created_by: person.principalId,
      updated_by: person.principalId,
      created_at: at,
      updated_at: at,
    };
    const row: Row = { ...draft, revision_id: state.writeRevision(person, draft, at) };
    state.rowsOf(person.workspaceId).set(row.id, row);
    state.writeAudit(person, { recordId: row.id, action: 'create', fields: prepared.fields, at });
    return state.committed('created', row, person);
  });
}

function updatePage<F extends FieldMap>(
  state: State<F>,
  person: Person,
  id: string,
  patch: unknown,
) {
  state.calls.update += 1;
  return later(() => {
    const { resource } = state;
    const prepared = preparePageUpdate(resource, person, patch);
    const existing = state.visibleRow(person, id);
    assertAllowed('update', resource, person, existing);
    assertPlacementKept(existing, prepared.values);
    assertExpectedRevision(existing.revision_id, prepared.expectedRevisionId);
    return state.save(person, existing, {
      values: prepared.values,
      fields: prepared.fields,
      revise: false,
    });
  });
}

function restorePage<F extends FieldMap>(
  state: State<F>,
  person: Person,
  id: string,
  revisionId: string,
  options: PageRestoreOptions,
) {
  return later(() => {
    const { resource } = state;
    assertMayRestore(resource, person);
    const existing = state.visibleRow(person, id);
    assertAllowed('update', resource, person, existing);
    assertExpectedRevision(existing.revision_id, options.expectedRevisionId);
    const key = recordIdOf(revisionId);
    const revision = state.revisionRowsOf(person, existing.id).find((row) => row.id === key);
    if (revision === undefined) throw new AppStoreError('revision_not_found');
    const values = { title: revision.revision.title, blocks: copyOf(revision.revision.blocks) };
    return state.save(person, existing, { values, fields: ['title', 'blocks'], revise: true });
  });
}

function movePage<F extends FieldMap>(state: State<F>, person: Person, id: string, move: unknown) {
  return later(() => {
    const { resource } = state;
    const target = prepareMove(resource, person, move);
    const existing = state.visibleRow(person, id);
    assertAllowed('update', resource, person, existing);
    const parent = state.parentRow(person, target.parent);
    assertPlacement(resource, existing, parent, state.chainOf(person.workspaceId, parent));
    const at = state.timestamp();
    const row: Row = {
      ...existing,
      parent: target.parent,
      position: target.position,
      updated_by: person.principalId,
      updated_at: at,
    };
    state.rowsOf(person.workspaceId).set(row.id, row);
    state.writeAudit(person, {
      recordId: row.id,
      action: 'update',
      fields: ['parent', 'position'],
      at,
    });
    return state.committed('updated', row, person);
  });
}

function deletePage<F extends FieldMap>(
  state: State<F>,
  person: Person,
  id: string,
  options: PageDeleteOptions,
) {
  state.calls.delete += 1;
  return later(async () => {
    const { resource } = state;
    assertAgentMayWrite(resource, person, []);
    const existing = state.visibleRow(person, id);
    const hasChildren = state.childrenOf(person.workspaceId, existing.id).length > 0;
    assertDeletable(resource, person, existing, hasChildren, options.cascade === true);
    const at = state.timestamp();
    const deleted = state.subtreeOf(person.workspaceId, existing);
    for (const row of deleted) {
      state.rowsOf(person.workspaceId).delete(row.id);
      state.searchTexts.delete(row.id);
      state.writeAudit(person, { recordId: row.id, action: 'delete', fields: [], at });
    }
    for (const row of deleted) await state.committed('deleted', row, person);
  });
}

function childPages<F extends FieldMap>(state: State<F>, person: Person, parentId: string | null) {
  return later(() => {
    readScopeOf(state.resource, person);
    const parent = parentId === null ? null : state.visibleRow(person, parentId).id;
    return state
      .childrenOf(person.workspaceId, parent)
      .slice(0, CHILDREN_MAX)
      .map((row) => state.record(row));
  });
}

function pageRevisions<F extends FieldMap>(
  state: State<F>,
  person: Person,
  id: string,
  options: SearchOptions,
) {
  return later(() => {
    const existing = state.visibleRow(person, id);
    const key = revisionsKeyOf(state.appName, state.resource, existing.id);
    const request = pageRequestOf(options, key, person.workspaceId);
    const rows = state
      .revisionRowsOf(person, existing.id)
      .filter((row) => isAfter(row, request))
      .sort(newestFirst)
      .slice(0, request.limit + 1);
    const result = pageOf(rows, request, key, person.workspaceId);
    return {
      items: result.items.map((row) => copyOf(row.revision)),
      nextCursor: result.nextCursor,
    };
  });
}

/**
 * The in-memory page store of `resource`: a `Map` of pages per workspace and a list of revisions,
 * behaving as `pageStoreOf` does. Each call returns copies.
 */
export function memoryPageStoreOf<F extends FieldMap>(
  pages: DefinedPages<F>,
  options: MemoryStoreOptions = {},
): MemoryPageStore<F> {
  const state = new MemoryPageState<F>(pages, options);
  return {
    calls: state.calls,
    auditEvents: () => copyOf(state.audit),
    storedRevisions: (pageId) =>
      state.revisionRows
        .filter((row) => row.revision.page_id === pageId)
        .map((row) => copyOf(row.revision)),
    list: (person, listOptions = {}) => listPages(state, person, listOptions),
    get: (person, id) => {
      state.calls.get += 1;
      return later(() => state.record(state.visibleRow(person, id)));
    },
    search: (person, query, searchOptions = {}) => searchPages(state, person, query, searchOptions),
    create: (person, input) => createPage(state, person, input),
    update: (person, id, patch) => updatePage(state, person, id, patch),
    restore: (person, id, revisionId, restoreOptions = {}) =>
      restorePage(state, person, id, revisionId, restoreOptions),
    move: (person, id, move) => movePage(state, person, id, move),
    delete: (person, id, deleteOptions = {}) => deletePage(state, person, id, deleteOptions),
    children: (person, parentId) => childPages(state, person, parentId),
    revisions: (person, id, revisionOptions = {}) =>
      pageRevisions(state, person, id, revisionOptions),
  };
}
