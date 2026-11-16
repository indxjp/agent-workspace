import { SESSION_STATE_BLOB_MAX_BYTES } from '@agent-workspace/engine';
import { newObjectId, ObjectConflictError, storageObjectName } from '@agent-workspace/core/storage';
import { BodyTooLargeError, measure } from './measure';
import { type SessionStateBlobCatalog, type SessionStateBlobClaim } from './store';
import type { StorageOperations } from './service-operations';
import type { StorageService } from './service-contract';

export function serviceSessionState(
  operations: StorageOperations,
): Pick<StorageService, 'saveSessionState' | 'discardSessionState'> {
  const { objects, sessionStateRows, abandonBlob, discardBlob } = operations;
  return {
    // @story US-STO-09
    async saveSessionState(ctx, ref, body) {
      let rows: SessionStateBlobCatalog;
      let pending: SessionStateBlobClaim;
      const objectId = newObjectId();
      const name = storageObjectName(ctx.workspaceId, 'session-state', objectId);
      // 1. Reserve: the row holds the object before its first byte, against the cleanup job.
      try {
        rows = await sessionStateRows(ctx.workspaceId);
        pending = await rows.reserveBlob(ref.sessionId, {
          engine: ref.engine,
          objectId,
          storageKey: name,
        });
      } catch (error) {
        await body.cancel().catch(() => undefined);
        throw error;
      }

      // 2. Write, measuring in the stream: no byte of the body is held whole.
      const measured = measure(SESSION_STATE_BLOB_MAX_BYTES);
      try {
        await objects.write(name, body.pipeThrough(measured.stream), {
          ifNoneMatch: '*',
          contentType: 'application/octet-stream',
        });
      } catch (error) {
        // An object that was already there is not ours to delete.
        await abandonBlob(
          rows,
          pending,
          ref.blobKey,
          error instanceof ObjectConflictError ? null : name,
        );
        if (error instanceof BodyTooLargeError) return { ok: false, code: 'too_large' };
        throw error;
      }

      // 3. Confirm against the reservation, swapping the rows in one transaction.
      const { sizeBytes, sha256 } = measured.result();
      let confirmed;
      try {
        confirmed = await rows.confirmBlob(pending, { blobKey: ref.blobKey, sizeBytes, sha256 });
      } catch (error) {
        // The commit may have happened with its reply lost: `abandonBlob` keeps an object the
        // blob's ready row names.
        await abandonBlob(rows, pending, ref.blobKey, name);
        throw error;
      }
      if (confirmed === null) {
        await abandonBlob(rows, pending, ref.blobKey, name);
        return { ok: false, code: 'reservation_lost' };
      }

      // 4. Clean up the replaced blob: object first, then its `deleting` row.
      if (confirmed.replaced !== null) {
        await discardBlob(ctx.workspaceId, rows, confirmed.replaced);
      }
      return { ok: true, sizeBytes, sha256 };
    },

    async discardSessionState(ctx, row) {
      await discardBlob(ctx.workspaceId, await sessionStateRows(ctx.workspaceId), row);
    },
  };
}
