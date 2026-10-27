/**
 * `GET /api/files` and `POST /api/files` — spec §34 prints both verbatim, so neither needs a
 * `mandate` (ADR-0026 decision 2). The `:id`-addressed routes are in `[id]/route.ts`.
 *
 * Kept deliberately trivial, the same way `apps/web/app/api/agents/route.ts` is: everything worth
 * testing lives in `apps/web/server/files/`, importable by a test with no Next.js framework
 * involved. Imports are relative rather than `@/…` for the same reason that file gives — the `@/`
 * alias is a bundler setting Vitest does not resolve, so a test cannot import a route file that
 * uses it.
 */
import { log } from '../../../server/telemetry/logger';

import { decodeResourcePathHeader, RESOURCE_PATH_ENCODING_HEADER } from '../../../contracts/files';
import {
  attachmentsRefusal,
  listCatalogFolder,
  problem,
  uploadInProgressRefusal,
} from '../../../server/files/handlers';
import { storageContextOf, toResponse, withCatalogService } from '../../../server/files/http';
import { createCatalogFolder, saveUpload } from '../../../server/files/upload-route';
import { route } from '../../../server/http/route';
import { ownershipOfWriteTarget } from '../../../server/files/ownership';
import { requireResourceAccess } from '../../../server/resources/authorise';

/**
 * A failed catalog write is logged server-side and answered with this typed 500; the cause text
 * (SQL, connection strings) never reaches the body. A write refused because an upload to the path
 * is in flight is the caller's conflict, not an outage: `409 upload_in_progress`.
 */
function catalogUnavailable(error: unknown): ReturnType<typeof problem> {
  const pending = uploadInProgressRefusal(error);
  if (pending !== null) return pending;
  log.error('[files] catalog write failed', { error });
  return problem(
    500,
    'catalog_unavailable',
    'The file catalog could not be updated; retry the request.',
  );
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `GET /api/files?path=…` — every file and folder one level under `path` (root when absent).
 * `path` is a query parameter, not a body: this is the one §16 UI operation ("folders") that reads
 * a location rather than naming one file, and query parameters are where an HTTP `GET` carries
 * that, exactly as the shape rule leaves `/api/files` itself with no dynamic segment for it.
 */
async function serveList(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  const result = await withCatalogService(
    request,
    async (storage, catalog) => {
      const scope = access.principal.scope;
      const concealed = attachmentsRefusal(scope, path ?? '', 'read');
      if (concealed !== null) return concealed;
      // @story US-STO-01
      const listed = await listCatalogFolder(
        storage,
        catalog,
        storageContextOf(access.principal),
        path,
      );
      if (listed.kind !== 'json' || listed.status !== 200) return listed;
      const body = listed.body as { files: Array<{ path: string }> };
      return {
        ...listed,
        body: {
          files: body.files.filter((file) => attachmentsRefusal(scope, file.path, 'read') === null),
        },
      };
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}

/**
 * `POST /api/files` — upload one file. The body is the file's raw bytes (never text-decoded, per
 * this task's byte-identical mandate); the path it is written to and its content type travel as
 * headers, `x-file-path` and `Content-Type`, because the body itself is the only carrier of bytes
 * here — there is no JSON envelope to put them in without either base64-inflating every upload or
 * splitting one request into two round trips.
 */
async function serveUpload(request: Request): Promise<Response> {
  const pathEncoding = request.headers.get(RESOURCE_PATH_ENCODING_HEADER);
  const decodedFolderPath = decodeResourcePathHeader(
    request.headers.get('x-folder-path'),
    pathEncoding,
  );
  const decodedFilePath = decodeResourcePathHeader(
    request.headers.get('x-file-path'),
    pathEncoding,
  );
  // A file upload replaces whatever is at its path, so a Builder may write only its own file there
  // (ADR-0031). Creating a folder replaces nothing. A malformed header is refused below, after the
  // caller is known.
  const uploadsFile =
    decodedFolderPath.ok && decodedFolderPath.value === null && decodedFilePath.ok;
  const access = await requireResourceAccess(
    request,
    uploadsFile && decodedFilePath.value !== null
      ? ownershipOfWriteTarget(decodedFilePath.value)
      : 'not-applicable',
  );
  if (!access.ok) return access.response;
  const result = await withCatalogService(
    request,
    async (storage) => {
      if (!decodedFolderPath.ok) {
        return problem(400, decodedFolderPath.code, 'The resource path encoding is invalid.');
      }
      const folderPath = decodedFolderPath.value;
      // @story US-STO-01
      try {
        if (folderPath !== null) {
          return await createCatalogFolder(access.principal, storage, folderPath);
        }
        if (!decodedFilePath.ok) {
          return problem(400, decodedFilePath.code, 'The resource path encoding is invalid.');
        }
        const filePath = decodedFilePath.value;
        if (filePath === null || filePath.trim() === '') {
          return problem(400, 'missing_file_path', 'The "x-file-path" header is required.');
        }
        return await saveUpload(request, access.principal, storage, filePath);
      } catch (error) {
        return catalogUnavailable(error);
      }
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}

export const GET = route({ component: 'files', operation: 'list' }, serveList);
export const POST = route({ component: 'files', operation: 'upload' }, serveUpload);
