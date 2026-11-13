import { and, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';

import { files, type FileStatus } from '../schema/files.js';
import { isSidePath } from '../side-paths.js';
import {
  CatalogPathPendingError,
  CatalogPathTakenError,
  renamedKey,
  sameReservation,
  type CatalogFile,
  type ConfirmOutcome,
} from './resource-catalogs-model.js';
import type { CatalogPort } from './resource-catalogs-port.js';
import {
  atLogicalPath,
  fileColumns,
  insertParentFolders,
  lockForWrite,
  lockPath,
  logicalPath,
  markRemoved,
  moveHolderAside,
  pathUnderPrefix,
  reservedAs,
  sidePathOf,
  type CatalogContext,
  type Transaction,
} from './resource-catalogs-sql.js';

/** How often `confirm` follows a row that a rename moved while it waited for the path lock. */
const CONFIRM_TRIES = 3;

type ConfirmInput = Parameters<CatalogPort['confirm']>[1];

/** Move every live row at or under `oldPrefix` to `newPrefix`, keeping ids; returns the rows moved. */
export async function moveUnder(
  { db, workspaceId }: CatalogContext,
  oldPrefix: string,
  newPrefix: string,
): Promise<CatalogFile[]> {
  if (isSidePath(newPrefix)) throw new Error(`${newPrefix} is a reserved catalog path.`);
  return db.transaction(async (tx) => {
    await lockForWrite(tx, workspaceId, 'exclusive', []);
    // A `deleting` row is out of the tree: its object is removed from its own key.
    const moving = and(
      eq(files.workspaceId, workspaceId),
      ne(files.status, 'deleting'),
      pathUnderPrefix(oldPrefix, logicalPath),
    );
    await refuseTakenDestinations({ tx, workspaceId, moving, oldPrefix, newPrefix });
    const rows = await moveRows({ tx, workspaceId, moving, oldPrefix, newPrefix });
    // storage-bridge(#1657): a folder move refuses while an upload under it is pending, so its
    // confirm never meets a moved storage key. Checked on the rows the update itself moved, so a
    // reserve committed before its snapshot is caught and the throw rolls it back; one committed
    // after it is untouched and stays at the old path.
    if (rows.some((row) => row.status === 'pending')) {
      throw new CatalogPathPendingError(oldPrefix);
    }
    // The moved rows come back first so the parent rows never shadow `newPrefix` itself.
    await insertParentFolders(tx, workspaceId, rows.map(atLogicalPath));
    return rows;
  });
}

/** One subtree move inside its transaction: the rows it moves and where. */
interface SubtreeMove {
  readonly tx: Transaction;
  readonly workspaceId: string;
  readonly moving: SQL | undefined;
  readonly oldPrefix: string;
  readonly newPrefix: string;
}

/** Throw {@link CatalogPathTakenError} when a destination is held by a row outside the moved set. */
async function refuseTakenDestinations(move: SubtreeMove): Promise<void> {
  const { tx, workspaceId, oldPrefix, newPrefix } = move;
  const moved = await tx.select({ id: files.id, path: logicalPath }).from(files).where(move.moving);
  // Both cuts use the JS length of `oldPrefix`, which is a prefix of every path it cuts.
  const destinations = moved.map((row) => renamedKey(row.path, oldPrefix, newPrefix));
  if (destinations.length === 0) return;
  const movedIds = new Set(moved.map((row) => row.id));
  const held = await tx
    .select({ id: files.id, path: logicalPath })
    .from(files)
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        ne(files.status, 'deleting'),
        inArray(logicalPath, destinations),
      ),
    );
  const clash = held.find((row) => !movedIds.has(row.id));
  if (clash !== undefined) throw new CatalogPathTakenError(clash.path);
}

/**
 * The cut point — one past `oldPrefix` itself — is computed by Postgres as
 * `char_length(${oldPrefix}) + 1`, never as JS's `oldPrefix.length + 1`. `substr` counts
 * CHARACTERS; JS `.length` counts UTF-16 code units, which over-counts by one for every character
 * outside the BMP (most emoji) and so cuts at the wrong character boundary for a prefix containing
 * one — the same class of bug `pathUnderPrefix` documents. See W9-FILES-131's
 * verification-round-2 notes for the reproduction.
 */
function moveRows({ tx, moving, oldPrefix, newPrefix }: SubtreeMove) {
  return tx
    .update(files)
    .set({
      // `substr(text, int)`, not the two-argument `substring(text FROM ...)` form: that form has a
      // *second* overload — POSIX regexp extraction — and a bound parameter's type is not always
      // pinned to `integer` early enough to rule it out, so `substring(path from $2)` silently
      // became "search `path` for a regex matching `$2`" and returned `NULL` (no match) for every
      // row, which this method's own test caught as a `NOT NULL` violation on `path`. `substr` has
      // only the integer-offset overload, so there is no second meaning to fall into.
      // A pending replacement waits at its side path and moves its `target_path` instead.
      path: sql`case when ${files.targetPath} is null
        then ${newPrefix} || substr(${files.path}, char_length(${oldPrefix}) + 1)
        else ${files.path} end`,
      targetPath: sql`case when ${files.targetPath} is not null
        then ${newPrefix} || substr(${files.targetPath}, char_length(${oldPrefix}) + 1)
        end`,
    })
    .where(moving)
    .returning(fileColumns);
}

/** One confirm of `row`, as `confirmFile` retries it. */
interface ConfirmAttempt extends CatalogContext {
  readonly row: CatalogFile;
  readonly storageKey: string;
  readonly statuses: readonly FileStatus[];
  readonly input: ConfirmInput;
}

// @story US-STO-14
export async function confirmFile(
  context: CatalogContext,
  row: CatalogFile,
  input: ConfirmInput,
): Promise<ConfirmOutcome | null> {
  if (row.storageKey === null) return null;
  const attempt: ConfirmAttempt = {
    ...context,
    row,
    storageKey: row.storageKey,
    statuses: input.expect === 'any' ? ['pending', 'ready'] : ['pending'],
    input,
  };
  for (let tries = 0; tries < CONFIRM_TRIES; tries += 1) {
    const outcome = await confirmOnce(attempt);
    if (outcome !== 'moved') return outcome;
  }
  // Renamed on every try: swap nothing; the upload can be confirmed again.
  return null;
}

/**
 * One try under the workspace lock (shared) and the lock of the path the row stands for. A
 * `renameFile` holds the workspace lock shared too, so it can move the row between the first read
 * and the path lock: then the try ends with `moved` and the next one locks the new path.
 */
function confirmOnce(attempt: ConfirmAttempt): Promise<ConfirmOutcome | 'moved' | null> {
  const { db, workspaceId, row } = attempt;
  return db.transaction(async (tx): Promise<ConfirmOutcome | 'moved' | null> => {
    await lockForWrite(tx, workspaceId, 'shared', []);
    const [current] = await tx
      .select({ path: logicalPath })
      .from(files)
      .where(and(eq(files.workspaceId, workspaceId), eq(files.id, row.id)));
    if (current === undefined) return null;
    const path = current.path;
    await lockPath(tx, workspaceId, path);
    const [again] = await tx
      .select(fileColumns)
      .from(files)
      .where(and(eq(files.workspaceId, workspaceId), eq(files.id, row.id)));
    if (again === undefined || !confirmable(again, attempt)) return null;
    if ((again.targetPath ?? again.path) !== path) return 'moved';
    return markConfirmed(tx, attempt, again, path);
  });
}

/**
 * A `deleting` row is never revived; a ready row is confirmed again only with `expect: 'any'`; a
 * row whose key changed holds other bytes; a pending row reserved again since `row` was read
 * belongs to that newer reservation.
 */
const confirmable = (
  again: CatalogFile & { readonly status: FileStatus },
  attempt: ConfirmAttempt,
): boolean =>
  again.kind === 'file' &&
  again.storageKey === attempt.storageKey &&
  attempt.statuses.includes(again.status) &&
  sameReservation(again, attempt.row);

/** Make `again` ready at `path`, moving the ready file a replacement takes the path from aside. */
async function markConfirmed(
  tx: Transaction,
  { workspaceId, input }: ConfirmAttempt,
  again: CatalogFile,
  path: string,
): Promise<ConfirmOutcome> {
  const replaced =
    again.targetPath === null ? undefined : await moveHolderAside(tx, workspaceId, path, again.id);
  const [confirmed] = await tx
    .update(files)
    .set({
      status: 'ready',
      path,
      targetPath: null,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      sha256: input.sha256 ?? null,
      ...(input.objectId === undefined
        ? {}
        : { objectId: input.objectId, storageKey: `${again.area}/${input.objectId}` }),
      updatedAt: sql`now()`,
    })
    .where(and(eq(files.workspaceId, workspaceId), eq(files.id, again.id)))
    .returning(fileColumns);
  if (confirmed === undefined) throw new Error('catalog confirm lost its row');
  return replaced === undefined ? { row: confirmed } : { row: confirmed, replaced };
}

// @story US-STO-04
export async function removeFiles(
  context: CatalogContext,
  path: string,
  options?: { readonly pending?: CatalogFile },
): Promise<readonly CatalogFile[]> {
  if (isSidePath(path)) return [];
  const snapshot = options?.pending;
  if (snapshot !== undefined) return claimReservation(context, path, snapshot);
  const single = await removeSingleFile(context, path);
  if (single !== null) return single;
  return removeSubtree(context, path);
}

/**
 * Claim one reservation for deletion before its bytes go: only while it is still the pending row
 * `snapshot` saw, at `path` (a pending replacement stands for it).
 */
function claimReservation(
  { db, workspaceId }: CatalogContext,
  path: string,
  snapshot: CatalogFile,
): Promise<CatalogFile[]> {
  return db.transaction(async (tx) => {
    await lockForWrite(tx, workspaceId, 'shared', [path]);
    return tx
      .update(files)
      .set({
        status: 'deleting',
        path: sidePathOf,
        targetPath: logicalPath,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(files.workspaceId, workspaceId),
          eq(files.id, snapshot.id),
          eq(logicalPath, path),
          reservedAs(snapshot.reservationToken),
        ),
      )
      .returning(fileColumns);
  });
}

/**
 * One file takes the shared workspace lock and its path lock. A folder, or a file with something
 * under it, needs the exclusive lock, which cannot be upgraded to: `null` sends it to a second
 * transaction instead. A writer placing anything under `path` locks `path` too.
 */
function removeSingleFile(
  { db, workspaceId }: CatalogContext,
  path: string,
): Promise<CatalogFile[] | null> {
  return db.transaction(async (tx) => {
    await lockForWrite(tx, workspaceId, 'shared', [path]);
    const [more] = await tx
      .select({ id: files.id })
      .from(files)
      .where(
        and(
          eq(files.workspaceId, workspaceId),
          ne(files.status, 'deleting'),
          pathUnderPrefix(path, logicalPath),
          or(eq(files.kind, 'folder'), ne(logicalPath, path)),
        ),
      )
      .limit(1);
    return more === undefined ? await markRemoved(tx, workspaceId, path) : null;
  });
}

function removeSubtree({ db, workspaceId }: CatalogContext, path: string): Promise<CatalogFile[]> {
  return db.transaction(async (tx) => {
    await lockForWrite(tx, workspaceId, 'exclusive', []);
    const marked = await markRemoved(tx, workspaceId, path);
    // `files_folder_is_ready`: a folder is never `deleting`, and holds no object.
    await tx
      .delete(files)
      .where(
        and(eq(files.workspaceId, workspaceId), eq(files.kind, 'folder'), pathUnderPrefix(path)),
      );
    return marked;
  });
}

export async function forgetFile(
  { db, workspaceId }: CatalogContext,
  row: CatalogFile,
): Promise<void> {
  await db.transaction(async (tx) => {
    // The workspace lock, then the lock of the path the row stands for. A rename may still move the
    // row meanwhile; the delete goes by id, spares a row that became ready and a pending row
    // reserved again since `row` was read.
    await lockForWrite(tx, workspaceId, 'shared', []);
    const [current] = await tx
      .select({ path: logicalPath })
      .from(files)
      .where(and(eq(files.workspaceId, workspaceId), eq(files.id, row.id)));
    if (current === undefined) return;
    await lockPath(tx, workspaceId, current.path);
    await tx
      .delete(files)
      .where(
        and(
          eq(files.workspaceId, workspaceId),
          eq(files.id, row.id),
          or(eq(files.status, 'deleting'), reservedAs(row.reservationToken)),
        ),
      );
  });
}
