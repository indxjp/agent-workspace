/**
 * `memoryStoreOf`: the in-memory twin of `storeOf` (issue #1502), for an app's own tests. It
 * implements the same `ResourceStore` port with the same validation, access checks, paging and
 * errors (it shares them, `db/policy.ts`); one conformance suite holds both stores to it.
 *
 * shortcut: search matches whole lower-cased words (every word, `-word` excluded), an
 * approximation of PostgreSQL's `websearch_to_tsquery('simple', …)` without phrases or `or`;
 * upgrade when an app's tests need either, or test search against `storeOf`.
 */
import type { AppSqlRunner } from '../db/store.js';
import type { Person } from '../person.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import { AppStoreError } from '../db/errors.js';
import {
  assertAllowed,
  filtersOf,
  isVisible,
  listKeyOf,
  notifyCommitted,
  pageOf,
  pageRequestOf,
  prepareCreate,
  prepareUpdate,
  readScopeOf,
  recordIdOf,
  searchTextOf,
  assertAgentMayWrite,
  type PageRequest,
} from '../db/policy.js';
import type {
  AuditAction,
  AuditEvent,
  CommittedEvent,
  ListOptions,
  Page,
  ResourceStore,
  SearchOptions,
  StoreClock,
  StoreHooks,
} from '../db/port.js';

/**
 * The `tx` the in-memory store hands `afterWrite`: it has no SQL transaction, so a statement is
 * refused. The in-memory twins a hook calls (`memoryChannelHub`) never run one.
 */
const NO_TRANSACTION: AppSqlRunner = {
  execute: () =>
    Promise.reject(
      new TypeError('the in-memory store has no SQL transaction to run a statement in'),
    ),
};

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

/** A kept row: its values, its id and the time it was made, which order every list. */
export type KeyedRow = Record<string, unknown> & {
  readonly id: string;
  readonly created_at: string;
};

type Row = KeyedRow;

/** What a list orders by: an id and the time it was made. */
interface Keyed {
  readonly id: string;
  readonly created_at: string;
}

const WORD = /[\p{L}\p{N}]+/gu;

function wordsOf(value: unknown): string[] {
  if (typeof value === 'string') return value.toLowerCase().match(WORD) ?? [];
  if (Array.isArray(value)) return value.flatMap(wordsOf);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(wordsOf);
  return [];
}

function matchesSearch(resource: DefinedResource, row: Row, text: string): boolean {
  const words = new Set(resource.search.flatMap((field) => wordsOf(row[field])));
  const terms = text.split(/\s+/u).filter((term) => term !== '');
  const wanted = terms.filter((term) => !term.startsWith('-')).flatMap(wordsOf);
  const unwanted = terms.filter((term) => term.startsWith('-')).flatMap(wordsOf);
  return (
    wanted.length > 0 &&
    wanted.every((word) => words.has(word)) &&
    !unwanted.some((word) => words.has(word))
  );
}

/** Newest first; equal times by id, descending, as PostgreSQL orders `uuid`. */
export function newestFirst(a: Keyed, b: Keyed): number {
  const byTime = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Whether `row` comes after the cursor of `request`, newest first. */
export function isAfter(row: Keyed, request: PageRequest): boolean {
  const after = request.after;
  if (after === null) return true;
  const byTime = Date.parse(row.created_at) - Date.parse(after.createdAt);
  return byTime < 0 || (byTime === 0 && row.id < after.id);
}

/** A deep copy, so a caller cannot change what a store keeps. */
export function copyOf<T>(value: T): T {
  return structuredClone(value);
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
  const workspaces = new Map<string, Map<string, Row>>();
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

  const visibleRow = (person: Person, id: string): Row => {
    const scope = readScopeOf(resource, person);
    const key = recordIdOf(id);
    const row = key === undefined ? undefined : workspaces.get(person.workspaceId)?.get(key);
    if (row === undefined || !isVisible(scope, person, row)) {
      throw new AppStoreError('resource_not_found');
    }
    return row;
  };

  const record = (row: Row): RecordOf<F> => copyOf(row) as unknown as RecordOf<F>;

  /**
   * The `afterWrite` hook, before the write is kept: a throw leaves the store as it was, as a
   * rolled-back transaction does.
   */
  const beforeKeeping = async (event: CommittedEvent, row: Row, person: Person): Promise<void> => {
    if (options.afterWrite === undefined) return;
    await options.afterWrite(NO_TRANSACTION, {
      resource: resource.name,
      type: event,
      row: copyOf(row),
      person,
    });
  };

  const committed = async (
    event: CommittedEvent,
    row: Row,
    person: Person,
  ): Promise<RecordOf<F>> => {
    await notifyCommitted(options.onCommitted, resource.name, event, row, person);
    return record(row);
  };

  const page = (
    person: Person,
    request: PageRequest,
    key: string,
    keep: (row: Row) => boolean,
  ): Page<RecordOf<F>> => {
    const scope = readScopeOf(resource, person);
    const rows = [...(workspaces.get(person.workspaceId)?.values() ?? [])]
      .filter((row) => isVisible(scope, person, row) && keep(row) && isAfter(row, request))
      .sort(newestFirst)
      .slice(0, request.limit + 1);
    const result = pageOf(rows, request, key, person.workspaceId);
    return { items: result.items.map(record), nextCursor: result.nextCursor };
  };

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

  return {
    calls,
    auditEvents: () => copyOf(audit),

    list(person: Person, listOptions: ListOptions = {}) {
      calls.list += 1;
      return Promise.resolve().then(() => {
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
      return Promise.resolve().then(() => record(visibleRow(person, id)));
    },

    search(person: Person, query: string, searchOptions: SearchOptions = {}) {
      calls.search += 1;
      return Promise.resolve().then(() => {
        const text = searchTextOf(resource, query);
        const key = listKeyOf(appName, resource, true);
        const request = pageRequestOf(searchOptions, key, person.workspaceId);
        return page(person, request, key, (row) => matchesSearch(resource, row, text));
      });
    },

    create(person: Person, input: unknown) {
      calls.create += 1;
      return Promise.resolve().then(async () => {
        const prepared = prepareCreate(resource, person, input);
        const at = now().toISOString();
        const row: Row = {
          ...copyOf(prepared.values),
          id: crypto.randomUUID(),
          workspace_id: person.workspaceId,
          created_by: person.principalId,
          updated_by: person.principalId,
          created_at: at,
          updated_at: at,
        };
        await beforeKeeping('created', row, person);
        rowsOf(person.workspaceId).set(row.id, row);
        writeAudit(person, row.id, 'create', prepared.fields, at);
        return committed('created', row, person);
      });
    },

    update(person: Person, id: string, patch: unknown) {
      calls.update += 1;
      return Promise.resolve().then(async () => {
        const prepared = prepareUpdate(resource, person, patch);
        const existing = visibleRow(person, id);
        assertAllowed('update', resource, person, existing);
        const at = now().toISOString();
        const row: Row = {
          ...existing,
          ...copyOf(prepared.values),
          updated_by: person.principalId,
          updated_at: at,
        };
        await beforeKeeping('updated', row, person);
        rowsOf(person.workspaceId).set(row.id, row);
        writeAudit(person, row.id, 'update', prepared.fields, at);
        return committed('updated', row, person);
      });
    },

    delete(person: Person, id: string) {
      calls.delete += 1;
      return Promise.resolve().then(async () => {
        assertAgentMayWrite(resource, person, []);
        const existing = visibleRow(person, id);
        assertAllowed('delete', resource, person, existing);
        await beforeKeeping('deleted', existing, person);
        rowsOf(person.workspaceId).delete(existing.id);
        writeAudit(person, existing.id, 'delete', [], now().toISOString());
        await committed('deleted', existing, person);
      });
    },
  };
}
