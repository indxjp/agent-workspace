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
import { decodeResourcePathHeader, RESOURCE_PATH_ENCODING_HEADER } from '../../../contracts/files';
import {
  createFolder,
  fileObjectExists,
  listFiles,
  problem,
  uploadFile,
} from '../../../server/files/handlers';
import {
  readBoundedBodyBytes,
  toResponse,
  withWorkspaceObjectStore,
} from '../../../server/files/http';
import { requireResourceAccess } from '../../../server/resources/authorise';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `GET /api/files?path=…` — every file and folder one level under `path` (root when absent).
 * `path` is a query parameter, not a body: this is the one §16 UI operation ("folders") that reads
 * a location rather than naming one file, and query parameters are where an HTTP `GET` carries
 * that, exactly as the shape rule leaves `/api/files` itself with no dynamic segment for it.
 */
export async function GET(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  const result = await withWorkspaceObjectStore(
    request,
    async (store, catalog) => {
      const listed = await listFiles(store, path);
      if (catalog === null || listed.kind !== 'json' || listed.status !== 200) return listed;
      const body = listed.body as {
        files: Array<{
          id: string;
          path: string;
          kind: 'file' | 'folder';
          sizeBytes: number | null;
          contentType: string | null;
        }>;
      };
      // Resolved once per request, not once per file: `putFile`'s `created_by` is stamped only on
      // the first sync of a path (issue #117 — its `onConflictDoUpdate` never touches the column
      // again), so every later sync of the same row passes this and it is simply ignored.
      const synced = await Promise.all(
        body.files.map(async (file) => {
          const row = await catalog.putFile({
            path: file.path,
            kind: file.kind,
            storageKey: file.kind === 'file' ? file.path : null,
            sizeBytes: file.sizeBytes ?? 0,
            contentType: file.contentType,
            ownerPrincipalId: access.principal.ownerPrincipalId,
            createdBy: access.principal.userId,
          });
          return { ...file, id: row.id };
        }),
      );
      return { ...listed, body: { files: synced } };
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
export async function POST(request: Request): Promise<Response> {
  const access = await requireResourceAccess(request, 'not-applicable');
  if (!access.ok) return access.response;
  const result = await withWorkspaceObjectStore(
    request,
    async (store, catalog) => {
      const pathEncoding = request.headers.get(RESOURCE_PATH_ENCODING_HEADER);
      const decodedFolderPath = decodeResourcePathHeader(
        request.headers.get('x-folder-path'),
        pathEncoding,
      );
      if (!decodedFolderPath.ok) {
        return problem(400, decodedFolderPath.code, 'The resource path encoding is invalid.');
      }
      const folderPath = decodedFolderPath.value;
      if (folderPath !== null) {
        const created = await createFolder(store, folderPath);
        if (catalog === null || created.kind !== 'json' || created.status !== 201) return created;
        try {
          const row = await catalog.putFile({
            path: folderPath,
            kind: 'folder',
            storageKey: null,
            sizeBytes: 0,
            contentType: null,
            ownerPrincipalId: access.principal.ownerPrincipalId,
            createdBy: access.principal.userId,
          });
          return {
            ...created,
            body: { file: { ...(created.body as { file: object }).file, id: row.id } },
          };
        } catch (error) {
          await store.delete(`${folderPath}/.agent-workspace-empty-folder`);
          throw error;
        }
      }
      const decodedFilePath = decodeResourcePathHeader(
        request.headers.get('x-file-path'),
        pathEncoding,
      );
      if (!decodedFilePath.ok) {
        return problem(400, decodedFilePath.code, 'The resource path encoding is invalid.');
      }
      const path = decodedFilePath.value;
      if (path === null || path.trim() === '') {
        return problem(400, 'missing_file_path', 'The "x-file-path" header is required.');
      }
      const bounded = await readBoundedBodyBytes(request);
      if (!bounded.ok) return bounded.result;
      const contentType = request.headers.get('content-type');
      const existed = catalog === null ? false : await fileObjectExists(store, path);
      const uploaded = await uploadFile(store, { path, contentType, body: bounded.bytes });
      if (catalog === null || uploaded.kind !== 'json' || uploaded.status !== 201) return uploaded;
      try {
        const row = await catalog.putFile({
          path,
          kind: 'file',
          storageKey: path,
          sizeBytes: bounded.bytes.byteLength,
          contentType,
          ownerPrincipalId: access.principal.ownerPrincipalId,
          createdBy: access.principal.userId,
        });
        return {
          ...uploaded,
          body: { file: { ...(uploaded.body as { file: object }).file, id: row.id } },
        };
      } catch (error) {
        // An overwrite is not undone: deleting would destroy the caller's file; the next list re-syncs the row.
        if (!existed) await store.delete(path);
        throw error;
      }
    },
    access.principal.workspaceId,
  );
  return toResponse(result);
}
