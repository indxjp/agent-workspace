import type { CatalogPort } from './store';
import type { StorageContext } from './service-contract';
import {
  inferContentType,
  newObjectId,
  SignedUrlUnsupportedError,
  toObjectKey,
  UnsafeObjectKeyError,
  type SignedUrl,
} from '@agent-workspace/core/storage';
import { MAX_PENDING_UPLOADS_PER_WORKSPACE } from '@indx-workspace/contracts/files';
import { CLEANUP_MIN_AGE_MS } from './cleanup';
import { promoteUpload } from './promote-upload';
import { isPathPending } from './store';
import type { StorageOperations } from './service-operations';
import type { StorageService, CompleteUploadResult } from './service-contract';
import { uploadOccurrence, linkLifetime, mayReplace } from './service-policy';

export function serviceSignedUploads(
  operations: StorageOperations,
): Pick<StorageService, 'reserveUpload' | 'completeUpload'> {
  const { deps, objects, log, audit, locate, discard, abandon } = operations;
  async function verifyCompletedUpload(
    catalog: CatalogPort,
    ctx: StorageContext,
    path: string,
  ): Promise<CompleteUploadResult> {
    // Completed already (a retry after a lost reply): the ready file answers again, if its
    // object is the one the row records.
    const ready = await catalog.get(path);
    if (ready === null || ready.kind !== 'file') return { ok: false, code: 'not_found' };
    const held = locate(ctx.workspaceId, ready);
    const meta = held === null ? null : await held.store.head(held.name);
    if (meta === null || meta.sizeBytes !== ready.sizeBytes) {
      return { ok: false, code: 'not_verified' };
    }
    // A retry after a failed audit write records the upload now, under the key the first
    // complete used, so an upload whose row was written is still one row.
    await audit(ctx, 'file-uploaded', ready, { occurrence: uploadOccurrence(ready) });
    return { ok: true, row: ready };
  }
  return {
    // @story US-STO-02
    async reserveUpload(ctx, request) {
      let path: string;
      try {
        path = toObjectKey(request.path);
      } catch (error) {
        if (error instanceof UnsafeObjectKeyError) return { ok: false, code: 'invalid_path' };
        throw error;
      }
      const expiresInSeconds = linkLifetime(request.ttlSeconds);
      if (expiresInSeconds === null || objects.createSignedUrl === undefined) {
        return { ok: false, code: 'sign_unsupported' };
      }
      const catalog = await deps.catalog(ctx.workspaceId);

      let reserved;
      try {
        reserved = await catalog.reserve(path, {
          area: 'files',
          objectId: newObjectId(),
          ownerPrincipalId: ctx.principalId,
          uploadMode: 'signed',
          createdBy: ctx.userId,
          sizeBytes: request.sizeBytes,
          contentType: inferContentType(path),
        });
      } catch (error) {
        if (isPathPending(error)) return { ok: false, code: 'upload_in_progress' };
        throw error;
      }
      const row = reserved.row;
      if (reserved.kind === 'taken' && (row.kind === 'folder' || row.status !== 'pending')) {
        return { ok: false, code: 'name_conflict' };
      }
      // Only a row this call added is undone on a refusal; the caller's own earlier pending row stays.
      const added = reserved.kind === 'reserved';
      const undo = () => (added ? abandon(catalog, row, null) : Promise.resolve());

      const now = request.now ?? new Date();
      // Counted after the reserve, so re-minting a pending path never counts twice. A reservation
      // older than the longest link plus an hour can no longer be uploaded to, so it does not
      // count, whether or not the cleanup job has removed it yet (the storage design, §05).
      // Each mint counts after its own reservation commits, so the last one admitted counts every
      // admitted row and the cap is never exceeded.
      // ponytail: near the cap, concurrent mints can refuse each other until one undoes its row;
      // count inside reserve's transaction under a workspace lock if that matters.
      const fresh = new Date(now.getTime() - CLEANUP_MIN_AGE_MS);
      if (added && (await catalog.countPending(fresh)) > MAX_PENDING_UPLOADS_PER_WORKSPACE) {
        await undo();
        return { ok: false, code: 'too_many_pending' };
      }
      // A pending row at a side path replaces a ready file. Decided after the reserve, on the file
      // it read under its lock, so a file that appears or moves around the check is never
      // overwritten by mistake. A policy that fails releases this reservation and rethrows.
      if ((row.targetPath ?? null) !== null) {
        const allowed = await mayReplace(request.mayReplace, reserved.replaces).catch(
          async (error: unknown) => {
            await undo();
            throw error;
          },
        );
        if (!allowed) {
          await undo();
          return { ok: false, code: 'replace_refused' };
        }
      }
      const object = locate(ctx.workspaceId, row);
      if (object === null || object.store.createSignedUrl === undefined) {
        await undo();
        return { ok: false, code: 'sign_unsupported' };
      }

      let url: SignedUrl;
      try {
        url = await object.store.createSignedUrl(object.name, {
          method: 'PUT',
          expiresInSeconds,
          contentType: request.contentType ?? null,
          contentLength: request.sizeBytes,
          // Where the store cannot bind the length (Azure Blob), completion deletes an oversize object.
          requireBoundContentLength: object.store.capabilities.boundLengthSign,
          now,
        });
      } catch (error) {
        await undo();
        if (error instanceof SignedUrlUnsupportedError) {
          return { ok: false, code: 'sign_unsupported' };
        }
        // The name only: a provider's message can carry the very link being signed.
        log.error('[storage] signing an upload link failed', {
          name: error instanceof Error ? error.name : typeof error,
        });
        return { ok: false, code: 'sign_failed' };
      }
      // The storage design, §05: the row names the file, never the link or its signature.
      await audit(ctx, 'file-link-created', { id: row.id, path }, { occurrence: null });
      return { ok: true, url, expiresAt: new Date(now.getTime() + expiresInSeconds * 1000) };
    },

    // @story US-STO-02
    async completeUpload(ctx, request) {
      let path: string;
      try {
        path = toObjectKey(request.path);
      } catch (error) {
        if (error instanceof UnsafeObjectKeyError) return { ok: false, code: 'invalid_path' };
        throw error;
      }
      const catalog = await deps.catalog(ctx.workspaceId);
      const row = await catalog.pending(path);
      if (row === null) return verifyCompletedUpload(catalog, ctx, path);

      // A relay row has no declared size until its save confirms, and the save owns its object:
      // measuring or discarding it here would delete an upload in flight.
      if (row.uploadMode === 'relay' || row.ownerPrincipalId !== ctx.principalId) {
        return { ok: false, code: 'upload_in_progress' };
      }
      const object = locate(ctx.workspaceId, row);
      const meta = object === null ? null : await object.store.head(object.name);
      if (object === null || meta === null) return { ok: false, code: 'not_verified' };
      // Only the new object and its pending row go: a ready file's bytes are never touched.
      const refuseLarge = async (): Promise<CompleteUploadResult> => {
        await discard(catalog, ctx.workspaceId, row);
        return { ok: false, code: 'too_large' };
      };
      if (meta.sizeBytes > row.sizeBytes || meta.sizeBytes > request.maxBytes) return refuseLarge();
      if (meta.sizeBytes !== row.sizeBytes) return { ok: false, code: 'size_mismatch' };

      // The checksum is of the bytes in the store, not of what the caller says it sent, and of the
      // copy no link can write, not of the object the link names (`promote-upload.ts`).
      const objectId = row.objectId ?? null;
      if (objectId === null) return { ok: false, code: 'not_verified' };
      const promoted = await promoteUpload(
        { objects, catalog, log },
        ctx.workspaceId,
        { ...row, objectId },
        Math.min(request.maxBytes, row.sizeBytes),
      );
      if (promoted.kind !== 'confirmed') {
        if (promoted.kind === 'too_large') return refuseLarge();
        if (promoted.kind === 'missing') return { ok: false, code: 'not_verified' };
        if (promoted.kind === 'size_mismatch') return { ok: false, code: 'size_mismatch' };
        // Confirmed by a concurrent complete, or the path moved while the object was read.
        const current = await catalog.get(path);
        return current !== null && current.id === row.id
          ? { ok: true, row: current }
          : { ok: false, code: 'not_found' };
      }
      const confirmed = promoted.outcome;
      if (confirmed.replaced !== undefined) {
        await discard(catalog, ctx.workspaceId, confirmed.replaced);
      }
      await audit(ctx, 'file-uploaded', confirmed.row, {
        occurrence: uploadOccurrence(confirmed.row),
      });
      return { ok: true, row: confirmed.row };
    },
  };
}
