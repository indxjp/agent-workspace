import { and, eq, ne, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agentFiles } from '../schema/agent-files.js';
import { files, type UploadMode } from '../schema/files.js';
import { projectFiles } from '../schema/project-files.js';
import { skills } from '../schema/skills.js';
import { SIDE_PATH_ROOT } from '../side-paths.js';
import {
  parsePendingSkillDelete,
  type CatalogFile,
  type CatalogSkill,
} from './resource-catalogs-model.js';

/** What every catalog query of one workspace needs: the database and the scope's workspace. */
export interface CatalogContext {
  readonly db: Database;
  readonly workspaceId: string;
}

/**
 * `path = prefix` or `path` starts with `prefix` followed by an actual `/` — never merely the
 * same leading characters. Built with `left()` rather than `LIKE`: `prefix` is workspace-supplied
 * text that can legally contain `%` or `_` (`files.ts`'s `files_path_shape` check does not forbid
 * either), and both are `LIKE` wildcards — a `LIKE ${prefix} || '/%'` pattern would silently widen
 * to match paths the prefix's literal characters never named. `left()` compares bytes, not a
 * pattern, so no character in `prefix` is special.
 *
 * The cut length is `char_length(${boundary})`, computed by Postgres on the bound parameter —
 * never JS's `.length`. `left()` counts CHARACTERS; JS `.length` counts UTF-16 code units, which
 * over-counts by one for every character outside the BMP (most emoji). `files_path_shape` (see
 * `files.ts`) explicitly permits such characters in a path, so a JS-length cut silently
 * overshoots the true boundary for them and the predicate never matches — see W9-FILES-131's
 * verification-round-2 notes for the reproduction.
 */
export function pathUnderPrefix(prefix: string, column: SQL = sql`${files.path}`) {
  const boundary = `${prefix}/`;
  return sql`(${column} = ${prefix} or left(${column}, char_length(${boundary})) = ${boundary})`;
}

/** The path a row stands for: its own, or the one a side-path row waits to take. */
export const logicalPath = sql<string>`coalesce(${files.targetPath}, ${files.path})`;

/** The side path a row moves to when it is removed or replaced; the same shape as `sidePath`. */
export const sidePathOf = sql`${`${SIDE_PATH_ROOT}/`} || ${files.id}::text`;

/**
 * A pending row's reservation token: the exact time of its last reservation, as text. Every write
 * that reserves again moves `updated_at` forward ({@link reservedAgainAt}); a ready or `deleting`
 * row has none.
 */
const reservationToken = sql<
  string | null
>`case when ${files.status} = 'pending' then extract(epoch from ${files.updatedAt})::text end`;

/**
 * The row is pending under this reservation. `null`, a snapshot of a row that was not pending,
 * matches none; `undefined`, a row a caller built without a token, matches any pending row.
 */
export const reservedAs = (token: string | null | undefined): SQL =>
  token === undefined
    ? sql`${files.status} = 'pending'`
    : token === null
      ? sql`false`
      : sql`(${files.status} = 'pending' and extract(epoch from ${files.updatedAt})::text = ${token})`;

/**
 * Whether a same-owner re-reserve of `holder` writes anything: the case {@link reservedAgainAt}
 * leaves `updated_at` alone and the declared size and type match is a no-op, so the reserve
 * returns the row it read instead of writing it again. A burst of retries then commits under the
 * path lock without a transaction id or a WAL flush each.
 */
export const reservesAgain = (
  holder: CatalogFile,
  input: {
    readonly sizeBytes: number;
    readonly contentType: string | null;
    readonly uploadMode?: UploadMode;
  },
): boolean =>
  input.uploadMode === 'signed' ||
  holder.sizeBytes !== input.sizeBytes ||
  holder.contentType !== input.contentType;

/**
 * `updated_at` for a same-owner re-reserve of a pending row. A signed re-mint always moves it,
 * strictly forward even within one clock tick, so a snapshot taken before is stale; a retry
 * without an upload mode moves it only when it changes what was declared.
 */
export const reservedAgainAt = (input: {
  readonly sizeBytes: number;
  readonly contentType: string | null;
  readonly uploadMode?: UploadMode;
}): SQL => {
  const advanced = sql`greatest(now(), ${files.updatedAt} + interval '1 microsecond')`;
  if (input.uploadMode === 'signed') return advanced;
  return sql`case when ${files.sizeBytes} = ${input.sizeBytes} and ${files.contentType} is not distinct from ${input.contentType}::text then ${files.updatedAt} else ${advanced} end`;
};

export const fileColumns = {
  id: files.id,
  path: files.path,
  kind: files.kind,
  storageKey: files.storageKey,
  sizeBytes: files.sizeBytes,
  contentType: files.contentType,
  status: files.status,
  objectId: files.objectId,
  area: files.area,
  sha256: files.sha256,
  targetPath: files.targetPath,
  uploadMode: files.uploadMode,
  reservationToken,
  createdBy: files.createdBy,
  ownerPrincipalId: files.ownerPrincipalId,
  updatedAt: files.updatedAt,
};

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * A file or folder implies its parent folders, the rule `pathIsFolder` in
 * `apps/web/server/files/handlers.ts` applies when it reads. Every write that places a row at a
 * path (put, rename, subtree rename) calls this, so a `files('<folder>')` grant resolves without
 * a separate `mkdir` (issue #899). Each parent row takes the owner of the first placed row under
 * it. An existing row at a parent path, folder or file, is never touched.
 */
export async function insertParentFolders(
  tx: Transaction,
  workspaceId: string,
  placed: readonly Pick<CatalogFile, 'path' | 'ownerPrincipalId' | 'createdBy'>[],
): Promise<void> {
  const parents = new Map<string, (typeof placed)[number]>();
  for (const row of placed) {
    for (const path of parentPaths(row.path)) {
      if (!parents.has(path)) parents.set(path, row);
    }
  }
  if (parents.size === 0) return;
  // The caller already holds the locks for these paths ({@link lockForWrite}).
  await tx
    .insert(files)
    .values(
      [...parents].map(([path, row]) => ({
        workspaceId,
        path,
        kind: 'folder' as const,
        ownerPrincipalId: row.ownerPrincipalId,
        createdBy: row.createdBy,
      })),
    )
    .onConflictDoNothing({ target: [files.workspaceId, files.path] });
}

/**
 * Serialize writers of one path for the rest of the transaction. "One live row per path" must hold
 * without leaning on `files_workspace_path_key`, which a later release replaces with partial keys.
 * A hash collision only makes two unrelated paths wait for each other.
 */
export async function lockPath(tx: Transaction, workspaceId: string, path: string): Promise<void> {
  await tx.execute(sql`select ${pathLockCall(workspaceId, path)}`);
}

const pathLockCall = (workspaceId: string, path: string): SQL =>
  sql`pg_advisory_xact_lock(hashtextextended(${workspaceId}::text || ':' || ${path}, 0))`;

/**
 * The one lock order every writer of `files` follows, first thing in its transaction: the
 * workspace lock, then the per-path locks in one sorted batch, so no two writers wait on each other
 * in a cycle. A prefix writer (`rename` and `remove` of a folder) takes the workspace lock
 * `exclusive` and needs no path locks, since no other writer can run beside it. A single-path
 * writer takes it `shared` and passes every path it touches, parent folders included.
 */
export async function lockForWrite(
  tx: Transaction,
  workspaceId: string,
  mode: 'exclusive' | 'shared',
  paths: readonly string[],
): Promise<void> {
  const workspaceLock =
    mode === 'exclusive'
      ? sql`pg_advisory_xact_lock(hashtextextended(${workspaceId}::text, 0))`
      : sql`pg_advisory_xact_lock_shared(hashtextextended(${workspaceId}::text, 0))`;
  // One round-trip, so every writer waiting on a path lock queues behind one statement, not several.
  // The order relies on the executor evaluating a select list left to right, which PostgreSQL does
  // not document. If that ever changed, two writers could take the locks in opposite orders, and
  // PostgreSQL would detect the deadlock (40P01) and fail one write: an error, not a hang or loss.
  const pathLocks = [...new Set(paths)].sort().map((path) => pathLockCall(workspaceId, path));
  await tx.execute(sql`select ${sql.join([workspaceLock, ...pathLocks], sql`, `)}`);
}

/**
 * Mark every file whose path, or pending replacement's path, is `path` or under it `deleting`, and
 * move it to its side path so the path is free to reserve at once. The caller holds the locks.
 */
export function markRemoved(tx: Transaction, workspaceId: string, path: string) {
  return tx
    .update(files)
    .set({ status: 'deleting', path: sidePathOf, targetPath: logicalPath, updatedAt: sql`now()` })
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        pathUnderPrefix(path, logicalPath),
        eq(files.kind, 'file'),
        ne(files.status, 'deleting'),
      ),
    )
    .returning(fileColumns);
}

/**
 * Move the ready file at `path` aside as `deleting` so the replacement `newId` can take the path,
 * and point its grants at the new row: grants name the path, not the row. The caller holds the
 * path lock. Returns the moved row, or `undefined` when nothing held the path.
 */
export async function moveHolderAside(
  tx: Transaction,
  workspaceId: string,
  path: string,
  newId: string,
): Promise<CatalogFile | undefined> {
  // Moved before the new row takes the path, so the full key never sees two.
  const [holder] = await tx
    .update(files)
    .set({ status: 'deleting', path: sidePathOf, targetPath: path, updatedAt: sql`now()` })
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        eq(files.path, path),
        ne(files.id, newId),
        eq(files.kind, 'file'),
      ),
    )
    .returning(fileColumns);
  if (holder === undefined) return undefined;
  await tx
    .update(agentFiles)
    .set({ fileId: newId })
    .where(and(eq(agentFiles.workspaceId, workspaceId), eq(agentFiles.fileId, holder.id)));
  await tx
    .update(projectFiles)
    .set({ fileId: newId })
    .where(and(eq(projectFiles.workspaceId, workspaceId), eq(projectFiles.fileId, holder.id)));
  return holder;
}

/** A pending replacement's parents are those of the path it stands for, never of its side path. */
export const atLogicalPath = <T extends Pick<CatalogFile, 'path' | 'targetPath'>>(row: T) => ({
  ...row,
  path: row.targetPath ?? row.path,
});

export const skillColumns = {
  id: skills.id,
  name: skills.name,
  skillMd: skills.skillMd,
  enabled: skills.enabled,
  createdBy: skills.createdBy,
  ownerPrincipalId: skills.ownerPrincipalId,
  pendingDelete: skills.pendingDelete,
  builtinDigest: skills.builtinDigest,
  meta: skills.meta,
};

export function toCatalogSkill(row: {
  readonly id: string;
  readonly name: string;
  readonly skillMd: string;
  readonly enabled: boolean;
  readonly createdBy: string | null;
  readonly ownerPrincipalId: string;
  readonly pendingDelete: unknown;
  readonly builtinDigest: string | null;
  readonly meta: unknown;
}): CatalogSkill {
  return {
    ...row,
    pendingDelete: row.pendingDelete === null ? null : parsePendingSkillDelete(row.pendingDelete),
  };
}

/** `a/b/c.txt` gives `a` and `a/b`: the folders {@link insertParentFolders} places. */
export function parentPaths(path: string): string[] {
  const segments = path.split('/');
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join('/'));
}
