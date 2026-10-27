import { setTimeout as sleep } from 'node:timers/promises';

import { fileStatuses, type FileStatus } from '../schema/files.js';
import { isSidePath, sidePath } from '../side-paths.js';
import { storageAreas } from '../../storage/storage-areas.js';
import {
  CatalogPathPendingError,
  CatalogPathTakenError,
  clampCatalogPageLimit,
  pendingDeleteFor,
  renamedKey,
  type ConfirmOutcome,
  type ReserveOutcome,
  type CatalogFile,
  type CatalogPort,
  type CatalogSkill,
  type CatalogSkillRevision,
  type DeleteCatalogSkillOutcome,
  type MarkSkillDeletingOutcome,
  SKILL_PUBLISH_POLL_MS,
  STALE_SKILL_REVISION_MS,
  type ResourceCatalogRepository,
  type ResourceCatalogRepositoryProvider,
} from './resource-catalogs.js';
import { requireWorkspaceScope } from './scope.js';

type Row = CatalogFile & { readonly status: FileStatus };

// What a new row holds until writers record an object id and a checksum (the storage design, §04).
const LEGACY = { objectId: null, area: 'files', sha256: null, targetPath: null } as const;

// Mirrors `files_sha256_shape`.
const SHA256_SHAPE = /^[0-9a-f]{64}$/;

const underPrefix = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

// The path a row stands for: its own, or the one a side-path row waits to take.
const logical = (row: CatalogFile): string => row.targetPath ?? row.path;

// Code-point order, which is PostgreSQL's `collate "C"` (UTF-8 byte) order; `<` on strings compares
// UTF-16 code units and puts astral characters before U+E000–U+FFFF.
const comparePaths = (a: string, b: string): number => {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
};

const byPath = (a: Row, b: Row) => comparePaths(a.path, b.path);

/** The error PostgreSQL's driver raises for a CHECK violation: `cause` carries code and constraint. */
const checkViolation = (constraint: string): Error => {
  const message = `new row for relation "files" violates check constraint "${constraint}"`;
  return new Error(message, {
    cause: Object.assign(new Error(message), { code: '23514', constraint }),
  });
};

/** The `files` table's CHECKs (`schema/files.ts`), so a row the database refuses is refused here. */
const assertRowShape = (row: Row): void => {
  const folder = row.kind === 'folder';
  const violated: Record<string, boolean> = {
    files_folder_is_ready: folder && row.status !== 'ready',
    files_path_shape: !/^[^/\p{Cc}]+(\/[^/\p{Cc}]+)*$/u.test(row.path),
    files_path_no_dot_segments: /(^|\/)\.\.?(\/|$)/.test(row.path),
    files_storage_key_iff_file: !folder !== (row.storageKey !== null),
    // `btrim` strips spaces only.
    files_storage_key_not_blank: row.storageKey?.replaceAll(' ', '') === '',
    files_size_non_negative: row.sizeBytes < 0,
    files_folder_has_no_content: folder && (row.sizeBytes !== 0 || row.contentType !== null),
    files_status_valid: !fileStatuses.includes(row.status),
    files_area_valid: row.area !== undefined && !storageAreas.includes(row.area),
    files_sha256_shape: typeof row.sha256 === 'string' && !/^[0-9a-f]{64}$/.test(row.sha256),
    files_side_path_target:
      (logical(row) !== row.path) !== isSidePath(row.path) ||
      (logical(row) !== row.path && row.status === 'ready'),
  };
  const constraint = Object.keys(violated).find((name) => violated[name]);
  if (constraint !== undefined) throw checkViolation(constraint);
};

const later = <T>(fn: () => T): Promise<T> => Promise.resolve().then(fn);

const byName = (a: CatalogSkill, b: CatalogSkill) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

interface SkillState {
  readonly skills: Map<string, CatalogSkill>;
  /** Newest first, keyed by skill id, so a deleted and recreated skill restarts at 1. */
  readonly revisions: Map<string, StoredRevision[]>;
  readonly assignments: Map<string, Set<string>>;
}

interface StoredRevision extends CatalogSkillRevision {
  readonly id: string;
  readonly pending: boolean;
}

const served = (r: StoredRevision): CatalogSkillRevision => ({
  number: r.number,
  fileCount: r.fileCount,
  publishedAt: r.publishedAt,
});

/** A workspace catalog plus the test hook that stands in for an agent version assigning a skill. */
export type InMemoryWorkspaceCatalog = ResourceCatalogRepository & {
  /** Test hook, not part of the port: record that `agentId` uses the skill, as `agent_skills` does. */
  assignSkill(name: string, agentId: string): void;
  /**
   * Test hook: assign as an agent write does, which refuses (`false`, nothing assigned) a skill
   * whose delete is pending.
   */
  tryAssignSkill(name: string, agentId: string): boolean;
  /** Test hook, not part of the port: date the skill's pending revisions past the stale window. */
  ageSkillRevisions(name: string): void;
  /**
   * Test hook, not part of the port: put a file row in any state, the way a raw insert does in
   * PostgreSQL. It enforces the same unique keys and throws on a duplicate.
   */
  seed(input: {
    readonly path: string;
    readonly status: FileStatus;
    readonly ownerPrincipalId: string;
    readonly objectId?: string;
  }): void;
};

/**
 * The catalog held in memory, one map of rows per workspace. It follows the same rules as the
 * PostgreSQL catalog (pending and ready states, one row per path, parent folders, the `docs` /
 * `docs2` prefix boundary, an owner that an upsert never transfers; skills and their numbered
 * revisions) and runs the same `describeCatalogConformance` and `describeSkillCatalogConformance`
 * suites, so a test that uses it cannot pass where the database fails.
 */
export function createInMemoryCatalog(): ResourceCatalogRepositoryProvider & {
  forWorkspace(id: string): InMemoryWorkspaceCatalog;
  /** Test hook, not part of the port: the next call of `op` (any workspace) rejects with `error`. */
  failNext(op: keyof CatalogPort, error: Error): void;
} {
  const workspaces = new Map<string, Map<string, Row>>();
  const skillStates = new Map<string, SkillState>();
  const failures = new Map<keyof CatalogPort, Error>();
  // When each row was reserved, for `stalePending`; the database keeps it in `updated_at`. Shared by
  // every handle, as the rows are: row ids are UUIDs, so one map serves every workspace.
  const reservedAt = new Map<string, Date>();

  const forWorkspace = (workspaceId: string): InMemoryWorkspaceCatalog => {
    const rows = workspaces.get(workspaceId) ?? new Map<string, Row>();
    workspaces.set(workspaceId, rows);
    const state: SkillState = skillStates.get(workspaceId) ?? {
      skills: new Map<string, CatalogSkill>(),
      revisions: new Map<string, StoredRevision[]>(),
      assignments: new Map<string, Set<string>>(),
    };
    skillStates.set(workspaceId, state);

    const under = (prefix: string) =>
      [...rows.values()].filter((r) => underPrefix(logical(r), prefix));

    const ensureParents = (placed: readonly Row[]) => {
      for (const row of placed) {
        const segments = logical(row).split('/');
        for (let end = 1; end < segments.length; end += 1) {
          const path = segments.slice(0, end).join('/');
          if (rows.has(path)) continue;
          rows.set(path, {
            id: crypto.randomUUID(),
            path,
            kind: 'folder',
            storageKey: null,
            sizeBytes: 0,
            contentType: null,
            status: 'ready',
            ...LEGACY,
            createdBy: row.createdBy,
            ownerPrincipalId: row.ownerPrincipalId,
          });
        }
      }
    };

    const renameByPrefix = (oldPrefix: string, newPrefix: string): Row[] => {
      if (isSidePath(newPrefix)) throw new Error(`${newPrefix} is a reserved catalog path.`);
      // A `deleting` row is out of the tree: its object is removed from its own key.
      const moving = under(oldPrefix)
        .filter((row) => row.status !== 'deleting')
        .sort(byPath);
      const destination = (row: Row) => renamedKey(logical(row), oldPrefix, newPrefix);
      const movingIds = new Set(moving.map((row) => row.id));
      const destinations = new Set(moving.map(destination));
      const clash = [...rows.values()].find(
        (row) =>
          row.status !== 'deleting' && !movingIds.has(row.id) && destinations.has(logical(row)),
      );
      if (clash !== undefined) throw new CatalogPathTakenError(logical(clash));
      // storage-bridge(#1657): a folder move refuses while an upload under it is pending.
      if (moving.some((row) => row.status === 'pending')) {
        throw new CatalogPathPendingError(oldPrefix);
      }
      const moved = moving.map((row) => ({
        ...row,
        path: destination(row),
        // A row with an object id has a permanent key; only a legacy row's key is its path.
        storageKey:
          row.kind === 'file' && row.storageKey !== null && row.objectId === null
            ? renamedKey(row.storageKey, oldPrefix, newPrefix)
            : row.storageKey,
      }));
      moved.forEach(assertRowShape);
      for (const row of moving) rows.delete(row.path);
      // A legacy `deleting` row still holding a real path meets `files_workspace_path_key`.
      const duplicate = moved.find((row) => rows.has(row.path));
      if (duplicate !== undefined) {
        for (const row of moving) rows.set(row.path, row);
        throw new Error(`duplicate key value violates unique constraint: ${duplicate.path}`);
      }
      for (const row of moved) rows.set(row.path, row);
      ensureParents(moved);
      return moved;
    };

    const deleteByPrefix = (prefix: string): number => {
      // A `deleting` row stays until `forget`: its object is still to be removed.
      const doomed = under(prefix).filter((row) => row.status !== 'deleting');
      for (const row of doomed) rows.delete(row.path);
      return doomed.length;
    };

    // A folder cannot be `deleting` (`files_folder_is_ready`) and holds no object, so it is dropped.
    // A file moves to its side path at once, which frees the path to reserve again.
    const markDeleting = (prefix: string): Row[] => {
      const marked: Row[] = [];
      for (const row of under(prefix)) {
        if (row.kind === 'folder') rows.delete(row.path);
        else if (row.status !== 'deleting') {
          const deleting: Row = {
            ...row,
            status: 'deleting',
            path: sidePath(row.id),
            targetPath: logical(row),
          };
          rows.delete(row.path);
          rows.set(deleting.path, deleting);
          marked.push(deleting);
        }
      }
      return marked.sort(byPath);
    };

    const port = <T>(op: keyof CatalogPort, fn: () => T): Promise<T> => {
      const injected = failures.get(op);
      if (injected === undefined) return later(fn);
      failures.delete(op);
      return Promise.reject(injected);
    };

    return {
      // @story US-STO-02
      reserve: (path, input) =>
        port('reserve', () => {
          if (isSidePath(path)) throw new Error(`${path} is a reserved catalog path.`);
          // A ready or `deleting` row holds the path. A pending one, at the path or waiting to
          // replace it, is refreshed for its owner and refused for anyone else (FX-7).
          const takenOrRefreshed = (holder: Row): ReserveOutcome => {
            if (holder.status !== 'pending') return { kind: 'taken', row: holder };
            if (
              holder.ownerPrincipalId !== input.ownerPrincipalId ||
              (holder.uploadMode ?? null) !== (input.uploadMode ?? null)
            ) {
              throw new CatalogPathPendingError(path);
            }
            const refreshed: Row = {
              ...holder,
              sizeBytes: input.sizeBytes,
              contentType: input.contentType,
            };
            assertRowShape(refreshed);
            rows.set(refreshed.path, refreshed);
            reservedAt.set(refreshed.id, new Date());
            return { kind: 'taken', row: refreshed };
          };
          const holder = rows.get(path);
          const replacing =
            input.objectId !== undefined && holder?.status === 'ready' && holder.kind === 'file';
          if (holder !== undefined && !replacing) return takenOrRefreshed(holder);
          const waiting = [...rows.values()].find(
            (r) => r.status === 'pending' && r.targetPath === path,
          );
          if (waiting !== undefined) return takenOrRefreshed(waiting);
          if (
            input.objectId !== undefined &&
            [...rows.values()].some((r) => r.objectId === input.objectId)
          ) {
            throw new Error(
              'duplicate key value violates unique constraint "files_workspace_object_key"',
            );
          }
          const id = crypto.randomUUID();
          const row: Row = {
            id,
            path: replacing ? sidePath(id) : path,
            kind: 'file',
            storageKey:
              input.objectId === undefined ? path : `${input.area ?? 'files'}/${input.objectId}`,
            sizeBytes: input.sizeBytes,
            contentType: input.contentType,
            status: 'pending',
            ...LEGACY,
            objectId: input.objectId ?? null,
            area: input.area ?? 'files',
            targetPath: replacing ? path : null,
            uploadMode: input.uploadMode ?? null,
            createdBy: input.createdBy ?? null,
            ownerPrincipalId: input.ownerPrincipalId,
          };
          assertRowShape(row);
          rows.set(row.path, row);
          reservedAt.set(row.id, new Date());
          ensureParents([row]);
          return { kind: 'reserved', row };
        }),
      // @story US-STO-01
      createFolder: (path, input) =>
        port('createFolder', () => {
          if (isSidePath(path)) throw new Error(`${path} is a reserved catalog path.`);
          const held = rows.get(path);
          if (held !== undefined) return { kind: 'taken', row: held };
          const row: Row = {
            id: crypto.randomUUID(),
            path,
            kind: 'folder',
            storageKey: null,
            sizeBytes: 0,
            contentType: null,
            status: 'ready',
            ...LEGACY,
            createdBy: input.createdBy ?? null,
            ownerPrincipalId: input.ownerPrincipalId,
          };
          assertRowShape(row);
          ensureParents([row]);
          rows.set(path, row);
          return { kind: 'created', row };
        }),
      // @story US-STO-14
      confirm: (row, input) =>
        port('confirm', (): ConfirmOutcome | null => {
          const current = [...rows.values()].find((r) => r.id === row.id);
          // A removed (`deleting`) row is never revived. Only a pending row whose storage key is
          // unchanged is confirmed, unless `expect: 'any'` re-confirms a ready row (FX-7).
          if (
            current === undefined ||
            current.kind !== 'file' ||
            current.status === 'deleting' ||
            current.storageKey === null ||
            current.storageKey !== row.storageKey ||
            (current.status !== 'pending' && input.expect !== 'any')
          ) {
            return null;
          }
          const sha256 = input.sha256 ?? null;
          if (sha256 !== null && !SHA256_SHAPE.test(sha256)) {
            throw new Error('violates check constraint "files_sha256_shape"');
          }
          const path = logical(current);
          let replaced: Row | undefined;
          if (current.targetPath !== null) {
            const holder = rows.get(path);
            if (holder !== undefined && holder.id !== current.id && holder.kind === 'file') {
              replaced = {
                ...holder,
                status: 'deleting',
                path: sidePath(holder.id),
                targetPath: path,
              };
              rows.delete(holder.path);
              rows.set(replaced.path, replaced);
            }
            rows.delete(current.path);
          }
          const ready: Row = {
            ...current,
            status: 'ready',
            path,
            targetPath: null,
            sizeBytes: input.sizeBytes,
            contentType: input.contentType,
            sha256,
          };
          assertRowShape(ready);
          rows.set(ready.path, ready);
          return replaced === undefined ? { row: ready } : { row: ready, replaced };
        }),
      get: (path, options) =>
        port('get', () => {
          const row = isSidePath(path) ? undefined : rows.get(path);
          return row !== undefined &&
            (row.status === 'ready' ||
              (row.status === 'pending' && options?.includePending === true))
            ? row
            : null;
        }),
      list: (folder, page) =>
        port('list', () => {
          const limit = clampCatalogPageLimit(page?.limit);
          const cursor = page?.cursor;
          const found = [...rows.values()]
            .filter(
              (r) =>
                r.status === 'ready' &&
                (folder === '' || underPrefix(r.path, folder)) &&
                (cursor === undefined || comparePaths(r.path, cursor) > 0),
            )
            .sort(byPath)
            .slice(0, limit + 1);
          const pageRows = found.slice(0, limit);
          return {
            rows: pageRows,
            cursor: found.length > limit ? (pageRows.at(-1)?.path ?? null) : null,
          };
        }),
      countPending: () =>
        port(
          'countPending',
          () =>
            [...rows.values()].filter((r) => r.status === 'pending' && r.area !== 'staging').length,
        ),
      pending: (path) =>
        port(
          'pending',
          () =>
            [...rows.values()].find((r) => r.status === 'pending' && logical(r) === path) ?? null,
        ),
      rename: (from, to) => port('rename', () => renameByPrefix(from, to).length),
      // @story US-STO-04
      remove: (path) => port('remove', () => markDeleting(path)),
      stalePending: (olderThan) =>
        port('stalePending', () =>
          [...rows.values()]
            .filter(
              (r) =>
                r.status === 'pending' &&
                (reservedAt.get(r.id)?.getTime() ?? 0) < olderThan.getTime(),
            )
            .sort(byPath),
        ),
      deleting: () =>
        port('deleting', () =>
          [...rows.values()].filter((r) => r.status === 'deleting').sort(byPath),
        ),
      forget: (row) =>
        port('forget', () => {
          const current = [...rows.values()].find((r) => r.id === row.id);
          if (current === undefined || current.status === 'ready') return;
          rows.delete(current.path);
          reservedAt.delete(current.id);
        }),
      referencing: ({ objectIds, storageKeys }) =>
        port('referencing', () =>
          [...rows.values()]
            .filter(
              (r) =>
                r.kind === 'file' &&
                (r.objectId === undefined || r.objectId === null
                  ? r.storageKey !== null && storageKeys.includes(r.storageKey)
                  : objectIds.includes(r.objectId)),
            )
            .sort(byPath),
        ),

      // storage-bridge(#1699): one-step catalog writes until every caller uses the service
      listFiles: () =>
        later(() => [...rows.values()].filter((r) => r.status === 'ready').sort(byPath)),
      putFile: (input) =>
        later(() => {
          const existing = rows.get(input.path);
          if (existing?.status === 'pending') throw new CatalogPathPendingError(input.path);
          const row: Row = {
            ...input,
            id: existing?.id ?? crypto.randomUUID(),
            status: 'ready',
            objectId: existing?.objectId ?? LEGACY.objectId,
            area: existing?.area ?? LEGACY.area,
            sha256: existing?.sha256 ?? LEGACY.sha256,
            targetPath: null,
            // An existing row keeps its attribution, a null one included, as PostgreSQL's upsert does.
            createdBy: existing === undefined ? (input.createdBy ?? null) : existing.createdBy,
            ownerPrincipalId: existing?.ownerPrincipalId ?? input.ownerPrincipalId,
          };
          assertRowShape(row);
          ensureParents([row]);
          rows.set(row.path, row);
          return row;
        }),
      renameFile: (path, input) =>
        later(() => {
          if (isSidePath(input.path)) throw new Error(`${input.path} is a reserved catalog path.`);
          const row = rows.get(path);
          if (row === undefined || row.status !== 'ready') return null;
          if (input.path !== path) {
            const held = [...rows.values()].some(
              (r) => r.status !== 'deleting' && logical(r) === input.path,
            );
            if (held) throw new CatalogPathTakenError(input.path);
          }
          const moved: Row = { ...row, ...input };
          assertRowShape(moved);
          rows.delete(path);
          rows.set(moved.path, moved);
          if (input.path !== path) {
            // The upload that was going to replace this file follows it.
            for (const r of rows.values()) {
              if (r.status === 'pending' && r.targetPath === path) {
                rows.set(r.path, { ...r, targetPath: input.path });
              }
            }
          }
          ensureParents([moved]);
          return moved;
        }),
      deleteFile: (path) =>
        later(() => {
          for (const r of [...rows.values()]) {
            if (r.status !== 'deleting' && logical(r) === path) rows.delete(r.path);
          }
        }),
      // storage-bridge(#1699): old object naming
      adoptLegacyFiles: (objects, ownerPrincipalId) =>
        later(() => {
          const keys = new Set(
            [...rows.values()]
              .filter((row) => (row.area ?? 'files') === 'files')
              .map((row) => row.storageKey),
          );
          const adopted: Row[] = [];
          let hadRow = 0;
          let pathTaken = 0;
          for (const object of objects) {
            if (isSidePath(object.storageKey)) pathTaken += 1;
            else if (keys.has(object.storageKey)) hadRow += 1;
            else if (rows.has(object.storageKey)) pathTaken += 1;
            else {
              const row: Row = {
                id: crypto.randomUUID(),
                path: object.storageKey,
                kind: 'file',
                storageKey: object.storageKey,
                sizeBytes: object.sizeBytes,
                contentType: object.contentType,
                status: 'ready',
                ...LEGACY,
                createdBy: null,
                ownerPrincipalId,
              };
              assertRowShape(row);
              rows.set(row.path, row);
              keys.add(object.storageKey);
              adopted.push(row);
            }
          }
          ensureParents(adopted);
          return { adopted: adopted.length, hadRow, pathTaken };
        }),
      // storage-bridge(#1699): moves a legacy row to the new naming
      switchObject: (rowId, expectedStorageKey, objectId, sha256) =>
        later(() => {
          const current = [...rows.values()].find((r) => r.id === rowId);
          if (
            current === undefined ||
            current.kind !== 'file' ||
            current.status !== 'ready' ||
            (current.objectId ?? null) !== null ||
            current.storageKey !== expectedStorageKey
          ) {
            return false;
          }
          rows.set(current.path, { ...current, objectId, sha256 });
          return true;
        }),
      countLegacyFiles: () =>
        later(
          () =>
            [...rows.values()].filter((r) => r.kind === 'file' && (r.objectId ?? null) === null)
              .length,
        ),
      holdersOfKeys: (area, keys) =>
        later(() =>
          [...rows.values()]
            .filter(
              (r) =>
                r.kind === 'file' &&
                (r.area ?? 'files') === area &&
                ((r.storageKey !== null && keys.includes(r.storageKey)) ||
                  (area === 'files' && keys.includes(r.path))),
            )
            .sort(byPath),
        ),
      renameFilesByPrefix: (oldPrefix, newPrefix) =>
        later(() => renameByPrefix(oldPrefix, newPrefix)),
      deleteFilesByPrefix: (prefix) =>
        later(() => {
          deleteByPrefix(prefix);
        }),

      // @story US-STO-08
      listSkills: () => later(() => [...state.skills.values()].sort(byName)),
      getSkill: (name) => later(() => state.skills.get(name) ?? null),
      putSkill: (input) =>
        later(() => {
          const existing = state.skills.get(input.name);
          const skill: CatalogSkill = {
            id: existing?.id ?? crypto.randomUUID(),
            name: input.name,
            skillMd: input.skillMd,
            enabled: input.enabled,
            createdBy: existing === undefined ? (input.createdBy ?? null) : existing.createdBy,
            ownerPrincipalId: existing?.ownerPrincipalId ?? input.ownerPrincipalId,
            pendingDelete: existing?.pendingDelete ?? null,
            builtinDigest: existing?.builtinDigest ?? null,
            meta: existing?.meta ?? null,
          };
          state.skills.set(skill.name, skill);
          return skill;
        }),
      createSkill: (input) =>
        later(() => {
          if (state.skills.has(input.name)) return null;
          const skill: CatalogSkill = {
            id: crypto.randomUUID(),
            name: input.name,
            skillMd: input.skillMd,
            enabled: input.enabled,
            createdBy: input.createdBy ?? null,
            ownerPrincipalId: input.ownerPrincipalId,
            pendingDelete: null,
            builtinDigest: null,
            meta: null,
          };
          state.skills.set(skill.name, skill);
          return skill;
        }),
      deleteSkill: (name, onlyId) =>
        later((): DeleteCatalogSkillOutcome => {
          const skill = state.skills.get(name);
          if (skill === undefined || (onlyId !== undefined && skill.id !== onlyId)) {
            return { kind: 'not-found' };
          }
          const agents = state.assignments.get(skill.id);
          if (agents !== undefined && agents.size > 0) {
            return { kind: 'in-use', agentIds: [...agents].sort() };
          }
          state.skills.delete(name);
          state.revisions.delete(skill.id);
          state.assignments.delete(skill.id);
          return { kind: 'deleted', skill };
        }),
      markSkillDeleting: (name) =>
        later((): MarkSkillDeletingOutcome => {
          const skill = state.skills.get(name);
          if (skill === undefined) return { kind: 'not-found' };
          const agents = state.assignments.get(skill.id);
          if (agents !== undefined && agents.size > 0) {
            return { kind: 'in-use', agentIds: [...agents].sort() };
          }
          const numbers = (state.revisions.get(skill.id) ?? []).map((r) => r.number);
          const pending = pendingDeleteFor(skill, numbers);
          state.skills.set(name, { ...skill, pendingDelete: pending });
          return { kind: 'marked', pending };
        }),
      backfillSkillPendingDelete: (name, pending) =>
        later(() => {
          const skill = state.skills.get(name);
          if (skill === undefined) return false;
          if (skill.pendingDelete !== null) return true;
          if ((state.assignments.get(skill.id)?.size ?? 0) > 0) return false;
          state.skills.set(name, { ...skill, pendingDelete: pending });
          return true;
        }),
      setSkillMeta: (name, meta, onlyIfEmpty = false) =>
        later(() => {
          const skill = state.skills.get(name);
          if (skill === undefined) return false;
          if (!onlyIfEmpty || skill.meta === null) state.skills.set(name, { ...skill, meta });
          return true;
        }),
      setSkillBuiltinDigest: (name, digest) =>
        later(() => {
          const skill = state.skills.get(name);
          if (skill !== undefined) state.skills.set(name, { ...skill, builtinDigest: digest });
        }),
      publishSkillRevision: async (name, input) => {
        // Allocated in one synchronous step, as the database does under the skill row's lock.
        const skill = await later(() => state.skills.get(name));
        if (skill === undefined || skill.pendingDelete !== null) return null;
        const staleBefore = Date.now() - STALE_SKILL_REVISION_MS;
        const all = state.revisions.get(skill.id) ?? [];
        const stale = (r: StoredRevision) => r.pending && r.publishedAt.getTime() < staleBefore;
        const abandoned = all.filter(stale).map((r) => r.number);
        const kept = all.filter((r) => !stale(r));
        // Numbered before stale rows go, so an abandoned number is never handed out again.
        const number = Math.max(0, ...all.map((r) => r.number)) + 1;
        const allocated: StoredRevision = {
          id: crypto.randomUUID(),
          number,
          fileCount: input.fileCount,
          publishedAt: new Date(),
          pending: true,
        };
        state.revisions.set(skill.id, [allocated, ...kept]);
        const waiting = () =>
          (state.revisions.get(skill.id) ?? []).some(
            (r) => r.pending && r.number < number && r.publishedAt.getTime() >= staleBefore,
          );
        while (waiting()) await sleep(SKILL_PUBLISH_POLL_MS);
        // Keyed on the row's id, as the database does: once abandoned as stale, it is gone for good.
        const mine = (r: StoredRevision) => r.id === allocated.id && r.pending;
        let content;
        try {
          content = await input.write(number, abandoned);
        } catch (error) {
          state.revisions.set(
            skill.id,
            (state.revisions.get(skill.id) ?? []).filter((r) => !mine(r)),
          );
          throw error;
        }
        const current = state.skills.get(name);
        const revisions = state.revisions.get(skill.id) ?? [];
        if (current?.id !== skill.id || current.pendingDelete !== null || !revisions.some(mine)) {
          return null;
        }
        const done: StoredRevision = { ...allocated, pending: false };
        state.revisions.set(
          skill.id,
          revisions.map((r) => (mine(r) ? done : r)),
        );
        const newer = revisions.some((r) => !r.pending && r.number > number);
        if (content !== undefined && !newer) state.skills.set(name, { ...current, ...content });
        return served(done);
      },
      listSkillRevisions: (name, options) =>
        later(() => {
          const skill = state.skills.get(name);
          return skill === undefined
            ? []
            : (state.revisions.get(skill.id) ?? [])
                .filter((r) => options?.includePending === true || !r.pending)
                .map(served);
        }),
      seed: (input) => {
        if (rows.has(input.path)) {
          throw new Error(
            'duplicate key value violates unique constraint "files_workspace_path_key"',
          );
        }
        const objectId = input.objectId ?? null;
        if (objectId !== null && [...rows.values()].some((r) => r.objectId === objectId)) {
          throw new Error(
            'duplicate key value violates unique constraint "files_workspace_object_key"',
          );
        }
        const id = crypto.randomUUID();
        reservedAt.set(id, new Date());
        rows.set(input.path, {
          id,
          path: input.path,
          kind: 'file',
          storageKey: input.path,
          sizeBytes: 0,
          contentType: null,
          status: input.status,
          ...LEGACY,
          objectId,
          createdBy: null,
          ownerPrincipalId: input.ownerPrincipalId,
        });
      },
      assignSkill: (name, agentId) => {
        const skill = state.skills.get(name);
        if (skill === undefined) throw new Error(`no skill named ${name} to assign`);
        state.assignments.set(
          skill.id,
          (state.assignments.get(skill.id) ?? new Set()).add(agentId),
        );
      },
      tryAssignSkill: (name, agentId) => {
        const skill = state.skills.get(name);
        if (skill === undefined) throw new Error(`no skill named ${name} to assign`);
        // The refusal the PostgreSQL assignment writers make: a skill being deleted is not assignable.
        if (skill.pendingDelete !== null) return false;
        state.assignments.set(
          skill.id,
          (state.assignments.get(skill.id) ?? new Set()).add(agentId),
        );
        return true;
      },
      ageSkillRevisions: (name) => {
        const skill = state.skills.get(name);
        if (skill === undefined) throw new Error(`no skill named ${name} to age`);
        const aged = new Date(Date.now() - STALE_SKILL_REVISION_MS - 1000);
        state.revisions.set(
          skill.id,
          (state.revisions.get(skill.id) ?? []).map((r) =>
            r.pending ? { ...r, publishedAt: aged } : r,
          ),
        );
      },
    };
  };

  return {
    forScope: (scope) =>
      forWorkspace(requireWorkspaceScope(scope, 'InMemoryCatalogProvider').workspaceId),
    forWorkspace,
    failNext: (op, error) => {
      failures.set(op, error);
    },
  };
}
