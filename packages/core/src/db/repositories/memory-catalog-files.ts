import { isSidePath, sidePath } from '../side-paths.js';
import {
  CatalogPathPendingError,
  clampCatalogPageLimit,
  renameCount,
  sameReservation,
  type ConfirmOutcome,
  type ReserveOutcome,
  type CatalogPort,
} from './resource-catalogs.js';
import {
  type Row,
  NEW_ROW,
  SHA256_SHAPE,
  underPrefix,
  logical,
  comparePaths,
  byPath,
  assertRowShape,
  later,
  type InMemoryWorkspaceCatalog,
} from './memory-catalog-model.js';
import { createMemoryFileTree } from './memory-catalog-tree.js';

export function createMemoryFileCatalog(context: {
  readonly rows: Map<string, Row>;
  readonly reservedAt: Map<string, Date>;
  readonly failures: Map<keyof CatalogPort, Error>;
}): Pick<
  InMemoryWorkspaceCatalog,
  | 'reserve'
  | 'createFolder'
  | 'confirm'
  | 'get'
  | 'list'
  | 'countPending'
  | 'pending'
  | 'rename'
  | 'remove'
  | 'stalePending'
  | 'deleting'
  | 'forget'
  | 'referencing'
  | 'seed'
> {
  const { rows, reservedAt, failures } = context;
  const { ensureParents, renameByPrefix, markDeleting } = createMemoryFileTree(rows);

  const port = <T>(op: keyof CatalogPort, fn: () => T): Promise<T> => {
    const injected = failures.get(op);
    if (injected === undefined) return later(fn);
    failures.delete(op);
    return Promise.reject(injected);
  };

  function reserveHeldPath(
    path: string,
    input: Parameters<CatalogPort['reserve']>[1],
    holder: Row,
    replaces: Row | undefined,
  ): ReserveOutcome {
    if (holder.status !== 'pending') return { kind: 'taken', row: holder };
    if (
      holder.ownerPrincipalId !== input.ownerPrincipalId ||
      (holder.uploadMode ?? null) !== (input.uploadMode ?? null)
    ) {
      throw new CatalogPathPendingError(path);
    }
    const withTarget = replaces === undefined ? {} : { replaces };
    const unchanged =
      holder.sizeBytes === input.sizeBytes && holder.contentType === input.contentType;
    if (input.uploadMode === 'relay' || (input.uploadMode === undefined && unchanged)) {
      return { kind: 'taken', row: holder, ...withTarget };
    }
    const refreshed: Row = {
      ...holder,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      reservationToken: crypto.randomUUID(),
      updatedAt: new Date(),
    };
    assertRowShape(refreshed);
    rows.set(refreshed.path, refreshed);
    reservedAt.set(refreshed.id, new Date());
    return { kind: 'taken', row: refreshed, ...withTarget };
  }
  return {
    // @story US-STO-02
    reserve: (path, input) =>
      port('reserve', () => {
        if (isSidePath(path)) throw new Error(`${path} is a reserved catalog path.`);
        const holder = rows.get(path);
        // The ready file a pending replacement takes the path from.
        const target = holder?.status === 'ready' && holder.kind === 'file' ? holder : undefined;
        const replacing = target !== undefined;
        if (holder !== undefined && !replacing)
          return reserveHeldPath(path, input, holder, undefined);
        const waiting = [...rows.values()].find(
          (r) => r.status === 'pending' && r.targetPath === path,
        );
        if (waiting !== undefined) return reserveHeldPath(path, input, waiting, target);
        if ([...rows.values()].some((r) => r.objectId === input.objectId)) {
          throw new Error(
            'duplicate key value violates unique constraint "files_workspace_object_key"',
          );
        }
        const id = crypto.randomUUID();
        const row: Row = {
          id,
          path: replacing ? sidePath(id) : path,
          kind: 'file',
          storageKey: `${input.area ?? 'files'}/${input.objectId}`,
          sizeBytes: input.sizeBytes,
          contentType: input.contentType,
          status: 'pending',
          ...NEW_ROW,
          objectId: input.objectId,
          area: input.area ?? 'files',
          targetPath: replacing ? path : null,
          uploadMode: input.uploadMode ?? null,
          reservationToken: crypto.randomUUID(),
          createdBy: input.createdBy ?? null,
          ownerPrincipalId: input.ownerPrincipalId,
          updatedAt: new Date(),
        };
        assertRowShape(row);
        rows.set(row.path, row);
        reservedAt.set(row.id, new Date());
        ensureParents([row]);
        return target === undefined || !replacing
          ? { kind: 'reserved', row }
          : { kind: 'reserved', row, replaces: target };
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
          ...NEW_ROW,
          createdBy: input.createdBy ?? null,
          ownerPrincipalId: input.ownerPrincipalId,
          updatedAt: new Date(),
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
        // A removed (`deleting`) row is never revived. Only a pending row whose storage key and
        // reservation are unchanged is confirmed, unless `expect: 'any'` re-confirms a ready row
        // (FX-7).
        if (
          current === undefined ||
          current.kind !== 'file' ||
          current.status === 'deleting' ||
          current.storageKey === null ||
          current.storageKey !== row.storageKey ||
          (current.status !== 'pending' && input.expect !== 'any') ||
          !sameReservation(current, row)
        ) {
          return null;
        }
        const sha256 = input.sha256 ?? null;
        if (sha256 !== null && !SHA256_SHAPE.test(sha256)) {
          throw new Error('violates check constraint "files_sha256_shape"');
        }
        const { objectId } = input;
        if (objectId !== undefined && [...rows.values()].some((r) => r.objectId === objectId)) {
          throw new Error(
            'duplicate key value violates unique constraint "files_workspace_object_key"',
          );
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
              reservationToken: null,
              updatedAt: new Date(),
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
          reservationToken: null,
          sizeBytes: input.sizeBytes,
          contentType: input.contentType,
          sha256,
          updatedAt: new Date(),
          ...(objectId === undefined
            ? {}
            : { objectId, storageKey: `${current.area ?? 'files'}/${objectId}` }),
        };
        assertRowShape(ready);
        rows.set(ready.path, ready);
        return replaced === undefined ? { row: ready } : { row: ready, replaced };
      }),

    get: (path, options) =>
      port('get', () => {
        const row = isSidePath(path) ? undefined : rows.get(path);
        return row !== undefined &&
          (row.status === 'ready' || (row.status === 'pending' && options?.includePending === true))
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

    countPending: (newerThan) =>
      port(
        'countPending',
        () =>
          [...rows.values()].filter(
            (r) =>
              r.status === 'pending' &&
              r.area !== 'staging' &&
              (newerThan === undefined ||
                (reservedAt.get(r.id)?.getTime() ?? 0) >= newerThan.getTime()),
          ).length,
      ),

    pending: (path) =>
      port(
        'pending',
        () => [...rows.values()].find((r) => r.status === 'pending' && logical(r) === path) ?? null,
      ),

    rename: (from, to) => port('rename', () => renameCount(renameByPrefix(from, to))),

    // @story US-STO-04
    remove: (path, options) =>
      port('remove', () => {
        const snapshot = options?.pending;
        if (snapshot === undefined) return markDeleting(path);
        // Claim one reservation, only while it is still the pending row `snapshot` saw at `path`.
        const current = [...rows.values()].find((r) => r.id === snapshot.id);
        if (
          current?.status !== 'pending' ||
          logical(current) !== path ||
          !sameReservation(current, snapshot)
        ) {
          return [];
        }
        const claimed: Row = {
          ...current,
          status: 'deleting',
          path: sidePath(current.id),
          targetPath: path,
          reservationToken: null,
          updatedAt: new Date(),
        };
        rows.delete(current.path);
        rows.set(claimed.path, claimed);
        return [claimed];
      }),

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
        // A ready row stays, and so does a pending row reserved again since `row` was read.
        if (current === undefined || current.status === 'ready' || !sameReservation(current, row)) {
          return;
        }
        rows.delete(current.path);
        reservedAt.delete(current.id);
      }),

    referencing: ({ objectIds }) =>
      port('referencing', () =>
        [...rows.values()]
          .filter(
            (r) =>
              r.kind === 'file' &&
              r.objectId !== undefined &&
              r.objectId !== null &&
              objectIds.includes(r.objectId),
          )
          .sort(byPath),
      ),

    seed: (input) => {
      if (rows.has(input.path)) {
        throw new Error(
          'duplicate key value violates unique constraint "files_workspace_path_key"',
        );
      }
      const { objectId } = input;
      if ([...rows.values()].some((r) => r.objectId === objectId)) {
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
        storageKey: `files/${objectId}`,
        sizeBytes: 0,
        contentType: null,
        status: input.status,
        ...NEW_ROW,
        objectId,
        reservationToken: input.status === 'pending' ? crypto.randomUUID() : null,
        createdBy: null,
        ownerPrincipalId: input.ownerPrincipalId,
        updatedAt: new Date(),
      });
    },
  };
}
