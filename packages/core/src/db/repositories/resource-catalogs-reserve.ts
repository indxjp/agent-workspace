import { and, eq, ne, or } from 'drizzle-orm';

import { files } from '../schema/files.js';
import { isSidePath, sidePath } from '../side-paths.js';
import {
  CatalogPathPendingError,
  type CatalogFile,
  type ReserveOutcome,
} from './resource-catalogs-model.js';
import type { CatalogPort } from './resource-catalogs-port.js';
import {
  fileColumns,
  insertParentFolders,
  lockForWrite,
  parentPaths,
  reservedAgainAt,
  reservesAgain,
  type CatalogContext,
  type Transaction,
} from './resource-catalogs-sql.js';

type ReserveInput = Parameters<CatalogPort['reserve']>[1];
type CreateFolderInput = Parameters<CatalogPort['createFolder']>[1];

/** One reserve, inside its transaction and under its path locks. */
interface ReserveStep {
  readonly tx: Transaction;
  readonly workspaceId: string;
  readonly path: string;
  readonly input: ReserveInput;
}

export async function reserveFile(
  { db, workspaceId }: CatalogContext,
  path: string,
  input: ReserveInput,
): Promise<ReserveOutcome> {
  if (isSidePath(path)) throw new Error(`${path} is a reserved catalog path.`);
  return db.transaction(async (tx): Promise<ReserveOutcome> => {
    await lockForWrite(tx, workspaceId, 'shared', [path, ...parentPaths(path)]);
    const step: ReserveStep = { tx, workspaceId, path, input };
    const refreshedAtPath = await refreshSignedAtPath(step);
    if (refreshedAtPath !== undefined) return { kind: 'taken', row: refreshedAtPath };
    const { live, waiting } = await readHolders(step);
    // The ready file a pending replacement takes the path from, read under the path lock.
    const target = live?.status === 'ready' && live.kind === 'file' ? live : undefined;
    if (live !== undefined && target === undefined) return takenOrRefreshed(step, live, undefined);
    if (waiting !== undefined) return takenOrRefreshed(step, waiting, target);
    await refuseSameObject(step);
    return insertReservation(step, target);
  });
}

/**
 * The new size and type of a refreshed row. The write moves `updated_at`, the time `stalePending`
 * compares, so a link minted again is not cleaned up as abandoned.
 */
const refreshOf = (input: ReserveInput) => ({
  sizeBytes: input.sizeBytes,
  contentType: input.contentType,
  updatedAt: reservedAgainAt(input),
});

/**
 * A pending row at the path itself is always the live holder, so its owner's signed re-mint, which
 * always writes, is this one statement under the path lock instead of a read and a write. Any other
 * re-reserve, every loser of a burst, reads the holders and writes only when it declares something
 * new. `undefined`: nothing matched, so read them.
 */
async function refreshSignedAtPath({
  tx,
  workspaceId,
  path,
  input,
}: ReserveStep): Promise<CatalogFile | undefined> {
  if (input.uploadMode !== 'signed') return undefined;
  const [refreshed] = await tx
    .update(files)
    .set(refreshOf(input))
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        eq(files.path, path),
        eq(files.status, 'pending'),
        eq(files.ownerPrincipalId, input.ownerPrincipalId),
        eq(files.uploadMode, 'signed'),
      ),
    )
    .returning(fileColumns);
  return refreshed;
}

/** The live row at the path and a pending replacement waiting for it, in one read. */
async function readHolders({ tx, workspaceId, path }: ReserveStep) {
  const holders = await tx
    .select(fileColumns)
    .from(files)
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        or(
          and(eq(files.path, path), ne(files.status, 'deleting')),
          and(eq(files.status, 'pending'), eq(files.targetPath, path)),
        ),
      ),
    );
  return {
    live: holders.find((row) => row.path === path && row.status !== 'deleting'),
    waiting: holders.find((row) => row.status === 'pending' && row.targetPath === path),
  };
}

/**
 * A ready or `deleting` row holds the path. A pending one is refreshed for its owner and refused for
 * anyone else (FX-7). A relay save is never refreshed: a second save of the path is refused and
 * must not disturb the one writing.
 */
async function takenOrRefreshed(
  { tx, workspaceId, path, input }: ReserveStep,
  holder: CatalogFile,
  replaces: CatalogFile | undefined,
): Promise<ReserveOutcome> {
  if (holder.status !== 'pending') return { kind: 'taken', row: holder };
  if (
    holder.ownerPrincipalId !== input.ownerPrincipalId ||
    (holder.uploadMode ?? null) !== (input.uploadMode ?? null)
  ) {
    throw new CatalogPathPendingError(path);
  }
  const withTarget = replaces === undefined ? {} : { replaces };
  if (input.uploadMode === 'relay' || !reservesAgain(holder, input))
    return { kind: 'taken', row: holder, ...withTarget };
  const [refreshed] = await tx
    .update(files)
    .set(refreshOf(input))
    .where(and(eq(files.workspaceId, workspaceId), eq(files.id, holder.id)))
    .returning(fileColumns);
  if (refreshed === undefined) throw new Error('catalog reserve lost its locked row');
  return { kind: 'taken', row: refreshed, ...withTarget };
}

/**
 * The untargeted `onConflictDoNothing` of the insert would swallow this key too and report the path;
 * refuse it here, as the memory catalog does.
 */
async function refuseSameObject({ tx, workspaceId, input }: ReserveStep): Promise<void> {
  const [sameObject] = await tx
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.workspaceId, workspaceId), eq(files.objectId, input.objectId)));
  if (sameObject !== undefined) {
    throw new Error('duplicate key value violates unique constraint "files_workspace_object_key"');
  }
}

/**
 * Insert the pending row: at the path itself, or at a side path when it replaces `target`. A
 * conflict leaves the row that holds the path to be taken or refreshed.
 */
async function insertReservation(
  step: ReserveStep,
  target: CatalogFile | undefined,
): Promise<ReserveOutcome> {
  const { tx, workspaceId, path, input } = step;
  const replacing = target !== undefined;
  const id = crypto.randomUUID();
  // No conflict target: valid with or without `files_workspace_path_key`. A conflict can only be a
  // legacy `deleting` row still holding the path, or a one-step write racing past the lock.
  const inserted = await tx
    .insert(files)
    .values({
      id,
      workspaceId,
      path: replacing ? sidePath(id) : path,
      targetPath: replacing ? path : null,
      kind: 'file',
      storageKey: `${input.area ?? 'files'}/${input.objectId}`,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      status: 'pending',
      objectId: input.objectId,
      area: input.area ?? 'files',
      uploadMode: input.uploadMode ?? null,
      ownerPrincipalId: input.ownerPrincipalId,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing()
    .returning(fileColumns);
  const row = inserted[0];
  if (row !== undefined) {
    // The ready file being replaced already implies the parent folders.
    if (!replacing) await insertParentFolders(tx, workspaceId, [row]);
    return replacing ? { kind: 'reserved', row, replaces: target } : { kind: 'reserved', row };
  }
  const [holder] = await tx
    .select(fileColumns)
    .from(files)
    .where(and(eq(files.workspaceId, workspaceId), eq(files.path, path)))
    .for('update');
  if (holder === undefined) throw new Error('catalog reserve conflicted with no row');
  return takenOrRefreshed(step, holder, undefined);
}

// @story US-STO-01
export async function createFolder(
  { db, workspaceId }: CatalogContext,
  path: string,
  input: CreateFolderInput,
): ReturnType<CatalogPort['createFolder']> {
  if (isSidePath(path)) throw new Error(`${path} is a reserved catalog path.`);
  return db.transaction(async (tx) => {
    await lockForWrite(tx, workspaceId, 'shared', [path, ...parentPaths(path)]);
    const [held] = await tx
      .select(fileColumns)
      .from(files)
      .where(and(eq(files.workspaceId, workspaceId), eq(files.path, path)));
    if (held !== undefined) return { kind: 'taken', row: held };
    const placed = {
      path,
      ownerPrincipalId: input.ownerPrincipalId,
      createdBy: input.createdBy ?? null,
    };
    await insertParentFolders(tx, workspaceId, [placed]);
    const [row] = await tx
      .insert(files)
      .values({ workspaceId, ...placed, kind: 'folder' })
      .returning(fileColumns);
    if (row === undefined) throw new Error('catalog createFolder inserted no row');
    return { kind: 'created', row };
  });
}
