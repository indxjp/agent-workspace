import { randomUUID } from 'node:crypto';
import {
  storageObjectName,
  type ObjectStore,
  type StorageArea,
} from '@agent-workspace/core/storage';
import {
  type CatalogFile,
  type CatalogPort,
  type SessionStateBlobCatalog,
  type SessionStateBlobClaim,
} from './store';
import {
  type StorageAuditEvent,
  type StorageContext,
  type ObjectRow,
  type RemoveResult,
  type StorageDependencies,
} from './service-contract';
import { auditKey, listedIn } from './service-policy';
export type { SessionStateBlobCatalog };

export function createStorageOperations(deps: StorageDependencies) {
  const { objects, log } = deps;

  /**
   * Record `action` on `row` for the acting principal, if the caller named one, under the audit key
   * of `occurrence` (`null`: this request). Written twice at most, under the same key.
   */
  async function audit(
    ctx: Pick<StorageContext, 'workspaceId' | 'actor'>,
    action: StorageAuditEvent['action'],
    row: Pick<CatalogFile, 'id' | 'path'>,
    request: { readonly occurrence: string | null; readonly label?: string },
  ): Promise<void> {
    const { occurrence, label = row.path } = request;
    const { actor } = ctx;
    const write = deps.audit;
    if (write === undefined || actor === undefined) return;
    const event: StorageAuditEvent = {
      id: auditKey([ctx.workspaceId, action, row.id, occurrence ?? randomUUID()]),
      workspaceId: ctx.workspaceId,
      actorPrincipalId: actor.principalId,
      actorUserId: actor.userId,
      actorLabel: actor.label,
      action,
      subjectId: row.id,
      subjectLabel: label,
    };
    await write(event).catch(() => write(event));
  }

  const deleteObject = (name: string, store: ObjectStore = objects): Promise<boolean> =>
    store.delete(name).then(
      () => true,
      (error: unknown) => {
        log.warn('[storage] could not delete an object; the cleanup job will', {
          name,
          error,
        });
        return false;
      },
    );

  /** Where a row's bytes are: the root store, by object id. `null` for a row with none (a folder). */
  function locate(workspaceId: string, row: ObjectRow) {
    const objectId = row.objectId ?? null;
    if (objectId === null) return null;
    return { store: objects, name: storageObjectName(workspaceId, row.area ?? 'files', objectId) };
  }

  /** Delete a row's object; `false` when it is left (a failure is logged and left to the cleanup job). */
  async function deleteRowObject(workspaceId: string, row: ObjectRow): Promise<boolean> {
    const object = locate(workspaceId, row);
    if (object === null) {
      log.warn('[storage] a replaced or purged row names no object; nothing is deleted');
      return false;
    }
    return deleteObject(object.name, object.store);
  }

  /** The session-state blob rows of a workspace. */
  async function sessionStateRows(workspaceId: string): Promise<SessionStateBlobCatalog> {
    if (deps.sessionState === undefined) {
      throw new Error('the storage service has no session-state catalog');
    }
    return deps.sessionState(workspaceId);
  }

  /**
   * Remove the reservation of a session-state save that did not confirm, then the object `name` it
   * wrote, as {@link abandon} does for a file: only the reservation `pending` names is forgotten,
   * and the object goes unless the blob's ready row names it (a confirm that committed with its
   * reply lost). A row that moved it aside as `deleting` deletes it anyway. A failed lookup keeps
   * the object for the cleanup job.
   */
  async function abandonBlob(
    rows: SessionStateBlobCatalog,
    pending: SessionStateBlobClaim,
    blobKey: string,
    name: string | null,
  ) {
    await rows.forgetBlob(pending).catch((error: unknown) => {
      log.warn('[storage] could not forget a session-state reservation; the cleanup job will', {
        error,
      });
    });
    const objectId = pending.objectId;
    if (name === null) return;
    const held = await rows.getBlob(pending.sessionId, pending.engine, blobKey).then(
      (ready) => ready?.objectId === objectId,
      (error: unknown) => {
        log.warn('[storage] could not check a saved session-state object; the cleanup job will', {
          error,
        });
        return true;
      },
    );
    if (!held) await deleteObject(name);
  }

  /** Delete a `deleting` session-state row's object, then forget the row; a failure keeps it. */
  async function discardBlob(
    workspaceId: string,
    rows: SessionStateBlobCatalog,
    row: SessionStateBlobClaim,
  ) {
    const object = { area: 'session-state' as const, ...row };
    if (!(await deleteRowObject(workspaceId, object))) return;
    await rows.forgetBlob(row).catch((error: unknown) => {
      log.warn('[storage] could not forget a deleted session-state row; the cleanup job will', {
        error,
      });
    });
  }

  /**
   * Claim a pending row for deletion before its object goes (`remove` with the snapshot): only the
   * unchanged reservation `row` saw is claimed, so a row confirmed or reserved again since keeps
   * its bytes. `null` when nothing was claimed; a failed claim is logged and left to the cleanup job.
   */
  async function claimPending(catalog: CatalogPort, row: CatalogFile): Promise<CatalogFile | null> {
    try {
      const [claimed] = await catalog.remove(row.targetPath ?? row.path, { pending: row });
      return claimed ?? null;
    } catch (error) {
      log.warn('[storage] could not claim a pending row; the cleanup job will', {
        rowId: row.id,
        error,
      });
      return null;
    }
  }

  /**
   * Remove the upload pending at `path` when no ready file holds it: its reservation is claimed,
   * then its object and row go, as for a removed file. The route has already decided the caller
   * may (STO-111 #2). `not_found` when nothing is pending there either.
   */
  async function removePending(
    ctx: Pick<StorageContext, 'workspaceId' | 'actor'>,
    catalog: CatalogPort,
    area: StorageArea,
    path: string,
  ): Promise<RemoveResult> {
    const pending = await catalog.get(path, { includePending: true });
    if (pending?.status !== 'pending' || !listedIn(pending, area)) {
      return { ok: false, code: 'not_found' };
    }
    const claimed = await catalog.remove(path, { pending });
    // Nothing claimed: the upload completed, or another delete took it, since it was read.
    if (claimed.length === 0) return { ok: false, code: 'not_found' };
    for (const r of claimed) await discard(catalog, ctx.workspaceId, r);
    if (area === 'files')
      await audit(ctx, 'file-deleted', pending, { occurrence: pending.id, label: path });
    return { ok: true, removed: claimed.length, files: [path] };
  }

  /**
   * Delete a removed row's object, then drop the row; a failure leaves it `deleting` for the cleanup
   * job. A pending row is claimed first, and left alone when it changed since it was read.
   */
  async function discard(catalog: CatalogPort, workspaceId: string, row: CatalogFile) {
    const object = locate(workspaceId, row);
    if (object === null) {
      log.warn('[storage] a removed row names no object; the cleanup job will', {
        rowId: row.id,
      });
      return;
    }
    const doomed = row.status === 'pending' ? await claimPending(catalog, row) : row;
    if (doomed === null) return;
    if (!(await deleteObject(object.name, object.store))) return;
    await catalog.forget(doomed).catch((error: unknown) => {
      log.warn('[storage] could not forget a removed row; the cleanup job will', {
        rowId: row.id,
        error,
      });
    });
  }

  /**
   * Remove the pending row of a save or link that did not finish, then the object `name` it wrote.
   * Only the reservation `row` saw is forgotten, and the object goes only when no live row
   * references it by object id, which no rename changes: a row another caller confirmed keeps its
   * bytes, and a removed (`deleting`) row's object goes with that row anyway. A failed `forget` or
   * lookup keeps the object for the cleanup job.
   */
  async function abandon(catalog: CatalogPort, row: CatalogFile, name: string | null) {
    await catalog.forget(row).catch((error: unknown) => {
      log.warn('[storage] could not forget a pending row; the cleanup job will', {
        rowId: row.id,
        error,
      });
    });
    const objectId = row.objectId ?? null;
    if (name === null || objectId === null) return;
    const held = await catalog.referencing({ objectIds: [objectId] }).then(
      (rows) => rows.some((other) => other.status !== 'deleting'),
      (error: unknown) => {
        log.warn('[storage] could not check a saved object; the cleanup job will', { error });
        return true;
      },
    );
    if (!held) await deleteObject(name);
  }
  return {
    deps,
    objects,
    log,
    audit,
    deleteObject,
    locate,
    deleteRowObject,
    sessionStateRows,
    abandonBlob,
    discardBlob,
    claimPending,
    removePending,
    discard,
    abandon,
  };
}

export type StorageOperations = ReturnType<typeof createStorageOperations>;
