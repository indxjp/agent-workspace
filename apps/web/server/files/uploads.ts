/**
 * Minting a signed upload link also reserves a pending catalog row (the storage design, §04), so
 * the file has an owner from the start and stays out of lists, search and grants until the upload
 * is completed. Completing checks the object the `PUT` really wrote and only then marks the row
 * ready (§04, §05 "Oversized or fake uploads").
 */
// @story US-STO-02
import {
  LINK_REQUESTS_PER_MINUTE_PER_WORKSPACE,
  SIGNED_UPLOAD_HARD_MAX_BYTES,
} from '@indx-workspace/contracts/files';

import { applicationContext } from '../application-context';
import { perMinuteLimiter } from '../http/rate-limit';
import type { StorageContext, StorageService } from '../storage/service';
import type { CatalogFile } from '../storage/store';
import { log } from '../telemetry/logger';
import {
  directTransferUnsupported,
  lastModifiedOf,
  problem,
  reservedFileWriteRefusal,
  uploadInProgress,
  uploadInProgressRefusal,
  type FileResult,
  type PresignUploadInput,
} from './handlers';
import { toPresignedResponse } from './http';

/** The deployment's signed-upload limit (the storage design, §04 "Size limits"). */
function signedUploadMaxBytes(): number {
  const files = applicationContext()?.files;
  return (
    (files?.kind === 'serving' ? files.runtime.signedUploadMaxBytes : undefined) ??
    SIGNED_UPLOAD_HARD_MAX_BYTES
  );
}

/**
 * `POST /api/files/:id/upload-urls` through the catalog service: the link is signed for a new
 * object, so a ready file's bytes are never overwritten and stay readable until completion swaps
 * the rows. `recheck` decides on the ready file the upload would replace, as the reserve locked
 * it; `null` allows.
 */
export async function reserveCatalogUpload(
  storage: StorageService,
  ctx: StorageContext,
  path: string,
  input: PresignUploadInput,
  /** Decides on the ready file the reservation would replace, as it read it under its lock. */
  recheck: (replaced: CatalogFile) => Promise<FileResult | null>,
): Promise<FileResult> {
  const limit = signedUploadMaxBytes();
  if (input.sizeBytes > limit) {
    return problem(
      413,
      'request_body_too_large',
      `This deployment accepts signed uploads up to ${limit} bytes.`,
    );
  }
  const reserved = reservedFileWriteRefusal(path);
  if (reserved !== null) return reserved;
  const refusal: { denied: FileResult | null } = { denied: null };
  const now = new Date();
  let outcome;
  try {
    outcome = await storage.reserveUpload(ctx, {
      path,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      ttlSeconds: input.ttlSeconds,
      now,
      mayReplace: async (replaced) => {
        refusal.denied = await recheck(replaced);
        return refusal.denied === null;
      },
    });
  } catch (error) {
    return catalogFailure(error);
  }
  if (outcome.ok) {
    return {
      status: 201,
      kind: 'json',
      body: {
        url: outcome.url.url,
        method: 'PUT',
        headers: outcome.url.headers,
        expiresAt: outcome.expiresAt.toISOString(),
        path,
      },
    };
  }
  switch (outcome.code) {
    case 'invalid_path':
      return problem(400, 'invalid_path', '"path" is not a valid file path.');
    case 'upload_in_progress':
      return uploadInProgress();
    case 'name_conflict':
      return problem(409, 'name_conflict', `${path} already exists.`);
    case 'too_many_pending':
      return tooManyPending();
    case 'replace_refused':
      return refusal.denied ?? problem(403, 'forbidden', 'You may not replace this file.');
    case 'sign_unsupported':
      return directTransferUnsupported();
    case 'sign_failed':
      return problem(502, 'storage_unavailable', 'The object store could not sign a link; retry.');
  }
}

const tooManyPending = (): FileResult =>
  problem(
    429,
    'too_many_pending_uploads',
    'This workspace has too many unfinished uploads; complete or delete one before requesting another link.',
  );

function catalogFailure(error: unknown): FileResult {
  // Another member's upload holds the path until it is confirmed (FX-7).
  const pending = uploadInProgressRefusal(error);
  if (pending !== null) return pending;
  log.error('[files] catalog reserve failed', { error });
  return problem(
    500,
    'catalog_unavailable',
    'The file catalog could not be updated; retry the request.',
  );
}

// Upload and download links share one allowance per workspace. The window is per server process, so
// N servers allow N x the limit; the pending-upload cap is the exact guard.
const linkRequests = perMinuteLimiter(LINK_REQUESTS_PER_MINUTE_PER_WORKSPACE);

/** `429 link_rate_limited` with `retry-after` once the workspace used its link allowance, else `null`. */
export function refuseLinkRequest(workspaceId: string, nowMs = Date.now()): Response | null {
  const verdict = linkRequests.admit(workspaceId, nowMs);
  if (verdict.admitted) return null;
  const response = toPresignedResponse(
    problem(
      429,
      'link_rate_limited',
      'Too many link requests for this workspace; try again shortly.',
    ),
  );
  response.headers.set('retry-after', String(verdict.retryAfterSeconds));
  return response;
}

/** Forget every count. Tests only. */
export function resetLinkRequestLimits(): void {
  linkRequests.clear();
}

const notVerified = (message: string): FileResult => problem(409, 'upload_not_verified', message);

/** `POST /api/files/:id/upload-complete` through the catalog service; see {@link StorageService.completeUpload}. */
export async function completeCatalogUpload(
  storage: StorageService,
  ctx: StorageContext,
  path: string,
): Promise<FileResult> {
  try {
    const done = await storage.completeUpload(ctx, { path, maxBytes: signedUploadMaxBytes() });
    if (done.ok) {
      const { row } = done;
      return {
        status: 200,
        kind: 'json',
        body: {
          file: {
            id: row.id,
            path: row.path,
            kind: 'file',
            sizeBytes: row.sizeBytes,
            contentType: row.contentType,
            lastModified: lastModifiedOf(row),
          },
        },
      };
    }
    switch (done.code) {
      case 'invalid_path':
        return problem(400, 'invalid_path', '"path" is not a valid file path.');
      case 'not_found':
        return problem(404, 'file_not_found', 'No file has that id.');
      case 'upload_in_progress':
        return uploadInProgress();
      case 'not_verified':
        return notVerified('No object was uploaded for this file yet; upload it, then complete.');
      case 'size_mismatch':
        return notVerified('The uploaded object is smaller than declared; upload it again.');
      case 'too_large':
        return notVerified(
          'The uploaded object was larger than declared or over the upload limit and was deleted.',
        );
    }
  } catch (error) {
    log.error('[files] completing an upload failed', { error });
    return problem(
      500,
      'catalog_unavailable',
      'The upload could not be completed; retry the request.',
    );
  }
}
