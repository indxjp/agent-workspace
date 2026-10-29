/**
 * `POST /api/files` through the catalog service (the storage design, §04 "Saving a file"): the
 * body streams to the object store and the database decides who wins a path, so there is no
 * in-process lock.
 */
import { MAX_UPLOAD_BYTES } from '@indx-workspace/contracts/files';

import { toObjectKey, UnsafeObjectKeyError } from '@agent-workspace/core/storage/keys';
import type { Principal } from '../rbac/principal';
import { recheckResourceAccess } from '../resources/authorise';
import type { CatalogFile } from '../storage/store';
import type { StorageService } from '../storage/service';
import {
  attachmentsRefusal,
  lastModifiedOf,
  problem,
  reservedFileWriteRefusal,
  uploadInProgress,
  type FileResource,
  type FileResult,
} from './handlers';
import { boundedBodyStream, storageContextOf, tooLarge } from './http';
import { ownershipOfFileOwner } from './ownership';

function created(row: CatalogFile): FileResult {
  const file: FileResource =
    row.kind === 'folder'
      ? {
          id: row.id,
          path: row.path,
          kind: 'folder',
          sizeBytes: null,
          contentType: null,
          lastModified: null,
        }
      : {
          id: row.id,
          path: row.path,
          kind: 'file',
          sizeBytes: row.sizeBytes,
          contentType: row.contentType,
          lastModified: lastModifiedOf(row),
        };
  return { status: 201, kind: 'json', body: { file } };
}

/**
 * The request's `Content-Type`, as the presign contract bounds a declared type (1..255 characters),
 * or `null` so the name decides. It is only recorded: a download answers with a type from the
 * closed table (`downloadContentType`), never with this text.
 */
function declaredContentType(request: Request): string | null {
  const declared = request.headers.get('content-type')?.trim() ?? '';
  return declared.length > 0 && declared.length <= 255 ? declared : null;
}

const nameConflict = (path: string): FileResult =>
  problem(409, 'name_conflict', `${path} already exists.`);

/** The key a write to `rawPath` lands on, or the `400` for a path the key guard or a reserved name refuses. */
function writableKey(
  principal: Principal,
  rawPath: string,
  what: 'file' | 'folder',
): { ok: true; key: string } | { ok: false; result: FileResult } {
  const refused = attachmentsRefusal(principal.scope, rawPath, 'write');
  if (refused !== null) return { ok: false, result: refused };
  let key: string;
  try {
    key = toObjectKey(rawPath);
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) {
      return {
        ok: false,
        result: problem(
          400,
          'invalid_path',
          `"path" is not a valid ${what} path: ${error.message}`,
        ),
      };
    }
    throw error;
  }
  const reserved = reservedFileWriteRefusal(key);
  return reserved === null ? { ok: true, key } : { ok: false, result: reserved };
}

// @story US-STO-01
export async function createCatalogFolder(
  principal: Principal,
  storage: StorageService,
  rawPath: string,
): Promise<FileResult> {
  const target = writableKey(principal, rawPath, 'folder');
  if (!target.ok) return target.result;
  const made = await storage.createFolder(storageContextOf(principal), target.key);
  if (made.ok) return created(made.row);
  return made.code === 'upload_in_progress'
    ? uploadInProgress()
    : made.code === 'name_conflict'
      ? nameConflict(target.key)
      : problem(400, 'invalid_path', '"path" is not a valid folder path.');
}

// @story US-STO-01
// @story US-STO-14
export async function saveUpload(
  request: Request,
  principal: Principal,
  storage: StorageService,
  rawPath: string,
): Promise<FileResult> {
  const target = writableKey(principal, rawPath, 'file');
  if (!target.ok) return target.result;
  const bounded = boundedBodyStream(request, MAX_UPLOAD_BYTES);
  if (!bounded.ok) return bounded.result;
  // The ownership read before this call can be stale: another member may have written the path
  // since. The file a replacement takes the path from is decided again, as the reservation read
  // it under its lock (FX-1, #1991 C1).
  const refusal: { denied: FileResult | null } = { denied: null };
  const saved = await storage.save(storageContextOf(principal), {
    area: 'files',
    path: target.key,
    body: bounded.body,
    maxBytes: MAX_UPLOAD_BYTES,
    contentType: declaredContentType(request),
    replace: async (replaced) => {
      const denied = await recheckResourceAccess(
        request,
        principal,
        ownershipOfFileOwner(replaced),
      );
      refusal.denied = denied === null ? null : { ...denied, kind: 'json' };
      return denied === null;
    },
  });
  if (saved.ok) return created(saved.row);
  if (refusal.denied !== null) return refusal.denied;
  switch (saved.code) {
    case 'too_large':
      return tooLarge('sent more than that and was not read to the end', MAX_UPLOAD_BYTES);
    case 'upload_in_progress':
    case 'path_changed':
      return uploadInProgress();
    case 'path_taken':
      // The caller may not replace the file there, or a folder (anything that cannot be replaced)
      // holds the path.
      return refusal.denied ?? nameConflict(target.key);
    case 'invalid_path':
      return problem(400, 'invalid_path', '"path" is not a valid file path.');
  }
}
