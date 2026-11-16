import type { UploadMode } from '../schema/files.js';
import type { StorageArea } from '../../storage/storage-areas.js';
import type { WorkspaceScope } from './scope.js';
import type {
  CatalogFile,
  CatalogSkill,
  CatalogSkillRevision,
  ConfirmOutcome,
  DeleteCatalogSkillOutcome,
  MarkSkillDeletingOutcome,
  PendingSkillDelete,
  ReserveOutcome,
  SkillInput,
} from './resource-catalogs-model.js';

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
   * owner throws `CatalogPathPendingError`. `storageKey` is `<area>/<objectId>`.
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
       * any other caller of its owner gets `CatalogPathPendingError`, so one kind of upload
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
   * `storageKey` and `objectId`: only the path changes. Throws `CatalogPathPendingError`,
   * moving nothing, while a row in the subtree is pending (a pending replacement included), and
   * `CatalogPathTakenError`, moving nothing, when a destination is held by a row outside the
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
   * `STALE_SKILL_REVISION_MS` is a crashed publish: the next allocation removes it and passes
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
