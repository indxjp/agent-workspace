/**
 * `memoryStoreOf`: the in-memory twin of `storeOf` (issue #1502), for an app's own tests. It
 * implements the same `ResourceStore` port with the same validation, access checks, paging and
 * errors (it shares them, `db/policy.ts`); one conformance suite holds both stores to it.
 *
 * shortcut: search matches whole lower-cased words (every word, `-word` excluded), an
 * approximation of PostgreSQL's `websearch_to_tsquery('simple', …)` without phrases or `or`;
 * upgrade when an app's tests need either, or test search against `storeOf`.
 */
import type { Person } from '../person.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import {
  assertAgentMayWrite,
  assertAllowed,
  filtersOf,
  listKeyOf,
  pageRequestOf,
  prepareCreate,
  prepareUpdate,
  searchTextOf,
} from '../db/policy.js';
import type {
  AuditEvent,
  ListOptions,
  ResourceStore,
  SearchOptions,
  StoreClock,
  StoreHooks,
} from '../db/port.js';
import { memoryKernelOf, type MemoryKernel } from './memory-store-kernel.js';
import { copyOf, matchesSearch, type KeyedRow } from './memory-rows.js';

export { copyOf, isAfter, newestFirst, type KeyedRow } from './memory-rows.js';

/** The store operations, as the call counter names them. */
export type StoreOperation = keyof ResourceStore;

/** The in-memory store: the port, plus what a test inspects. */
export interface MemoryResourceStore<F extends FieldMap = FieldMap> extends ResourceStore<F> {
  /** How many times each operation was called, refused calls included. */
  readonly calls: Readonly<Record<StoreOperation, number>>;
  /** The audit rows written so far, oldest first. */
  auditEvents(): readonly AuditEvent[];
}

/** What {@link memoryStoreOf} takes besides the resource. */
export interface MemoryStoreOptions extends StoreClock, StoreHooks {
  /** The app's name, as the cursors name the list; `app` when not given. */
  readonly appName?: string;
}

/** The `create` operation: validate, run the hook, keep, audit, notify. */
function createOperation<F extends FieldMap>(
  resource: DefinedResource<F>,
  kernel: MemoryKernel<F>,
  now: () => Date,
) {
  return (person: Person, input: unknown) =>
    kernel.guarded(async () => {
      const prepared = prepareCreate(resource, person, input);
      const at = now().toISOString();
      const row: KeyedRow = {
        ...copyOf(prepared.values),
        id: crypto.randomUUID(),
        workspace_id: person.workspaceId,
        created_by: person.principalId,
        updated_by: person.principalId,
        created_at: at,
        updated_at: at,
      };
      await kernel.beforeKeeping('created', row, person);
      kernel.rowsOf(person.workspaceId).set(row.id, row);
      kernel.writeAudit(person, {
        recordId: row.id,
        action: 'create',
        fields: prepared.fields,
        at,
      });
      return kernel.committed('created', row, person);
    });
}

/** The `update` operation: validate, check access, run the hook, keep, audit, notify. */
function updateOperation<F extends FieldMap>(
  resource: DefinedResource<F>,
  kernel: MemoryKernel<F>,
  now: () => Date,
) {
  return (person: Person, id: string, patch: unknown) =>
    kernel.guarded(async () => {
      const prepared = prepareUpdate(resource, person, patch);
      const existing = kernel.visibleRow(person, id);
      assertAllowed('update', resource, person, existing);
      const at = now().toISOString();
      const row: KeyedRow = {
        ...existing,
        ...copyOf(prepared.values),
        updated_by: person.principalId,
        updated_at: at,
      };
      await kernel.beforeKeeping('updated', row, person);
      kernel.rowsOf(person.workspaceId).set(row.id, row);
      kernel.writeAudit(person, {
        recordId: row.id,
        action: 'update',
        fields: prepared.fields,
        at,
      });
      return kernel.committed('updated', row, person);
    });
}

/** The `delete` operation: check access, run the hook, drop, audit, notify. */
function deleteOperation<F extends FieldMap>(
  resource: DefinedResource<F>,
  kernel: MemoryKernel<F>,
  now: () => Date,
) {
  return (person: Person, id: string) =>
    kernel.guarded(async () => {
      assertAgentMayWrite(resource, person, []);
      const existing = kernel.visibleRow(person, id);
      assertAllowed('delete', resource, person, existing);
      await kernel.beforeKeeping('deleted', existing, person);
      kernel.rowsOf(person.workspaceId).delete(existing.id);
      kernel.writeAudit(person, {
        recordId: existing.id,
        action: 'delete',
        fields: [],
        at: now().toISOString(),
      });
      await kernel.committed('deleted', existing, person);
    });
}

/** The `list` operation: the visible rows that match the `where` filters, a page at a time. */
function listOperation<F extends FieldMap>(
  resource: DefinedResource<F>,
  kernel: MemoryKernel<F>,
  appName: string,
) {
  return (person: Person, listOptions: ListOptions = {}) =>
    kernel.guarded(() => {
      const key = listKeyOf(appName, resource);
      const request = pageRequestOf(listOptions, key, person.workspaceId);
      const filters = filtersOf(resource, listOptions.where);
      return Promise.resolve(
        kernel.page(person, request, key, (row) =>
          filters.every(([field, value]) => row[field] === value),
        ),
      );
    });
}

/** The `search` operation: the visible rows whose searched fields match the query's words. */
function searchOperation<F extends FieldMap>(
  resource: DefinedResource<F>,
  kernel: MemoryKernel<F>,
  appName: string,
) {
  return (person: Person, query: string, searchOptions: SearchOptions = {}) =>
    kernel.guarded(() => {
      const text = searchTextOf(resource, query);
      const key = listKeyOf(appName, resource, true);
      const request = pageRequestOf(searchOptions, key, person.workspaceId);
      return Promise.resolve(
        kernel.page(person, request, key, (row) => matchesSearch(resource, row, text)),
      );
    });
}

/** The `get` operation: one visible record, or `resource_not_found`. */
function getOperation<F extends FieldMap>(kernel: MemoryKernel<F>) {
  return (person: Person, id: string) =>
    kernel.guarded(() => Promise.resolve(kernel.record(kernel.visibleRow(person, id))));
}

/**
 * The in-memory store of `resource`: a `Map` of records per workspace, behaving as `storeOf` does.
 * Each call returns copies, so a test cannot change a stored record by accident.
 */
export function memoryStoreOf<F extends FieldMap>(
  resource: DefinedResource<F>,
  options: MemoryStoreOptions = {},
): MemoryResourceStore<F> {
  const appName = options.appName ?? 'app';
  const now = options.now ?? (() => new Date());
  const kernel = memoryKernelOf(resource, options);
  const calls: Record<StoreOperation, number> = {
    list: 0,
    get: 0,
    search: 0,
    create: 0,
    update: 0,
    delete: 0,
  };
  const list = listOperation(resource, kernel, appName);
  const get = getOperation(kernel);
  const search = searchOperation(resource, kernel, appName);
  const create = createOperation(resource, kernel, now);
  const update = updateOperation(resource, kernel, now);
  const remove = deleteOperation(resource, kernel, now);

  return {
    calls,
    auditEvents: () => copyOf(kernel.audit),
    list(person: Person, listOptions?: ListOptions) {
      calls.list += 1;
      return list(person, listOptions);
    },
    get(person: Person, id: string) {
      calls.get += 1;
      return get(person, id);
    },
    search(person: Person, query: string, searchOptions?: SearchOptions) {
      calls.search += 1;
      return search(person, query, searchOptions);
    },
    create(person: Person, input: unknown) {
      calls.create += 1;
      return create(person, input);
    },
    update(person: Person, id: string, patch: unknown) {
      calls.update += 1;
      return update(person, id, patch);
    },
    delete(person: Person, id: string) {
      calls.delete += 1;
      return remove(person, id);
    },
  };
}
