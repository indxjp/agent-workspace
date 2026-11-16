/**
 * The `ResourceStore` port (issue #1502): the one way a page, a route or an agent tool reads and
 * writes a resource's records. `storeOf` implements it over PostgreSQL and `memoryStoreOf`
 * (`@indx-workspace/app/testing`) in memory; one conformance suite holds both to it. Types only.
 */
import type { Person } from '../person.js';
import type { AppSqlRunner } from './store.js';
import type { FieldMap } from '../resource.js';
import type { RecordOf } from '../schemas.js';

/** What a list may ask for: where to start, how many, and an `enumOf()` field's value to match. */
export interface ListOptions {
  /** The `nextCursor` of the page before; absent for the first page. */
  readonly cursor?: string;
  /** 1–200; 50 when not given. */
  readonly limit?: number;
  /** `enumOf()` field values every record of the list has, `{ status: 'open' }`. */
  readonly where?: Readonly<Record<string, string>>;
}

/** What a search may ask for besides its text. */
export interface SearchOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

/** One page of records, newest first; `nextCursor` is `null` on the last page. */
export interface Page<R> {
  readonly items: readonly R[];
  readonly nextCursor: string | null;
}

/** The three writes an audit row records. */
export type AuditAction = 'create' | 'update' | 'delete';

/** One row of `app_audit_events`: who wrote, how, and which fields; never the values. */
export interface AuditEvent {
  readonly id: string;
  readonly workspace_id: string;
  readonly actor: string;
  readonly via: Person['via'];
  /** The run an agent wrote in; `null` for a write in person. */
  readonly run_id: string | null;
  /** The resource's `name`. */
  readonly resource: string;
  readonly record_id: string;
  readonly action: AuditAction;
  readonly fields: readonly string[];
  readonly at: string;
}

/**
 * The records of one resource, every operation scoped to `person.workspaceId` and checked against
 * the resource's `access` for `person`. An agent acting for a person (`via: 'agent'`) does no more
 * than the person may, and writes only the fields `agents.write` lists.
 *
 * Every refusal and failure is an `AppStoreError`: a record the person may not read, or one in
 * another workspace, is `resource_not_found`; a write the person may not make to a record they can
 * read is `forbidden`. Inputs are validated here, so a body may be passed as parsed JSON.
 */
export interface ResourceStore<F extends FieldMap = FieldMap> {
  list(person: Person, options?: ListOptions): Promise<Page<RecordOf<F>>>;
  get(person: Person, id: string): Promise<RecordOf<F>>;
  /** Full-text search over the resource's `search` fields; `search_unsupported` without them. */
  search(person: Person, query: string, options?: SearchOptions): Promise<Page<RecordOf<F>>>;
  create(person: Person, input: unknown): Promise<RecordOf<F>>;
  update(person: Person, id: string, patch: unknown): Promise<RecordOf<F>>;
  delete(person: Person, id: string): Promise<void>;
}

/** What both stores take besides the resource: a clock, for tests that need equal timestamps. */
export interface StoreClock {
  /** The time a write is stamped with; the database's (or the host's) clock when not given. */
  readonly now?: () => Date;
}

/** The write a store committed: `created`, `updated` or `deleted`, as a recipe's trigger names it. */
export type CommittedEvent = 'created' | 'updated' | 'deleted';

/**
 * Called after a store committed a write, never for a refused or rolled-back one (issue #1513):
 * the recipe runner's `onResourceEvent` plugs in here. `row` is the record as the store returned
 * it; for `deleted`, as it was before the delete. A hook that throws does not fail the committed
 * write: it reports its own errors.
 */
export type OnCommitted = (
  resource: string,
  event: CommittedEvent,
  row: Readonly<Record<string, unknown>>,
  person: Person,
) => void | Promise<void>;

/** One write a store is making, as {@link AfterWrite} is told it. */
export interface WriteChange {
  /** The resource's `name`. */
  readonly resource: string;
  /** The write: `created`, `updated` or `deleted`. */
  readonly type: CommittedEvent;
  /** The record as the store will return it; for `deleted`, as it was before the delete. */
  readonly row: Readonly<Record<string, unknown>>;
  /** Who writes, in person or through an agent. */
  readonly person: Person;
}

/**
 * Called inside a write's transaction, after the row and its audit row are written and before the
 * commit (issue #1519): a channel binding publishes the write here, so a write that rolls back is
 * never delivered. Unlike {@link OnCommitted}, a hook that throws fails the write, which rolls
 * back and is refused as `internal_error` (or the hook's own `AppStoreError`). Only refused
 * writes are never seen: validation and access are checked first.
 *
 * `tx` is the write's transaction; the in-memory store has none and passes a runner that refuses
 * every statement, which its twins (`memoryChannelHub`) never run.
 */
export type AfterWrite = (tx: AppSqlRunner, change: WriteChange) => Promise<void>;

/** What both stores take to tell the app about a write: in its transaction, and once committed. */
export interface StoreHooks {
  /** Called in the write's transaction; a throw rolls the write back. */
  readonly afterWrite?: AfterWrite;
  /** Called once the write is committed; a throw does not undo it. */
  readonly onCommitted?: OnCommitted;
}
