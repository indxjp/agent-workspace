import type { StorageArea } from '@agent-workspace/core/storage';
import type { CatalogFile, CatalogPort } from './store';
import type { SaveInput } from './service-contract';
import {
  inferContentType,
  newObjectId,
  ObjectConflictError,
  storageObjectName,
  toObjectKey,
  UnsafeObjectKeyError,
} from '@agent-workspace/core/storage';
import { BodyTooLargeError, measure } from './measure';
import { isPathPending } from './store';
import type { StorageOperations } from './service-operations';
import type { StorageService, SaveResult } from './service-contract';
import { uploadOccurrence, mayReplace } from './service-policy';

export function serviceSave(
  operations: StorageOperations,
): Pick<StorageService, 'save' | 'stage' | 'unstage'> {
  const { deps, objects, log, audit, deleteObject, locate, abandon } = operations;
  async function allowReplacement(
    catalog: CatalogPort,
    row: CatalogFile,
    input: SaveInput,
    target: CatalogFile | undefined,
  ): Promise<boolean> {
    if ((row.targetPath ?? null) === null) return true;
    const allowed = await mayReplace(input.replace, target).catch(async (error: unknown) => {
      await abandon(catalog, row, null);
      await input.body.cancel().catch((cancelError: unknown) => {
        log.warn('[storage] could not cancel an upload body', { error: cancelError });
      });
      throw error;
    });
    return allowed;
  }

  async function discardReplaced(
    catalog: CatalogPort,
    workspaceId: string,
    area: StorageArea,
    replaced: CatalogFile | undefined,
  ): Promise<void> {
    const replacedObjectId = replaced?.objectId ?? null;
    if (replaced === undefined || replacedObjectId === null) return;
    const old = storageObjectName(workspaceId, replaced.area ?? area, replacedObjectId);
    if (!(await deleteObject(old))) return;
    await catalog.forget(replaced).catch((error: unknown) => {
      log.warn('[storage] could not forget a replaced row; the cleanup job will', {
        rowId: replaced.id,
        error,
      });
    });
  }
  return {
    // @story US-STO-01
    // @story US-STO-14
    async save(ctx, input) {
      // A refusal before the write releases the body's source instead of leaving it to GC.
      const refuse = async (
        code: 'path_taken' | 'upload_in_progress' | 'invalid_path',
      ): Promise<SaveResult> => {
        await input.body.cancel().catch(() => undefined);
        return { ok: false, code };
      };
      let path: string;
      try {
        path = toObjectKey(input.path);
      } catch (error) {
        if (error instanceof UnsafeObjectKeyError) return refuse('invalid_path');
        throw error;
      }
      const catalog = await deps.catalog(ctx.workspaceId);
      const objectId = newObjectId();
      const contentType = input.contentType ?? inferContentType(path);

      // 1. Reserve. The database decides who wins the path.
      let reserved;
      try {
        reserved = await catalog.reserve(path, {
          area: input.area,
          objectId,
          ownerPrincipalId: ctx.principalId,
          uploadMode: 'relay',
          createdBy: ctx.userId,
          sizeBytes: 0,
          contentType,
        });
      } catch (error) {
        if (isPathPending(error)) return refuse('upload_in_progress');
        throw error;
      }
      if (reserved.kind === 'taken') {
        const pending = reserved.row.status === 'pending';
        return refuse(pending ? 'upload_in_progress' : 'path_taken');
      }
      const row = reserved.row;
      // A pending row at a side path is a replacement of a ready file. Checked after the reserve,
      // on the file it read under its lock, so a file that appears between the two cannot be
      // replaced by mistake. A policy that fails releases this reservation and the unread body,
      // and its error is the one the caller sees.
      if (!(await allowReplacement(catalog, row, input, reserved.replaces))) {
        await abandon(catalog, row, null);
        return refuse('path_taken');
      }

      // 2. Write, measuring in the stream.
      const name = storageObjectName(ctx.workspaceId, input.area, objectId);
      const measured = measure(input.maxBytes);
      try {
        await objects.write(name, input.body.pipeThrough(measured.stream), {
          ifNoneMatch: '*',
          contentType,
        });
      } catch (error) {
        // An object that was already there is not ours to delete.
        await abandon(catalog, row, error instanceof ObjectConflictError ? null : name);
        if (error instanceof BodyTooLargeError || measured.result().sizeBytes > input.maxBytes) {
          return { ok: false, code: 'too_large' };
        }
        throw error;
      }

      // 3. Confirm, in one catalog transaction that swaps the rows on a replace.
      let confirmed;
      try {
        confirmed = await catalog.confirm(row, { ...measured.result(), contentType });
      } catch (error) {
        // The commit may have happened with its reply lost, and the file renamed since: `abandon`
        // keeps an object a row still references.
        await abandon(catalog, row, name);
        throw error;
      }
      if (confirmed === null) {
        await abandon(catalog, row, name);
        return { ok: false, code: 'path_changed' };
      }

      // 4. Clean up the replaced file. A failure is logged, not returned: the cleanup job finishes
      // it.
      await discardReplaced(catalog, ctx.workspaceId, input.area, confirmed.replaced);

      // Run outputs (area `artifacts`) and skill files are not user files.
      if (input.area === 'files') {
        await audit(ctx, 'file-uploaded', confirmed.row, {
          occurrence: uploadOccurrence(confirmed.row),
        });
      }
      return { ok: true, row: confirmed.row };
    },

    // @story US-STO-07
    async stage(ctx, body, maxBytes) {
      const catalog = await deps.catalog(ctx.workspaceId);
      const objectId = newObjectId();
      const contentType = 'application/x-tar';
      // One path segment: a deeper path would make the catalog add visible parent folder rows.
      const { row } = await catalog.reserve(`.staging-${objectId}`, {
        area: 'staging',
        objectId,
        ownerPrincipalId: ctx.principalId,
        createdBy: ctx.userId,
        sizeBytes: 0,
        contentType,
      });
      const name = storageObjectName(ctx.workspaceId, 'staging', objectId);
      const measured = measure(maxBytes);
      try {
        await objects.write(name, body.pipeThrough(measured.stream), {
          ifNoneMatch: '*',
          contentType,
        });
      } catch (error) {
        await abandon(catalog, row, name);
        if (error instanceof BodyTooLargeError || measured.result().sizeBytes > maxBytes) {
          return { ok: false, code: 'too_large' };
        }
        throw error;
      }
      return { ok: true, row };
    },

    // @story US-STO-07
    async unstage(ctx, row) {
      const catalog = await deps.catalog(ctx.workspaceId);
      await abandon(catalog, row, locate(ctx.workspaceId, row)?.name ?? null);
    },
  };
}
