/**
 * Newest-first keyset pagination over an immutable `(created_at, id)` pair — the shape the session
 * and audit lists page by (S-5, ADR-0079). `runs.ts`'s `listRuns` is the older instance of the
 * same idea and keeps its own copy for now.
 *
 * `created_at` never changes after insert, so a row's position in the order is fixed: every row
 * committed before the walk began is seen exactly once, and the walk terminates. A row committed
 * during the walk is not promised: `created_at` is `now()`, the inserting transaction's start
 * time, so a long transaction can land behind a boundary already handed out and that walk misses
 * it (it never duplicates or displaces another row).
 */
import { and, eq, lt, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * The boundary row of a page: its `created_at` as the exact text PostgreSQL prints for it (UTC,
 * six fractional digits — never a `Date`, which would truncate microseconds and let a boundary
 * fall between two rows it should separate) and its id, which breaks a tie on the timestamp.
 */
export interface KeysetPosition {
  readonly createdAt: string;
  readonly id: string;
}

/** One page, newest first, with the boundary the next page starts after (`null` on the last). */
export interface KeysetPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: KeysetPosition | null;
}

/** `created_at` at the database's own precision, as order-preserving, reversible text. */
export function keysetTimestamp(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Rows strictly after `position` in `created_at DESC, id DESC` order. */
export function afterPosition(createdAt: AnyColumn, id: AnyColumn, position: KeysetPosition): SQL {
  const boundary = sql`${position.createdAt}::timestamptz`;
  const predicate = or(lt(createdAt, boundary), and(eq(createdAt, boundary), lt(id, position.id)));
  if (predicate === undefined) throw new Error('the keyset predicate could not be built');
  return predicate;
}

/**
 * Split the `limit + 1` rows a query fetched into a page and the next boundary. The extra row is
 * never returned; it only proves a next page exists without a second round trip. `limit`
 * `undefined` means the query was unbounded, so there is no next page.
 */
export function toKeysetPage<
  Row extends { readonly cursorAt: string },
  Item extends { readonly id: string },
>(rows: readonly Row[], limit: number | undefined, toItem: (row: Row) => Item): KeysetPage<Item> {
  const hasMore = limit !== undefined && rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(toItem);
  const lastRow = page[page.length - 1];
  const lastItem = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && lastRow !== undefined && lastItem !== undefined
        ? { createdAt: lastRow.cursorAt, id: lastItem.id }
        : null,
  };
}

/** A page size given to a repository: a safe integer from 1 to `max`, or a programming error. */
export function assertPageLimit(limit: number, max: number, operation: string): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new Error(`${operation} limit must be an integer from 1 to ${String(max)}`);
  }
}
