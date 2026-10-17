/**
 * An in-memory model of the repositories' newest-first `(created_at, id)` keyset pages, for
 * handler tests. It mints boundaries the way the PostgreSQL adapters do — the row's own
 * `created_at` as text — at the millisecond precision a `Date` holds.
 */
import type {
  KeysetPage,
  KeysetPosition,
  SessionRecord,
  SessionRepository,
} from '@agent-workspace/core/db';

interface KeysetRow {
  readonly id: string;
  readonly createdAt: Date;
}

function newestFirst(left: KeysetRow, right: KeysetRow): number {
  const byTime = right.createdAt.getTime() - left.createdAt.getTime();
  if (byTime !== 0) return byTime;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

function isAfter(row: KeysetRow, position: KeysetPosition): boolean {
  const at = row.createdAt.toISOString();
  return at < position.createdAt || (at === position.createdAt && row.id < position.id);
}

export function keysetPageOf<Row extends KeysetRow>(
  rows: readonly Row[],
  input: { readonly limit?: number | undefined; readonly cursor?: KeysetPosition | null },
): KeysetPage<Row> {
  const cursor = input.cursor ?? null;
  const ordered = [...rows]
    .sort(newestFirst)
    .filter((row) => cursor === null || isAfter(row, cursor));
  const limit = input.limit;
  const items = limit === undefined ? ordered : ordered.slice(0, limit);
  const last = items[items.length - 1];
  const hasMore = limit !== undefined && ordered.length > limit;
  return {
    items,
    nextCursor:
      hasMore && last !== undefined
        ? { createdAt: last.createdAt.toISOString(), id: last.id }
        : null,
  };
}

type SessionListInput = Parameters<SessionRepository['list']>[0];

/**
 * {@link keysetPageOf} for session rows, applying the filters the PostgreSQL adapter pushes into
 * its query: status, and the caller's visibility.
 */
export function sessionPageOf(
  rows: readonly SessionRecord[],
  input: SessionListInput,
): KeysetPage<SessionRecord> {
  const visibility = input.visibility;
  const visible = rows.filter(
    (row) =>
      (input.status === undefined || row.status === input.status) &&
      (visibility.kind === 'all' ||
        (visibility.kind === 'owner' && row.ownerPrincipalId === visibility.principalId) ||
        (visibility.kind === 'engine-session' &&
          row.engineSessionId === visibility.engineSessionId)),
  );
  return keysetPageOf(visible, input);
}
