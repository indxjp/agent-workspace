/**
 * Publish an upload under a name no link was signed for (#1991 UPLOAD-1). A signed `PUT` stays
 * usable until it expires, and an Azure SAS cannot bind `If-None-Match`, so a row confirmed on the
 * linked object could have its bytes replaced under its checksum. Instead the uploaded (ingress)
 * object is streamed once into a fresh object, counted and hashed on the way in, and `confirm`
 * switches the row to it as it makes it ready. A replayed link only rewrites the unreferenced
 * ingress object, which the orphan sweep removes once old enough. `completeUpload` and the
 * cleanup job both publish here; the price is one bounded copy per upload, at flat memory.
 */
import {
  newObjectId,
  ObjectConflictError,
  storageObjectName,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { BodyTooLargeError, measure } from './measure';
import type { CatalogFile, CatalogPort } from './store';

type ConfirmOutcome = NonNullable<Awaited<ReturnType<CatalogPort['confirm']>>>;

/**
 * `confirmed`: this call published its copy. `stale`: the row was confirmed by someone else, moved
 * or removed meanwhile; this call's copy is gone. `missing`: no ingress object to read.
 * `size_mismatch`: fewer bytes than declared, the row stays pending. `too_large`: more bytes than
 * `limitBytes`; the caller decides what to drop. Only `confirmed` leaves a new object behind.
 */
export type PromotionResult =
  | { readonly kind: 'confirmed'; readonly outcome: ConfirmOutcome }
  | { readonly kind: 'stale' | 'missing' | 'size_mismatch' | 'too_large' };

/**
 * Copy `row`'s ingress object into a new object, then confirm `row` on that copy with the size and
 * SHA-256 of the bytes written to it. `limitBytes` caps the copy (the caller's existing limit);
 * the row's declared size must be met exactly. Infrastructure failures throw after this call's
 * copy is removed, unless the confirm may have committed with its reply lost.
 */
export async function promoteUpload(
  deps: { readonly objects: ObjectStore; readonly catalog: CatalogPort; readonly log: Logger },
  workspaceId: string,
  row: CatalogFile & { readonly objectId: string },
  limitBytes: number,
): Promise<PromotionResult> {
  const { objects, catalog, log } = deps;
  const area = row.area ?? 'files';
  const ingress = storageObjectName(workspaceId, area, row.objectId);
  const source = await objects.read(ingress);
  if (source === null) return { kind: 'missing' };

  const objectId = newObjectId();
  const name = storageObjectName(workspaceId, area, objectId);
  const drop = (target: string) =>
    objects.delete(target).catch((error: unknown) => {
      log.warn('[storage] could not delete an object; the cleanup job will', {
        name: target,
        error,
      });
    });

  // The hash is of the bytes on their way into the final object, so it describes that object and
  // not the ingress one, which a link may still rewrite.
  const measured = measure(limitBytes);
  try {
    await objects.write(name, source.body.pipeThrough(measured.stream), {
      ifNoneMatch: '*',
      contentType: row.contentType,
    });
  } catch (error) {
    // An object that was already there is not ours to delete.
    if (!(error instanceof ObjectConflictError)) await drop(name);
    // A store may wrap the stream's error in its own; the count still tells.
    if (error instanceof BodyTooLargeError || measured.result().sizeBytes > limitBytes) {
      return { kind: 'too_large' };
    }
    throw error;
  }
  const { sizeBytes, sha256 } = measured.result();
  if (sizeBytes !== row.sizeBytes) {
    await drop(name);
    return { kind: 'size_mismatch' };
  }

  let outcome: ConfirmOutcome | null;
  try {
    outcome = await catalog.confirm(row, {
      sizeBytes,
      sha256,
      contentType: row.contentType,
      objectId,
    });
  } catch (error) {
    // The commit may have happened with its reply lost, and the file renamed since: ask by object
    // id, which no rename changes. A failed lookup leaves the copy to the orphan sweep.
    const held = await catalog.referencing({ objectIds: [objectId], storageKeys: [] }).then(
      (rows) => rows.length > 0,
      (lookupError: unknown) => {
        log.warn('[storage] could not check a promoted copy; the cleanup job will', {
          error: lookupError,
        });
        return true;
      },
    );
    if (!held) await drop(name);
    throw error;
  }
  if (outcome === null) {
    await drop(name);
    return { kind: 'stale' };
  }
  // No row names the ingress object now; a failed delete leaves it to the orphan sweep.
  await drop(ingress);
  return { kind: 'confirmed', outcome };
}
