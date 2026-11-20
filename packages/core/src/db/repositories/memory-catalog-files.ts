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

interface FileCatalogState {
  readonly rows: Map<string, Row>;
  readonly reservedAt: Map<string, Date>;
}

type ReserveInput = Parameters<CatalogPort['reserve']>[1];
type ConfirmInput = Parameters<CatalogPort['confirm']>[1];
type PortRow = Parameters<CatalogPort['confirm']>[0];
type FileTree = ReturnType<typeof createMemoryFileTree>;

const UNIQUE_OBJECT_KEY_MESSAGE =
  'duplicate key value violates unique constraint "files_workspace_object_key"';

const reservedPathError = (path: string): Error => new Error(`${path} is a reserved catalog path.`);

const findById = (rows: Map<string, Row>, id: string): Row | undefined =>
  [...rows.values()].find((r) => r.id === id);

const assertObjectIdFree = (rows: Map<string, Row>, objectId: string | undefined): void => {
  if ([...rows.values()].some((r) => r.objectId === objectId)) {
    throw new Error(UNIQUE_OBJECT_KEY_MESSAGE);
  }
};

/** The row a claim turns a pending or replaced row into: queued for deletion, off its logical path. */
const markedDeleting = (row: Row, logicalPath: string): Row => ({
  ...row,
  status: 'deleting',
  path: sidePath(row.id),
  targetPath: logicalPath,
  reservationToken: null,
  updatedAt: new Date(),
});

function reserveHeldPath(
  { rows, reservedAt }: FileCatalogState,
  path: string,
  input: ReserveInput,
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

function newPendingFileRow(path: string, input: ReserveInput, replacing: boolean): Row {
  const id = crypto.randomUUID();
  const area = input.area ?? 'files';
  return {
    id,
    path: replacing ? sidePath(id) : path,
    kind: 'file',
    storageKey: `${area}/${input.objectId}`,
    sizeBytes: input.sizeBytes,
    contentType: input.contentType,
    status: 'pending',
    ...NEW_ROW,
    objectId: input.objectId,
    area,
    targetPath: replacing ? path : null,
    uploadMode: input.uploadMode ?? null,
    reservationToken: crypto.randomUUID(),
    createdBy: input.createdBy ?? null,
    ownerPrincipalId: input.ownerPrincipalId,
    updatedAt: new Date(),
  };
}

function reserveFile(
  state: FileCatalogState,
  tree: FileTree,
  path: string,
  input: ReserveInput,
): ReserveOutcome {
  const { rows, reservedAt } = state;
  if (isSidePath(path)) throw reservedPathError(path);
  const holder = rows.get(path);
  // The ready file a pending replacement takes the path from.
  const target = holder?.status === 'ready' && holder.kind === 'file' ? holder : undefined;
  if (holder !== undefined && target === undefined) {
    return reserveHeldPath(state, path, input, holder, undefined);
  }
  const waiting = [...rows.values()].find((r) => r.status === 'pending' && r.targetPath === path);
  if (waiting !== undefined) return reserveHeldPath(state, path, input, waiting, target);
  assertObjectIdFree(rows, input.objectId);
  const row = newPendingFileRow(path, input, target !== undefined);
  assertRowShape(row);
  rows.set(row.path, row);
  reservedAt.set(row.id, new Date());
  tree.ensureParents([row]);
  return target === undefined
    ? { kind: 'reserved', row }
    : { kind: 'reserved', row, replaces: target };
}

function createFolderRow(
  rows: Map<string, Row>,
  tree: FileTree,
  path: string,
  input: Parameters<CatalogPort['createFolder']>[1],
) {
  if (isSidePath(path)) throw reservedPathError(path);
  const held = rows.get(path);
  if (held !== undefined) return { kind: 'taken' as const, row: held };
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
  tree.ensureParents([row]);
  rows.set(path, row);
  return { kind: 'created' as const, row };
}

/**
 * A removed (`deleting`) row is never revived. Only a pending row whose storage key and
 * reservation are unchanged can be confirmed, unless `expect: 'any'` re-confirms a ready row (FX-7).
 */
function isConfirmable(
  current: Row | undefined,
  row: PortRow,
  input: ConfirmInput,
): current is Row {
  return (
    current !== undefined &&
    current.kind === 'file' &&
    current.status !== 'deleting' &&
    current.storageKey !== null &&
    current.storageKey === row.storageKey &&
    (current.status === 'pending' || input.expect === 'any') &&
    sameReservation(current, row)
  );
}

/** Moves the ready file a replacement is taking over out of the way, if there is one. */
function displaceReplacedFile(rows: Map<string, Row>, current: Row, path: string): Row | undefined {
  const holder = rows.get(path);
  rows.delete(current.path);
  if (holder === undefined || holder.id === current.id || holder.kind !== 'file') return undefined;
  const replaced = markedDeleting(holder, path);
  rows.delete(holder.path);
  rows.set(replaced.path, replaced);
  return replaced;
}

function confirmFile(
  rows: Map<string, Row>,
  row: PortRow,
  input: ConfirmInput,
): ConfirmOutcome | null {
  const current = findById(rows, row.id);
  if (!isConfirmable(current, row, input)) return null;
  const sha256 = input.sha256 ?? null;
  if (sha256 !== null && !SHA256_SHAPE.test(sha256)) {
    throw new Error('violates check constraint "files_sha256_shape"');
  }
  const { objectId } = input;
  if (objectId !== undefined) assertObjectIdFree(rows, objectId);
  const path = logical(current);
  const replaced =
    current.targetPath === null ? undefined : displaceReplacedFile(rows, current, path);
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
}

/** Claims one reservation, only while it is still the pending row `snapshot` saw at `path`. */
function claimPending(rows: Map<string, Row>, path: string, snapshot: PortRow): Row[] {
  const current = findById(rows, snapshot.id);
  if (
    current?.status !== 'pending' ||
    logical(current) !== path ||
    !sameReservation(current, snapshot)
  ) {
    return [];
  }
  const claimed = markedDeleting(current, path);
  rows.delete(current.path);
  rows.set(claimed.path, claimed);
  return [claimed];
}

function listReadyPage(
  rows: Map<string, Row>,
  folder: string,
  page: Parameters<CatalogPort['list']>[1],
) {
  const limit = clampCatalogPageLimit(page?.limit);
  const cursor = page?.cursor;
  const inPage = (r: Row): boolean =>
    r.status === 'ready' &&
    (folder === '' || underPrefix(r.path, folder)) &&
    (cursor === undefined || comparePaths(r.path, cursor) > 0);
  const found = [...rows.values()]
    .filter(inPage)
    .sort(byPath)
    .slice(0, limit + 1);
  const pageRows = found.slice(0, limit);
  return {
    rows: pageRows,
    cursor: found.length > limit ? (pageRows.at(-1)?.path ?? null) : null,
  };
}

const reservedTime = (state: FileCatalogState, row: Row): number =>
  state.reservedAt.get(row.id)?.getTime() ?? 0;

function forgetRow(state: FileCatalogState, row: PortRow): void {
  const current = findById(state.rows, row.id);
  // A ready row stays, and so does a pending row reserved again since `row` was read.
  if (current === undefined || current.status === 'ready' || !sameReservation(current, row)) return;
  state.rows.delete(current.path);
  state.reservedAt.delete(current.id);
}

function seedFile(state: FileCatalogState, input: Parameters<InMemoryWorkspaceCatalog['seed']>[0]) {
  const { rows, reservedAt } = state;
  if (rows.has(input.path)) {
    throw new Error('duplicate key value violates unique constraint "files_workspace_path_key"');
  }
  const { objectId } = input;
  assertObjectIdFree(rows, objectId);
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
}

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
  const { rows, failures } = context;
  const rowList = (): Row[] => [...rows.values()];
  const tree = createMemoryFileTree(rows);

  const port = <T>(op: keyof CatalogPort, fn: () => T): Promise<T> => {
    const injected = failures.get(op);
    if (injected === undefined) return later(fn);
    failures.delete(op);
    return Promise.reject(injected);
  };

  return {
    // @story US-STO-02
    reserve: (path, input) => port('reserve', () => reserveFile(context, tree, path, input)),
    // @story US-STO-01
    createFolder: (path, input) =>
      port('createFolder', () => createFolderRow(rows, tree, path, input)),
    // @story US-STO-14
    confirm: (row, input) => port('confirm', () => confirmFile(rows, row, input)),
    get: (path, options) =>
      port('get', () => {
        const row = isSidePath(path) ? undefined : rows.get(path);
        const visible =
          row?.status === 'ready' ||
          (row?.status === 'pending' && options?.includePending === true);
        return visible ? row : null;
      }),
    list: (folder, page) => port('list', () => listReadyPage(rows, folder, page)),
    countPending: (newerThan) =>
      port(
        'countPending',
        () =>
          rowList().filter(
            (r) =>
              r.status === 'pending' &&
              r.area !== 'staging' &&
              (newerThan === undefined || reservedTime(context, r) >= newerThan.getTime()),
          ).length,
      ),
    pending: (path) =>
      port(
        'pending',
        () => rowList().find((r) => r.status === 'pending' && logical(r) === path) ?? null,
      ),
    rename: (from, to) => port('rename', () => renameCount(tree.renameByPrefix(from, to))),
    // @story US-STO-04
    remove: (path, options) =>
      port('remove', () => {
        const snapshot = options?.pending;
        return snapshot === undefined
          ? tree.markDeleting(path)
          : claimPending(rows, path, snapshot);
      }),
    stalePending: (olderThan) =>
      port('stalePending', () =>
        rowList()
          .filter((r) => r.status === 'pending' && reservedTime(context, r) < olderThan.getTime())
          .sort(byPath),
      ),
    deleting: () =>
      port('deleting', () =>
        rowList()
          .filter((r) => r.status === 'deleting')
          .sort(byPath),
      ),
    forget: (row) => port('forget', () => forgetRow(context, row)),
    referencing: ({ objectIds }) =>
      port('referencing', () =>
        rowList()
          .filter((r) => r.kind === 'file' && r.objectId != null && objectIds.includes(r.objectId))
          .sort(byPath),
      ),
    seed: (input) => seedFile(context, input),
  };
}
