import type { FileKind, FileStatus, UploadMode } from '../schema/files.js';
import type { StorageArea } from '../../storage/storage-areas.js';

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
export type SkillInput = Omit<
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
 * Where a rename of `from` to `to` moves `key`, a path or a legacy storage key at or under `from`.
 * The JS cut is safe: `from` is a prefix of `key`. The database update applies the same rule in SQL.
 */
export function renamedKey(key: string, from: string, to: string): string {
  return `${to}${key.slice(from.length)}`;
}

/** Clamp a requested page size to 1..{@link CATALOG_PAGE_MAX}; absent or not finite means the max. */
export function clampCatalogPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CATALOG_PAGE_MAX;
  return Math.min(Math.max(Math.trunc(limit), 1), CATALOG_PAGE_MAX);
}

/** How many rows a rename moved, and how many of them are files. */
export const renameCount = (
  moved: readonly Pick<CatalogFile, 'kind'>[],
): { readonly rows: number; readonly files: number } => ({
  rows: moved.length,
  files: moved.filter((row) => row.kind === 'file').length,
});

/**
 * Whether `current`, a row read under its path lock, is still the reservation `snapshot` saw. Both
 * catalogs apply it; the database also compares the token in SQL (`reservedAs`).
 */
export const sameReservation = (current: CatalogFile, snapshot: CatalogFile): boolean =>
  current.status !== 'pending' ||
  snapshot.reservationToken === undefined ||
  current.reservationToken === snapshot.reservationToken;
