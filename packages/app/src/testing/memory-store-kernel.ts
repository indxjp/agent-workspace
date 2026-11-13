/**
 * The state and helpers one in-memory store is built on: the records per workspace, the audit
 * rows, and the steps every operation shares (visibility, guarding, hooks, paging, audit).
 */
import type { AppSqlRunner } from '../db/store.js';
import type { Person } from '../person.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import { AppStoreError } from '../db/errors.js';
import {
  isVisible,
  notifyCommitted,
  pageOf,
  readScopeOf,
  recordIdOf,
  type PageRequest,
} from '../db/policy.js';
import type {
  AfterWrite,
  AuditAction,
  AuditEvent,
  CommittedEvent,
  Page,
  StoreHooks,
} from '../db/port.js';
import { copyOf, isAfter, newestFirst, type KeyedRow } from './memory-rows.js';

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

/** What an audit row records about one write besides who made it. */
interface AuditEntry {
  readonly recordId: string;
  readonly action: AuditAction;
  /** The names of the fields written, never their values. */
  readonly fields: readonly string[];
  readonly at: string;
}

/** The audit row of `entry`, written by `person` to `resourceName`. */
function auditEventOf(resourceName: string, person: Person, entry: AuditEntry): AuditEvent {
  return {
    id: crypto.randomUUID(),
    workspace_id: person.workspaceId,
    actor: person.principalId,
    via: person.via,
    run_id: person.runId ?? null,
    resource: resourceName,
    record_id: entry.recordId,
    action: entry.action,
    fields: [...entry.fields],
    at: entry.at,
  };
}

/** The steps the operations of one in-memory store share. */
export interface MemoryKernel<F extends FieldMap> {
  readonly audit: AuditEvent[];
  rowsOf(workspaceId: string): Map<string, KeyedRow>;
  visibleRow(person: Person, id: string): KeyedRow;
  /** As `storeOf` does: a refusal passes through, any other failure becomes `internal_error`. */
  guarded<T>(run: () => Promise<T>): Promise<T>;
  record(row: KeyedRow): RecordOf<F>;
  /** The `afterWrite` hook, before the write is kept: a throw leaves the store as it was. */
  beforeKeeping(event: CommittedEvent, row: KeyedRow, person: Person): Promise<void>;
  committed(event: CommittedEvent, row: KeyedRow, person: Person): Promise<RecordOf<F>>;
  page(
    person: Person,
    request: PageRequest,
    key: string,
    keep: (row: KeyedRow) => boolean,
  ): Page<RecordOf<F>>;
  writeAudit(person: Person, entry: AuditEntry): void;
}

/** Who is reading, and what the resource lets them read. */
interface Viewer {
  readonly person: Person;
  readonly scope: ReturnType<typeof readScopeOf>;
}

/** The rows `viewer` may see and `keep` admits, newest first, after the cursor, one over the limit. */
function visibleWindow(
  rows: Iterable<KeyedRow>,
  viewer: Viewer,
  request: PageRequest,
  keep: (row: KeyedRow) => boolean,
): KeyedRow[] {
  return [...rows]
    .filter(
      (row) => isVisible(viewer.scope, viewer.person, row) && keep(row) && isAfter(row, request),
    )
    .sort(newestFirst)
    .slice(0, request.limit + 1);
}

/** As `storeOf` does: a refusal passes through, any other failure becomes `internal_error`. */
async function guardedRun<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppStoreError) throw error;
    throw new AppStoreError('internal_error', { cause: error });
  }
}

/** The `afterWrite` hook, if there is one, called with a copy of the row about to be kept. */
async function runAfterWrite(
  afterWrite: AfterWrite | undefined,
  change: Parameters<AfterWrite>[1],
): Promise<void> {
  if (afterWrite === undefined) return;
  await afterWrite(NO_TRANSACTION, { ...change, row: copyOf(change.row) });
}

/** The rows of one workspace, made on first use. */
function workspaceRows(
  workspaces: Map<string, Map<string, KeyedRow>>,
  workspaceId: string,
): Map<string, KeyedRow> {
  let rows = workspaces.get(workspaceId);
  if (rows === undefined) {
    rows = new Map();
    workspaces.set(workspaceId, rows);
  }
  return rows;
}

/** A kernel over empty state for `resource`, calling `hooks` as the store commits. */
export function memoryKernelOf<F extends FieldMap>(
  resource: DefinedResource<F>,
  hooks: StoreHooks,
): MemoryKernel<F> {
  const workspaces = new Map<string, Map<string, KeyedRow>>();
  const audit: AuditEvent[] = [];
  const record = (row: KeyedRow): RecordOf<F> => copyOf(row) as unknown as RecordOf<F>;

  return {
    audit,
    rowsOf: (workspaceId) => workspaceRows(workspaces, workspaceId),
    guarded: guardedRun,
    record,

    visibleRow(person, id) {
      const scope = readScopeOf(resource, person);
      const key = recordIdOf(id);
      const row = key === undefined ? undefined : workspaces.get(person.workspaceId)?.get(key);
      if (row === undefined || !isVisible(scope, person, row)) {
        throw new AppStoreError('resource_not_found');
      }
      return row;
    },

    beforeKeeping: (event, row, person) =>
      runAfterWrite(hooks.afterWrite, { resource: resource.name, type: event, row, person }),

    async committed(event, row, person) {
      await notifyCommitted(hooks.onCommitted, resource.name, event, row, person);
      return record(row);
    },

    page(person, request, key, keep) {
      const viewer = { person, scope: readScopeOf(resource, person) };
      const rows = workspaces.get(person.workspaceId)?.values() ?? [];
      const result = pageOf(
        visibleWindow(rows, viewer, request, keep),
        request,
        key,
        person.workspaceId,
      );
      return { items: result.items.map(record), nextCursor: result.nextCursor };
    },

    writeAudit(person, entry) {
      if (resource.audit) audit.push(auditEventOf(resource.name, person, entry));
    },
  };
}
