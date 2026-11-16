import { PRESIGNED_URL_DEFAULT_TTL_SECONDS } from '@indx-workspace/contracts/files';
import {
  SignedUrlUnsupportedError,
  type SignedUrl,
  type SignedUrlRequest,
} from '../storage/objects';
import { systemClock } from '../clock';
import type { StorageContext, StorageService } from '../storage/service';
import { log } from '../telemetry/logger';
import { contentDisposition, downloadContentType } from './file-resource';
import { json, problem, type FileResult } from './file-result';

export function directTransferUnsupported(): FileResult {
  return problem(
    501,
    'direct_transfer_unsupported',
    'This deployment’s object store cannot sign URLs; use the upload and download routes instead.',
  );
}

/** What a presign request carries once parsed against its contract. */
export interface PresignInput {
  readonly ttlSeconds?: number | undefined;
}

export interface PresignUploadInput extends PresignInput {
  readonly contentType?: string | null | undefined;
  readonly sizeBytes: number;
}

/**
 * Signs `path` through `sign` and answers the `201` link, or a typed refusal. A store that cannot
 * sign what was asked (Azure Blob cannot bind a required upload length) is the same `501` as one that
 * cannot sign at all; any other failure is `502 storage_unavailable`, logged by the error's name
 * only, because a provider's message can carry the very link being signed (storage design §05).
 */
async function presigned(
  sign: (key: string, request: SignedUrlRequest) => Promise<SignedUrl | null>,
  path: string,
  request: SignedUrlRequest & { readonly expiresInSeconds: number; readonly now: Date },
): Promise<FileResult> {
  let signed: SignedUrl | null;
  try {
    signed = await sign(path, request);
  } catch (error) {
    if (error instanceof SignedUrlUnsupportedError) return directTransferUnsupported();
    log.error('[files] signing failed', {
      name: error instanceof Error ? error.name : typeof error,
    });
    return problem(502, 'storage_unavailable', 'The object store could not sign a link; retry.');
  }
  if (signed === null) return problem(404, 'file_not_found', 'No file has that id.');
  return json(201, {
    url: signed.url,
    method: request.method,
    headers: signed.headers,
    expiresAt: new Date(request.now.getTime() + request.expiresInSeconds * 1000).toISOString(),
    path,
  });
}

/**
 * `POST /api/files/:id/download-urls` from the catalog: the ready file's own object, signed by the
 * store that holds it. A pending, removed, other-area or absent row answers `404`, as does a
 * legacy row with no storage key or no legacy store for its area. A presign does not check that
 * the object exists, so a link to a vanished object is still minted and fails only when fetched.
 * The link forces the same inert delivery the relay does: a type from the closed table and
 * `Content-Disposition: attachment`.
 */
// @story US-STO-05
export async function presignCatalogDownload(
  storage: StorageService,
  ctx: StorageContext,
  path: string,
  input: PresignInput,
  now: Date = systemClock.now(),
): Promise<FileResult> {
  const row = await storage.get(ctx, 'files', path);
  if (row === null) return problem(404, 'file_not_found', 'No file has that id.');
  const ttl = input.ttlSeconds ?? PRESIGNED_URL_DEFAULT_TTL_SECONDS;
  return presigned(
    () =>
      storage.signDownload(ctx, row, {
        ttlSeconds: ttl,
        responseContentType: downloadContentType(row.contentType),
        responseDisposition: contentDisposition(path.slice(path.lastIndexOf('/') + 1)),
        now,
      }),
    path,
    { method: 'GET', expiresInSeconds: ttl, now },
  );
}
