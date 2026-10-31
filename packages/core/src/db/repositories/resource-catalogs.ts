import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { setTimeout as sleep } from 'node:timers/promises';

import type { Database } from '../client.js';
import { agentSkills } from '../schema/agent-skills.js';
import { agentFiles } from '../schema/agent-files.js';
import { files, type FileKind, type FileStatus, type UploadMode } from '../schema/files.js';
import { projectFiles } from '../schema/project-files.js';
import { skillRevisions } from '../schema/skill-revisions.js';
import { skills } from '../schema/skills.js';
import type { StorageArea } from '../../storage/storage-areas.js';
import { isSidePath, SIDE_PATH_ROOT, sidePath } from '../side-paths.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export interface CatalogFile {
  readonly id: string;
  readonly path: string;
  readonly kind: FileKind;
  readonly storageKey: string | null;
  readonly sizeBytes: number;
  readonly contentType: string | null;
  // storage-bridge(#1634): optional until the hand-written file-catalog fakes are replaced; the
  // database repository always sets it.
  readonly status?: FileStatus;
  // storage-bridge(#1634): optional for the same reason as `status`. `objectId` null is a folder,
  // which has no object.
  readonly objectId?: string | null;
  readonly area?: StorageArea;
  readonly sha256?: string | null;
  // storage-bridge(#1634): optional for the same reason as `status`. Set exactly when `path` is a
  // side path (`side-paths.ts`): the real path a pending replacement or a removed row stands for.
  readonly targetPath?: string | null;
  // storage-bridge(#1634): optional for the same reason as `status`. How a pending upload is written.
  readonly uploadMode?: UploadMode | null;
  // storage-bridge(#1634): optional for the same reason as `status`. Both catalogs set it on every
  // row they return, and a row without one is checked by id and key only.
  /**
   * Opaque: which reservation of a pending row this snapshot saw. A signed re-mint, or a retry that
   * changes the declared size or type, issues a new one, so `confirm`, `forget` and a claiming
   * `remove` of an older snapshot do nothing. `null` on a ready or `deleting` row.
   */
  readonly reservationToken?: string | null;
  /** Compatibility attribution for a membership principal. */
  readonly createdBy: string | null;
  /** Exact owner; an upsert at an existing path never transfers it. */
  readonly ownerPrincipalId: string;
  // storage-bridge(#1634): optional for the same reason as `status`, until the hand-written
  // file-catalog fakes are replaced; both catalogs set it on every row they return.
  /**
   * When the row was last written: reserved, confirmed, renamed or replaced. A file answers it as
   * its `lastModified`.
   */
  readonly updatedAt?: Date;
}

export interface CatalogSkill {
  readonly id: string;
  readonly name: string;
  readonly skillMd: string;
  readonly enabled: boolean;
  /** Compatibility attribution for a membership principal. */
  readonly createdBy: string | null;
  /** Exact owner; an upsert of an existing name never transfers it. */
  readonly ownerPrincipalId: string;
  /** Set while a delete that passed its in-use check is removing the skill's bytes. */
  readonly pendingDelete: PendingSkillDelete | null;
  /** The digest of the built-in release installed into the row; null for a skill the user made. */
  readonly builtinDigest: string | null;
  /** The platform's record about the skill (name, enabled flag, timestamps); null until written. */
  readonly meta: unknown;
}

/** What a caller may write to a skill row; the delete, built-in and meta records have their own methods. */
type SkillInput = Omit<
  CatalogSkill,
  'id' | 'createdBy' | 'pendingDelete' | 'builtinDigest' | 'meta'
> & {
  readonly createdBy?: string | null;
};

/**
 * What a pending delete recorded: the owner of the skill it is removing, when it had one, and the
 * skill's published revision numbers (a retry clears the files of every one of them).
 */
export interface PendingSkillDelete {
  readonly ownerPrincipalId: string | null;
  readonly revisions: readonly number[];
}

/**
 * Read a persisted pending-delete record. Anything unreadable still marks the delete as pending; it
 * just proves no owner and no revisions.
 */
export function parsePendingSkillDelete(value: unknown): PendingSkillDelete {
  if (typeof value !== 'object' || value === null) return { ownerPrincipalId: null, revisions: [] };
  const { ownerPrincipalId, revisions }: Record<string, unknown> = { ...value };
  return {
    ownerPrincipalId: typeof ownerPrincipalId === 'string' ? ownerPrincipalId : null,
    revisions:
      Array.isArray(revisions) &&
      revisions.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0)
        ? revisions
        : [],
  };
}

/** The record a delete leaves on `skill`: its owner and every revision number seen so far. */
export function pendingDeleteFor(
  skill: Pick<CatalogSkill, 'ownerPrincipalId' | 'pendingDelete'>,
  revisions: readonly number[],
): PendingSkillDelete {
  const all = new Set([...(skill.pendingDelete?.revisions ?? []), ...revisions]);
  return { ownerPrincipalId: skill.ownerPrincipalId, revisions: [...all].sort((a, b) => a - b) };
}

/** How long a pending revision may take before the next publish treats it as crashed. */
// ponytail: a publish slower than this loses its turn and its number; a heartbeat if that happens
export const STALE_SKILL_REVISION_MS = 5 * 60 * 1000;

/** How often a publish checks whether the earlier publishes of its skill have finished. */
// ponytail: polling; LISTEN/NOTIFY if publishes of one skill ever queue up for long
export const SKILL_PUBLISH_POLL_MS = 25;

/** One published revision of a skill: an immutable snapshot of its files (SDK-19, N-1). */
export interface CatalogSkillRevision {
  readonly number: number;
  readonly fileCount: number;
  readonly publishedAt: Date;
}

/**
 * What deleting a skill's catalog row can produce. `in-use` names every agent the skill is still
 * assigned to, and nothing is deleted; an assignment is never cascaded away by a skill delete.
 */
export type DeleteCatalogSkillOutcome =
  | { readonly kind: 'deleted'; readonly skill: CatalogSkill }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'in-use'; readonly agentIds: readonly string[] };

/** What marking a skill for deletion can produce; `in-use` clears the mark and `not-found` changes nothing. */
export type MarkSkillDeletingOutcome =
  | { readonly kind: 'marked'; readonly pending: PendingSkillDelete }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'in-use'; readonly agentIds: readonly string[] };

/**
 * A write met an upload still in flight: the path, or a path under the folder being moved, holds a
 * `pending` row (storage design §04). Nothing was written. The HTTP layer answers
 * `409 upload_in_progress`; `path` is the caller's own input and is never put in the message.
 */
export class CatalogPathPendingError extends Error {
  public override readonly name = 'CatalogPathPendingError';

  public constructor(public readonly path: string) {
    super('an upload to this path is still in progress');
  }
}

/**
 * `reserved`: a pending row now holds the path, new or the caller's own refreshed one. `taken`: a
 * ready row already did; nothing changed. `replaces` is set when `row` is a pending replacement
 * (`targetPath` set): the ready file it will take the path from, read under the reservation's
 * lock. It is the file a replacement policy decides on; a path read before or after the reserve
 * may name another one.
 */
export type ReserveOutcome =
  | { readonly kind: 'reserved'; readonly row: CatalogFile; readonly replaces?: CatalogFile }
  | { readonly kind: 'taken'; readonly row: CatalogFile; readonly replaces?: CatalogFile };

/** The confirm result: `replaced` is the ready row the confirmed one took the path from, now `deleting`. */
export interface ConfirmOutcome {
  readonly row: CatalogFile;
  readonly replaced?: CatalogFile;
}

/** A rename or move would land on a logical path that another live row already holds. */
export class CatalogPathTakenError extends Error {
  constructor(readonly path: string) {
    super(`A catalog row already holds ${path}.`);
    this.name = 'CatalogPathTakenError';
  }
}

const CATALOG_PAGE_MAX = 1000;

/**
 * Every ready row of the workspace, ordered by path, read page by page through {@link CatalogPort.list}.
 * For a caller that needs the whole tree at once (a grant check, a search, a run's file set).
 */
export async function listCatalogFiles(
  catalog: Pick<CatalogPort, 'list'>,
): Promise<readonly CatalogFile[]> {
  const all: CatalogFile[] = [];
  let cursor: string | undefined;
  do {
    const page = await catalog.list('', cursor === undefined ? {} : { cursor });
    all.push(...page.rows);
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return all;
}

/**
 * Where a rename of `from` to `to` moves `key`, a path or a legacy storage key at or under `from`.
 * The JS cut is safe: `from` is a prefix of `key`. The database update applies the same rule in SQL.
 */
export function renamedKey(key: string, from: string, to: string): string {
  return `${to}${key.slice(from.length)}`;
}

/** How often `confirm` follows a row that a rename moved while it waited for the path lock. */
const CONFIRM_TRIES = 3;

/** Clamp a requested page size to 1..{@link CATALOG_PAGE_MAX}; absent or not finite means the max. */
export function clampCatalogPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CATALOG_PAGE_MAX;
  return Math.min(Math.max(Math.trunc(limit), 1), CATALOG_PAGE_MAX);
}

/**
 * The catalog operations of the storage design, §04. A row carries an area, an object id and a
 * checksum. Only a `ready` row, or a `pending` upload to a free path, occupies its real path: a
 * pending replacement of a ready file and a removed (`deleting`) row wait at a side path
 * (`side-paths.ts`) and keep the path they stand for in `targetPath`. PostgreSQL and the in-memory
 * catalog both implement it and both run `describeCatalogConformance`.
 */
// @story US-STO-02
export interface CatalogPort {
  /**
   * Add a pending row for `path` (and ready parent folders), or say who holds it. On a free path the
   * row takes the path itself. A ready file is replaced: the new row waits at a side path until
   * `confirm` swaps it in. A folder holds its path and comes back as `taken`. A pending row for the path (at
   * it, or waiting to replace it) of the same owner is an upload retried: its size and content type
   * are refreshed and it comes back as `taken` (one `reserved` per row). A pending replacement, new
   * or retried, comes back with the ready file it replaces as `replaces`. A pending row of another
   * owner throws {@link CatalogPathPendingError}. `storageKey` is `<area>/<objectId>`.
   */
  reserve(
    path: string,
    input: {
      readonly ownerPrincipalId: string;
      readonly createdBy?: string | null;
      readonly sizeBytes: number;
      readonly contentType: string | null;
      readonly objectId: string;
      readonly area?: StorageArea;
      /**
       * How the upload is written. A pending row is refreshed only by a caller of the same mode;
       * any other caller of its owner gets {@link CatalogPathPendingError}, so one kind of upload
       * never rewrites the other's size or signs its object.
       */
      readonly uploadMode?: UploadMode;
    },
  ): Promise<ReserveOutcome>;
  /**
   * Make a reserved row ready, record its checksum and stamp `updatedAt` so cached search text of
   * older bytes is stale. Only a `pending` row whose storage key still equals `row.storageKey` is
   * confirmed; otherwise `null` and nothing changes: the row is gone, removed (a `deleting` row is
   * never revived) or already ready. Re-confirming a ready row (new bytes written under the same
   * key) needs `expect: 'any'`. A replacement takes the path in one transaction: the ready row it
   * replaces is marked `deleting` and moved aside (`replaced`), and its grants follow the path to
   * the new row. A replacement whose file is renamed meanwhile takes the new path. With `objectId`,
   * the confirmed row names that object instead (its storage key becomes `<area>/<objectId>`) in
   * the same update and keeps its row id: a signed upload publishes a copy of its verified bytes
   * that no link was ever signed for.
   */
  confirm(
    row: CatalogFile,
    input: {
      readonly sizeBytes: number;
      readonly contentType: string | null;
      readonly sha256?: string | null;
      readonly expect?: 'pending' | 'any';
      readonly objectId?: string;
    },
  ): Promise<ConfirmOutcome | null>;
  /**
   * Ready rows only, unless `includePending` asks for a pending row at `path` too. A `deleting` row
   * and a pending replacement (which waits at a side path) are never returned, and nor is a side path.
   */
  get(path: string, options?: { readonly includePending?: boolean }): Promise<CatalogFile | null>;
  /**
   * Ready rows at or under `folder` (`''` is the whole workspace), ordered by path. `cursor` is the
   * last path of the previous page; `limit` is clamped to 1..1000. The returned `cursor` is `null`
   * on the last page.
   */
  list(
    folder: string,
    page?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<{ readonly rows: readonly CatalogFile[]; readonly cursor: string | null }>;
  /**
   * Add a ready folder row at `path` (and ready parent folders): a row and no object. Any row that
   * already holds the path, a pending upload included, comes back as `taken` with nothing changed.
   */
  createFolder(
    path: string,
    input: { readonly ownerPrincipalId: string; readonly createdBy?: string | null },
  ): Promise<{ readonly kind: 'created' | 'taken'; readonly row: CatalogFile }>;
  /**
   * Pending rows in this workspace outside area `staging`: the number the pending-upload cap compares
   * (the storage design, §05). A staged archive is not an upload, so it never uses the cap. With
   * `newerThan`, only rows reserved (or re-reserved) at or after it: the inverse of `stalePending`.
   */
  countPending(newerThan?: Date): Promise<number>;
  /**
   * The pending upload for `path`: the pending row at the path, or the pending replacement waiting
   * at a side path to take it over. `get` never returns the latter. Null when none is pending.
   */
  pending(path: string): Promise<CatalogFile | null>;
  /**
   * Move the row at `from`, or the whole subtree under it, keeping ids; answers how many rows it
   * moved, folder rows included, and how many of them are files. A row with an object id keeps its
   * `storageKey` and `objectId`: only the path changes. Throws {@link CatalogPathPendingError},
   * moving nothing, while a row in the subtree is pending (a pending replacement included), and
   * {@link CatalogPathTakenError}, moving nothing, when a destination is held by a row outside the
   * moved set.
   */
  rename(from: string, to: string): Promise<{ readonly rows: number; readonly files: number }>;
  /**
   * Mark the file at `path`, or every file under it, `deleting`, and return the rows it marked, in
   * no particular order (a second call returns none). A pending replacement of a removed file goes
   * with it. Each marked row moves to a side path at once, so the path is free to reserve again.
   * Folder rows are dropped: they hold no object. The object is removed after, and `forget` then
   * drops the row.
   */
  remove(
    path: string,
    options?: { readonly pending?: CatalogFile },
  ): Promise<readonly CatalogFile[]>;
  /**
   * Pending rows last reserved (or re-reserved) before `olderThan`: uploads that never completed.
   * For the cleanup job.
   */
  stalePending(olderThan: Date): Promise<readonly CatalogFile[]>;
  /** Rows marked `deleting` whose object is still to be removed. For the cleanup job. */
  deleting(): Promise<readonly CatalogFile[]>;
  /**
   * Drop a pending or `deleting` row. Idempotent, and a row that has become `ready` is left alone.
   * For the cleanup job.
   */
  forget(row: CatalogFile): Promise<void>;
  /**
   * Every file row in any status, a `deleting` row and a side-path row included, whose `objectId`
   * is in `objectIds`. An object no such row points at is an orphan. For the cleanup job, which
   * passes one listing page at a time.
   */
  referencing(input: { readonly objectIds: readonly string[] }): Promise<readonly CatalogFile[]>;
}

export interface ResourceCatalogRepository extends CatalogPort {
  listSkills(): Promise<readonly CatalogSkill[]>;
  /** The skill named `name`, or `null` when there is none. */
  getSkill(name: string): Promise<CatalogSkill | null>;
  putSkill(input: SkillInput): Promise<CatalogSkill>;
  /**
   * Insert the skill only when its name is free, and return `null` when the name is taken, whoever
   * holds it. Two servers calling this for one name get one row and one `null`: the catalog, not a
   * process-local lock, decides who owns the name (the storage design, §04 "Saving a file").
   */
  createSkill(input: SkillInput): Promise<CatalogSkill | null>;
  /**
   * Delete one skill's catalog row unless an agent has it assigned. The assignment check and the
   * delete run in one transaction that locks the row, so an assignment racing the delete either
   * lands first (and is reported) or fails its foreign key. With `onlyId`, a row of that name with
   * any other id is left alone and reported `not-found`, so a caller releasing the row it created
   * never deletes a later row that reuses the name.
   */
  deleteSkill(name: string, onlyId?: string): Promise<DeleteCatalogSkillOutcome>;
  /**
   * Start deleting a skill, under the row's lock: when an agent has it assigned, refuse with
   * `in-use` and leave any earlier mark as it is; otherwise record as its `pendingDelete` the owner and the
   * number of every revision, pending ones included, together with those an earlier mark recorded.
   * From then on no revision can be published to it. The row stays until {@link deleteSkill}
   * removes it, so an interrupted delete keeps what its retry needs.
   */
  markSkillDeleting(name: string): Promise<MarkSkillDeletingOutcome>;
  /**
   * Record a pending delete read from a skill's legacy marker object, unless the row already has
   * one, under the row's lock and with the in-use rule of {@link markSkillDeleting}: a skill an
   * agent has assigned is not marked. A missing row is left alone. Answers whether the row now
   * holds a pending delete.
   */
  // storage-bridge(#1699): read skill marker objects written before the columns existed
  backfillSkillPendingDelete(name: string, pending: PendingSkillDelete): Promise<boolean>;
  /**
   * Write the skill's platform record (`null` clears it), or with `onlyIfEmpty` only when the row
   * has none yet. Answers `false` when no row has that name.
   */
  setSkillMeta(name: string, meta: unknown, onlyIfEmpty?: boolean): Promise<boolean>;
  /** Record the digest of the built-in release installed into the skill's row. */
  setSkillBuiltinDigest(name: string, digest: string): Promise<void>;
  /**
   * Allocate the skill's next revision number (1, 2, 3, ...) under a lock on the skill row and
   * commit it as a pending revision, wait until every earlier pending revision of the skill is
   * complete, gone or stale, call `write(number, abandoned)` to put the revision's bytes in storage
   * with no transaction open, then record the revision as complete. Two publishes of one skill
   * therefore never share a number and write in number order, and a pending revision is never listed
   * or pinned. No connection is held while waiting or writing. If
   * `write` throws, the pending row is removed and the number may be reused. A pending row older than
   * {@link STALE_SKILL_REVISION_MS} is a crashed publish: the next allocation removes it and passes
   * its number in `abandoned`, so the caller can clear its bytes. An abandoned number is never
   * allocated again, and an abandoned publish that finishes later completes nothing (`null`). `null` when the skill does not
   * exist, or stops existing before the revision completes. When `write` returns the skill's new
   * `SKILL.md` and enabled flag, the row is updated unless a newer revision completed first, so the
   * row always matches the newest revision's publisher.
   */
  publishSkillRevision(
    name: string,
    input: {
      readonly fileCount: number;
      readonly write: (
        number: number,
        abandoned: readonly number[],
      ) => Promise<Pick<CatalogSkill, 'skillMd' | 'enabled'> | undefined>;
    },
  ): Promise<CatalogSkillRevision | null>;
  /**
   * The skill's complete revisions, newest first; empty for an unknown skill. `includePending` adds
   * the revisions still being written, for a delete that must clear their files too.
   */
  listSkillRevisions(
    name: string,
    options?: { readonly includePending?: boolean },
  ): Promise<readonly CatalogSkillRevision[]>;
}

export interface ResourceCatalogRepositoryProvider {
  forScope(scope: WorkspaceScope): ResourceCatalogRepository;
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
function pathUnderPrefix(prefix: string, column: SQL = sql`${files.path}`) {
  const boundary = `${prefix}/`;
  return sql`(${column} = ${prefix} or left(${column}, char_length(${boundary})) = ${boundary})`;
}

/** The path a row stands for: its own, or the one a side-path row waits to take. */
const logicalPath = sql<string>`coalesce(${files.targetPath}, ${files.path})`;

/** The side path a row moves to when it is removed or replaced; the same shape as `sidePath`. */
const sidePathOf = sql`${`${SIDE_PATH_ROOT}/`} || ${files.id}::text`;

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
const reservedAs = (token: string | null | undefined): SQL =>
  token === undefined
    ? sql`${files.status} = 'pending'`
    : token === null
      ? sql`false`
      : sql`(${files.status} = 'pending' and extract(epoch from ${files.updatedAt})::text = ${token})`;

/**
 * Whether `current`, a row read under its path lock, is still the reservation `snapshot` saw. Both
 * catalogs apply it; the database also compares the token in SQL ({@link reservedAs}).
 */
/** How many rows a rename moved, and how many of them are files. */
export const renameCount = (
  moved: readonly Pick<CatalogFile, 'kind'>[],
): { readonly rows: number; readonly files: number } => ({
  rows: moved.length,
  files: moved.filter((row) => row.kind === 'file').length,
});

export const sameReservation = (current: CatalogFile, snapshot: CatalogFile): boolean =>
  current.status !== 'pending' ||
  snapshot.reservationToken === undefined ||
  current.reservationToken === snapshot.reservationToken;

/**
 * Whether a same-owner re-reserve of `holder` writes anything: the case {@link reservedAgainAt}
 * leaves `updated_at` alone and the declared size and type match is a no-op, so the reserve
 * returns the row it read instead of writing it again. A burst of retries then commits under the
 * path lock without a transaction id or a WAL flush each.
 */
const reservesAgain = (
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
const reservedAgainAt = (input: {
  readonly sizeBytes: number;
  readonly contentType: string | null;
  readonly uploadMode?: UploadMode;
}): SQL => {
  const advanced = sql`greatest(now(), ${files.updatedAt} + interval '1 microsecond')`;
  if (input.uploadMode === 'signed') return advanced;
  return sql`case when ${files.sizeBytes} = ${input.sizeBytes} and ${files.contentType} is not distinct from ${input.contentType}::text then ${files.updatedAt} else ${advanced} end`;
};

const fileColumns = {
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

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * A file or folder implies its parent folders, the rule `pathIsFolder` in
 * `apps/web/server/files/handlers.ts` applies when it reads. Every write that places a row at a
 * path (put, rename, subtree rename) calls this, so a `files('<folder>')` grant resolves without
 * a separate `mkdir` (issue #899). Each parent row takes the owner of the first placed row under
 * it. An existing row at a parent path, folder or file, is never touched.
 */
async function insertParentFolders(
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
async function lockPath(tx: Transaction, workspaceId: string, path: string): Promise<void> {
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
async function lockForWrite(
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
function markRemoved(tx: Transaction, workspaceId: string, path: string) {
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
async function moveHolderAside(
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
const atLogicalPath = <T extends Pick<CatalogFile, 'path' | 'targetPath'>>(row: T) => ({
  ...row,
  path: row.targetPath ?? row.path,
});

const skillColumns = {
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

function toCatalogSkill(row: {
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
function parentPaths(path: string): string[] {
  const segments = path.split('/');
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

export function createDatabaseResourceCatalogRepositoryProvider(
  db: Database,
): ResourceCatalogRepositoryProvider {
  return {
    forScope(scope) {
      const workspaceId = requireWorkspaceScope(
        scope,
        'ResourceCatalogRepositoryProvider',
      ).workspaceId;
      /** Move every live row at or under `oldPrefix` to `newPrefix`, keeping ids; returns the rows moved. */
      const moveUnder = async (oldPrefix: string, newPrefix: string): Promise<CatalogFile[]> => {
        if (isSidePath(newPrefix)) throw new Error(`${newPrefix} is a reserved catalog path.`);
        // The cut point — one past `oldPrefix` itself — is computed by Postgres as
        // `char_length(${oldPrefix}) + 1`, never as JS's `oldPrefix.length + 1`. `substr`
        // counts CHARACTERS; JS `.length` counts UTF-16 code units, which over-counts by one
        // for every character outside the BMP (most emoji) and so cuts at the wrong character
        // boundary for a prefix containing one — the same class of bug `pathUnderPrefix`
        // documents above. See W9-FILES-131's verification-round-2 notes for the reproduction.
        return db.transaction(async (tx) => {
          await lockForWrite(tx, workspaceId, 'exclusive', []);
          // A `deleting` row is out of the tree: its object is removed from its own key.
          const moving = and(
            eq(files.workspaceId, workspaceId),
            ne(files.status, 'deleting'),
            pathUnderPrefix(oldPrefix, logicalPath),
          );
          const moved = await tx
            .select({ id: files.id, path: logicalPath })
            .from(files)
            .where(moving);
          // Both cuts use the JS length of `oldPrefix`, which is a prefix of every path it cuts.
          const destinations = moved.map((row) => renamedKey(row.path, oldPrefix, newPrefix));
          if (destinations.length > 0) {
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
          const rows = await tx
            .update(files)
            .set({
              // `substr(text, int)`, not the two-argument `substring(text FROM ...)` form:
              // that form has a *second* overload — POSIX regexp extraction — and a bound
              // parameter's type is not always pinned to `integer` early enough to rule it out,
              // so `substring(path from $2)` silently became "search `path` for a regex
              // matching `$2`" and returned `NULL` (no match) for every row, which this method's
              // own test caught as a `NOT NULL` violation on `path`. `substr` has only the
              // integer-offset overload, so there is no second meaning to fall into.
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
          // storage-bridge(#1657): a folder move refuses while an upload under it is pending, so
          // its confirm never meets a moved storage key. Checked on the rows the update itself
          // moved, so a reserve committed before its snapshot is caught and the throw rolls it
          // back; one committed after it is untouched and stays at the old path.
          if (rows.some((row) => row.status === 'pending')) {
            throw new CatalogPathPendingError(oldPrefix);
          }
          // The moved rows come back first so the parent rows never shadow `newPrefix` itself.
          await insertParentFolders(tx, workspaceId, rows.map(atLogicalPath));
          return rows;
        });
      };

      const repository: ResourceCatalogRepository = {
        async reserve(path, input) {
          if (isSidePath(path)) throw new Error(`${path} is a reserved catalog path.`);
          return db.transaction(async (tx): Promise<ReserveOutcome> => {
            await lockForWrite(tx, workspaceId, 'shared', [path, ...parentPaths(path)]);
            // The new size and type of a refreshed row. The write moves `updated_at`, the time
            // `stalePending` compares, so a link minted again is not cleaned up as abandoned.
            const refresh = {
              sizeBytes: input.sizeBytes,
              contentType: input.contentType,
              updatedAt: reservedAgainAt(input),
            };
            // A ready or `deleting` row holds the path. A pending one is refreshed for its owner and
            // refused for anyone else (FX-7). A relay save is never refreshed: a second save of the
            // path is refused and must not disturb the one writing.
            const takenOrRefreshed = async (
              holder: CatalogFile,
              replaces: CatalogFile | undefined,
            ): Promise<ReserveOutcome> => {
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
                .set(refresh)
                .where(and(eq(files.workspaceId, workspaceId), eq(files.id, holder.id)))
                .returning(fileColumns);
              if (refreshed === undefined) throw new Error('catalog reserve lost its locked row');
              return { kind: 'taken', row: refreshed, ...withTarget };
            };
            // A pending row at the path itself is always the live holder, so its owner's signed
            // re-mint, which always writes, is this one statement under the path lock instead of a
            // read and a write. Any other re-reserve, every loser of a burst, reads the holders
            // below and writes only when it declares something new. Nothing matched: read them.
            const [refreshedAtPath] =
              input.uploadMode !== 'signed'
                ? []
                : await tx
                    .update(files)
                    .set(refresh)
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
            if (refreshedAtPath !== undefined) return { kind: 'taken', row: refreshedAtPath };
            // The live row at the path and a pending replacement waiting for it, in one read.
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
            const live = holders.find((row) => row.path === path && row.status !== 'deleting');
            const waiting = holders.find(
              (row) => row.status === 'pending' && row.targetPath === path,
            );
            // The ready file a pending replacement takes the path from, read under the path lock.
            const target = live?.status === 'ready' && live.kind === 'file' ? live : undefined;
            const replacing = target !== undefined;
            if (live !== undefined && !replacing) return takenOrRefreshed(live, undefined);
            if (waiting !== undefined) return takenOrRefreshed(waiting, target);
            // The untargeted `onConflictDoNothing` below would swallow this key too and report the
            // path; refuse it here, as the memory catalog does.
            const [sameObject] = await tx
              .select({ id: files.id })
              .from(files)
              .where(and(eq(files.workspaceId, workspaceId), eq(files.objectId, input.objectId)));
            if (sameObject !== undefined) {
              throw new Error(
                'duplicate key value violates unique constraint "files_workspace_object_key"',
              );
            }
            const id = crypto.randomUUID();
            // No conflict target: valid with or without `files_workspace_path_key`. A conflict can
            // only be a legacy `deleting` row still holding the path, or a one-step write racing
            // past the lock.
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
              return target === undefined || !replacing
                ? { kind: 'reserved', row }
                : { kind: 'reserved', row, replaces: target };
            }
            const [holder] = await tx
              .select(fileColumns)
              .from(files)
              .where(and(eq(files.workspaceId, workspaceId), eq(files.path, path)))
              .for('update');
            if (holder === undefined) throw new Error('catalog reserve conflicted with no row');
            return takenOrRefreshed(holder, undefined);
          });
        },
        // @story US-STO-01
        async createFolder(path, input) {
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
        },
        // @story US-STO-14
        async confirm(row, input) {
          if (row.storageKey === null) return null;
          const storageKey = row.storageKey;
          const statuses: readonly FileStatus[] =
            input.expect === 'any' ? ['pending', 'ready'] : ['pending'];
          // One try under the workspace lock (shared) and the lock of the path the row stands for.
          // A `renameFile` holds the workspace lock shared too, so it can move the row between the
          // first read and the path lock: then the try ends and the next one locks the new path.
          const attempt = () =>
            db.transaction(async (tx): Promise<ConfirmOutcome | 'moved' | null> => {
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
              // A `deleting` row is never revived; a ready row is confirmed again only with
              // `expect: 'any'`; a row whose key changed holds other bytes; a pending row reserved
              // again since `row` was read belongs to that newer reservation.
              if (
                again === undefined ||
                again.kind !== 'file' ||
                again.storageKey !== storageKey ||
                !statuses.includes(again.status) ||
                !sameReservation(again, row)
              ) {
                return null;
              }
              if ((again.targetPath ?? again.path) !== path) return 'moved';
              const replaced =
                again.targetPath === null
                  ? undefined
                  : await moveHolderAside(tx, workspaceId, path, again.id);
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
            });
          for (let tries = 0; tries < CONFIRM_TRIES; tries += 1) {
            const outcome = await attempt();
            if (outcome !== 'moved') return outcome;
          }
          // Renamed on every try: swap nothing; the upload can be confirmed again.
          return null;
        },
        async get(path, options) {
          if (isSidePath(path)) return null;
          const rows = await db
            .select(fileColumns)
            .from(files)
            .where(
              and(
                eq(files.workspaceId, workspaceId),
                eq(files.path, path),
                options?.includePending === true
                  ? inArray(files.status, ['pending', 'ready'])
                  : eq(files.status, 'ready'),
              ),
            );
          return rows[0] ?? null;
        },
        async list(folder, page) {
          const limit = clampCatalogPageLimit(page?.limit);
          const cursor = page?.cursor;
          // ponytail: ordering by `collate "C"` bypasses the path index, fine at catalog scale; it
          // makes the cursor agree with the in-memory catalog's code-point order.
          const found = await db
            .select(fileColumns)
            .from(files)
            .where(
              and(
                eq(files.workspaceId, workspaceId),
                eq(files.status, 'ready'),
                folder === '' ? undefined : pathUnderPrefix(folder),
                cursor === undefined ? undefined : sql`${files.path} collate "C" > ${cursor}`,
              ),
            )
            .orderBy(sql`${files.path} collate "C"`)
            .limit(limit + 1);
          const rows = found.slice(0, limit);
          return { rows, cursor: found.length > limit ? (rows.at(-1)?.path ?? null) : null };
        },
        async countPending(newerThan) {
          const rows = await db
            .select({ value: count() })
            .from(files)
            .where(
              and(
                eq(files.workspaceId, workspaceId),
                eq(files.status, 'pending'),
                ne(files.area, 'staging'),
                newerThan === undefined ? undefined : gte(files.updatedAt, newerThan),
              ),
            );
          return rows[0]?.value ?? 0;
        },
        async pending(path) {
          const rows = await db
            .select(fileColumns)
            .from(files)
            .where(
              and(
                eq(files.workspaceId, workspaceId),
                eq(files.status, 'pending'),
                eq(logicalPath, path),
              ),
            )
            .limit(1);
          return rows[0] ?? null;
        },
        async rename(from, to) {
          return renameCount(await moveUnder(from, to));
        },
        // @story US-STO-04
        async remove(path, options) {
          if (isSidePath(path)) return [];
          const snapshot = options?.pending;
          if (snapshot !== undefined) {
            // Claim one reservation for deletion before its bytes go: only while it is still the
            // pending row `snapshot` saw, at `path` (a pending replacement stands for it).
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
          // One file takes the shared workspace lock and its path lock. A folder, or a file with
          // something under it, needs the exclusive lock, which cannot be upgraded to: it gets a
          // second transaction instead. A writer placing anything under `path` locks `path` too.
          const single = await db.transaction(async (tx) => {
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
          if (single !== null) return single;
          return db.transaction(async (tx) => {
            await lockForWrite(tx, workspaceId, 'exclusive', []);
            const marked = await markRemoved(tx, workspaceId, path);
            // `files_folder_is_ready`: a folder is never `deleting`, and holds no object.
            await tx
              .delete(files)
              .where(
                and(
                  eq(files.workspaceId, workspaceId),
                  eq(files.kind, 'folder'),
                  pathUnderPrefix(path),
                ),
              );
            return marked;
          });
        },
        async stalePending(olderThan) {
          return db
            .select(fileColumns)
            .from(files)
            .where(
              and(
                eq(files.workspaceId, workspaceId),
                eq(files.status, 'pending'),
                lt(files.updatedAt, olderThan),
              ),
            )
            .orderBy(asc(files.path));
        },
        async deleting() {
          return db
            .select(fileColumns)
            .from(files)
            .where(and(eq(files.workspaceId, workspaceId), eq(files.status, 'deleting')))
            .orderBy(asc(files.path));
        },
        async forget(row) {
          await db.transaction(async (tx) => {
            // The workspace lock, then the lock of the path the row stands for. A rename may still
            // move the row meanwhile; the delete goes by id, spares a row that became ready and a
            // pending row reserved again since `row` was read.
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
        },
        async referencing({ objectIds }) {
          if (objectIds.length === 0) return [];
          return db
            .select(fileColumns)
            .from(files)
            .where(
              and(
                eq(files.workspaceId, workspaceId),
                eq(files.kind, 'file'),
                inArray(files.objectId, [...objectIds]),
              ),
            )
            .orderBy(asc(files.path));
        },
        async listSkills() {
          const rows = await db
            .select(skillColumns)
            .from(skills)
            .where(eq(skills.workspaceId, workspaceId))
            // Code point order, as the memory catalog sorts, whatever the database's collation.
            .orderBy(sql`${skills.name} collate "C"`);
          return rows.map(toCatalogSkill);
        },
        async getSkill(name) {
          const [row] = await db
            .select(skillColumns)
            .from(skills)
            .where(and(eq(skills.workspaceId, workspaceId), eq(skills.name, name)))
            .limit(1);
          return row === undefined ? null : toCatalogSkill(row);
        },
        async putSkill(input) {
          const rows = await db
            .insert(skills)
            .values({ workspaceId, ...input, createdBy: input.createdBy ?? null })
            .onConflictDoUpdate({
              target: [skills.workspaceId, skills.name],
              // Ownership and compatibility attribution are deliberately absent: a re-upload
              // updates content but never transfers the existing row.
              set: { skillMd: input.skillMd, enabled: input.enabled },
            })
            .returning(skillColumns);
          const row = rows[0];
          if (row === undefined) throw new Error('skill catalog upsert returned no row');
          return toCatalogSkill(row);
        },
        async createSkill(input) {
          const rows = await db
            .insert(skills)
            .values({ workspaceId, ...input, createdBy: input.createdBy ?? null })
            .onConflictDoNothing({ target: [skills.workspaceId, skills.name] })
            .returning(skillColumns);
          const row = rows[0];
          return row === undefined ? null : toCatalogSkill(row);
        },
        async deleteSkill(name, onlyId) {
          return db.transaction(async (tx): Promise<DeleteCatalogSkillOutcome> => {
            const locked = await tx
              .select(skillColumns)
              .from(skills)
              .where(and(eq(skills.workspaceId, workspaceId), eq(skills.name, name)))
              .for('update');
            const found = locked[0];
            if (found === undefined || (onlyId !== undefined && found.id !== onlyId)) {
              return { kind: 'not-found' };
            }
            const skill = toCatalogSkill(found);
            const assignments = await tx
              .select({ agentId: agentSkills.agentId })
              .from(agentSkills)
              .where(
                and(eq(agentSkills.workspaceId, workspaceId), eq(agentSkills.skillId, skill.id)),
              )
              .orderBy(asc(agentSkills.agentId));
            if (assignments.length > 0) {
              return { kind: 'in-use', agentIds: assignments.map((row) => row.agentId) };
            }
            await tx
              .delete(skills)
              .where(and(eq(skills.workspaceId, workspaceId), eq(skills.id, skill.id)));
            return { kind: 'deleted', skill };
          });
        },
        async markSkillDeleting(name) {
          return db.transaction(async (tx): Promise<MarkSkillDeletingOutcome> => {
            const locked = await tx
              .select(skillColumns)
              .from(skills)
              .where(and(eq(skills.workspaceId, workspaceId), eq(skills.name, name)))
              .for('update');
            const found = locked[0];
            if (found === undefined) return { kind: 'not-found' };
            const skill = toCatalogSkill(found);
            const assignments = await tx
              .select({ agentId: agentSkills.agentId })
              .from(agentSkills)
              .where(
                and(eq(agentSkills.workspaceId, workspaceId), eq(agentSkills.skillId, skill.id)),
              )
              .orderBy(asc(agentSkills.agentId));
            const inUse = assignments.length > 0;
            // Pending revisions too: a crashed publish leaves its rows behind.
            const revisions = await tx
              .select({ number: skillRevisions.number })
              .from(skillRevisions)
              .where(
                and(
                  eq(skillRevisions.workspaceId, workspaceId),
                  eq(skillRevisions.skillId, skill.id),
                ),
              );
            const pending = pendingDeleteFor(
              skill,
              revisions.map((row) => row.number),
            );
            // An in-use answer changes nothing: a mark an earlier attempt left must survive it.
            if (inUse) return { kind: 'in-use', agentIds: assignments.map((row) => row.agentId) };
            await tx
              .update(skills)
              .set({ pendingDelete: pending })
              .where(and(eq(skills.workspaceId, workspaceId), eq(skills.id, skill.id)));
            return { kind: 'marked', pending };
          });
        },
        async backfillSkillPendingDelete(name, pending) {
          return db.transaction(async (tx) => {
            const [found] = await tx
              .select(skillColumns)
              .from(skills)
              .where(and(eq(skills.workspaceId, workspaceId), eq(skills.name, name)))
              .for('update');
            if (found === undefined) return false;
            if (found.pendingDelete !== null) return true;
            const [assigned] = await tx
              .select({ agentId: agentSkills.agentId })
              .from(agentSkills)
              .where(
                and(eq(agentSkills.workspaceId, workspaceId), eq(agentSkills.skillId, found.id)),
              )
              .limit(1);
            if (assigned !== undefined) return false;
            await tx
              .update(skills)
              .set({ pendingDelete: pending })
              .where(and(eq(skills.workspaceId, workspaceId), eq(skills.id, found.id)));
            return true;
          });
        },
        async setSkillMeta(name, meta, onlyIfEmpty = false) {
          const rows = await db
            .update(skills)
            .set({ meta })
            .where(
              and(
                eq(skills.workspaceId, workspaceId),
                eq(skills.name, name),
                onlyIfEmpty ? isNull(skills.meta) : undefined,
              ),
            )
            .returning({ id: skills.id });
          if (rows.length > 0) return true;
          // Nothing updated: no such row, or (onlyIfEmpty) one that already has its record.
          const [row] = await db
            .select({ id: skills.id })
            .from(skills)
            .where(and(eq(skills.workspaceId, workspaceId), eq(skills.name, name)));
          return row !== undefined && onlyIfEmpty;
        },
        async setSkillBuiltinDigest(name, digest) {
          await db
            .update(skills)
            .set({ builtinDigest: digest })
            .where(and(eq(skills.workspaceId, workspaceId), eq(skills.name, name)));
        },
        async publishSkillRevision(name, input) {
          const lockSkill = (tx: Transaction) =>
            tx
              .select({ id: skills.id })
              .from(skills)
              .where(
                and(
                  eq(skills.workspaceId, workspaceId),
                  eq(skills.name, name),
                  isNull(skills.pendingDelete),
                ),
              )
              .for('update');
          const allocated = await db.transaction(async (tx) => {
            const skill = (await lockSkill(tx))[0];
            if (skill === undefined) return null;
            const ofSkill = and(
              eq(skillRevisions.workspaceId, workspaceId),
              eq(skillRevisions.skillId, skill.id),
            );
            // Numbered before stale rows go, so an abandoned number is never handed out again.
            const [latest] = await tx
              .select({ number: sql<number>`coalesce(max(${skillRevisions.number}), 0)::int` })
              .from(skillRevisions)
              .where(ofSkill);
            const abandoned = await tx
              .delete(skillRevisions)
              .where(
                and(
                  ofSkill,
                  eq(skillRevisions.pending, true),
                  lt(
                    skillRevisions.createdAt,
                    sql`now() - make_interval(secs => ${STALE_SKILL_REVISION_MS / 1000})`,
                  ),
                ),
              )
              .returning({ number: skillRevisions.number });
            const number = (latest?.number ?? 0) + 1;
            const [inserted] = await tx
              .insert(skillRevisions)
              .values({
                workspaceId,
                skillId: skill.id,
                number,
                fileCount: input.fileCount,
                pending: true,
              })
              .returning({ id: skillRevisions.id });
            if (inserted === undefined) throw new Error('skill revision insert returned no row');
            return {
              id: inserted.id,
              skillId: skill.id,
              number,
              abandoned: abandoned.map((row) => row.number),
            };
          });
          if (allocated === null) return null;
          const { skillId, number } = allocated;
          // Keyed on the row's id: once abandoned as stale, this row is gone for good.
          const thisRevision = and(
            eq(skillRevisions.workspaceId, workspaceId),
            eq(skillRevisions.id, allocated.id),
            eq(skillRevisions.pending, true),
          );
          // Earlier publishes write first; each check is one query, so no connection is held between.
          for (;;) {
            const [earlier] = await db
              .select({ number: skillRevisions.number })
              .from(skillRevisions)
              .where(
                and(
                  eq(skillRevisions.workspaceId, workspaceId),
                  eq(skillRevisions.skillId, skillId),
                  eq(skillRevisions.pending, true),
                  lt(skillRevisions.number, number),
                  gt(
                    skillRevisions.createdAt,
                    sql`now() - make_interval(secs => ${STALE_SKILL_REVISION_MS / 1000})`,
                  ),
                ),
              )
              .limit(1);
            if (earlier === undefined) break;
            await sleep(SKILL_PUBLISH_POLL_MS);
          }
          // No transaction is open here: the write takes its own connections from the pool.
          let content;
          try {
            content = await input.write(number, allocated.abandoned);
          } catch (error) {
            await db.delete(skillRevisions).where(thisRevision);
            throw error;
          }
          return db.transaction(async (tx) => {
            const skill = (await lockSkill(tx))[0];
            if (skill?.id !== skillId) return null;
            const [row] = await tx
              .update(skillRevisions)
              .set({ pending: false })
              .where(thisRevision)
              .returning({
                number: skillRevisions.number,
                fileCount: skillRevisions.fileCount,
                publishedAt: skillRevisions.createdAt,
              });
            if (row === undefined) return null;
            const [newer] = await tx
              .select({ number: skillRevisions.number })
              .from(skillRevisions)
              .where(
                and(
                  eq(skillRevisions.workspaceId, workspaceId),
                  eq(skillRevisions.skillId, skillId),
                  eq(skillRevisions.pending, false),
                  gt(skillRevisions.number, number),
                ),
              )
              .limit(1);
            if (content !== undefined && newer === undefined) {
              await tx
                .update(skills)
                .set({ skillMd: content.skillMd, enabled: content.enabled })
                .where(and(eq(skills.workspaceId, workspaceId), eq(skills.id, skillId)));
            }
            return row;
          });
        },
        async listSkillRevisions(name, options) {
          return db
            .select({
              number: skillRevisions.number,
              fileCount: skillRevisions.fileCount,
              publishedAt: skillRevisions.createdAt,
            })
            .from(skillRevisions)
            .innerJoin(
              skills,
              and(
                eq(skills.id, skillRevisions.skillId),
                eq(skills.workspaceId, skillRevisions.workspaceId),
              ),
            )
            .where(
              and(
                eq(skillRevisions.workspaceId, workspaceId),
                eq(skills.name, name),
                options?.includePending === true ? undefined : eq(skillRevisions.pending, false),
              ),
            )
            .orderBy(desc(skillRevisions.number));
        },
      };
      return repository;
    },
  };
}
