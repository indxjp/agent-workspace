/**
 * The HTTP edge of the files routes — mirrors `apps/web/server/agents/http.ts`'s split between
 * "turn a `Request` into what a handler needs" and "turn a handler's `FileResult` into a
 * `Response`", extended with a binary body path `agents/http.ts` never needed.
 */
import { MAX_UPLOAD_BYTES } from '@indx-workspace/contracts/files';
import { contentDisposition, problem, type FileResult } from './handlers';
import { applicationContext } from '../application-context';
import { jsonBodyResponse, readBoundedJson, readRouteParam } from '../http/json-transport';
import type { ResourceCatalogRepository } from '@agent-workspace/core/db';
import type { Principal } from '../rbac/principal';
import type { WorkspaceResolution } from './runtime';
import type { StorageContext, StorageService } from '../storage/service';

/** The catalog service's caller, from the signed-in principal only. */
export function storageContextOf(principal: Principal): StorageContext {
  return {
    workspaceId: principal.workspaceId,
    principalId: principal.ownerPrincipalId,
    userId: principal.userId,
    actor: { principalId: principal.principalId, userId: principal.userId, label: principal.label },
  };
}

export function tooLarge(observed: string, maxBytes: number): FileResult {
  return problem(
    413,
    'request_body_too_large',
    `This route reads at most ${String(maxBytes)} bytes of request body; the request ${observed}.`,
  );
}

/** The refusal for a declared `Content-Length` that is not a byte count or is over `maxBytes`, else `null`. */
function declaredLengthRefusal(request: Request, maxBytes: number): FileResult | null {
  const declared = request.headers.get('content-length');
  if (declared === null) return null;
  const length = Number(declared);
  if (!Number.isInteger(length) || length < 0) {
    return problem(
      400,
      'malformed_body',
      `The Content-Length header is ${JSON.stringify(declared)}, which is not a byte count.`,
    );
  }
  return length > maxBytes
    ? tooLarge(`declared a Content-Length of ${String(length)}`, maxBytes)
    : null;
}

/**
 * A request body as a stream, refused up front when its declared `Content-Length` is malformed or
 * over `maxBytes`. A body with no (or a false) length is not counted here: the catalog service
 * measures the bytes as it writes them and stops at the limit (`storage/measure.ts`).
 */
export function boundedBodyStream(
  request: Request,
  maxBytes: number = MAX_UPLOAD_BYTES,
): { ok: true; body: ReadableStream<Uint8Array> } | { ok: false; result: FileResult } {
  const refusal = declaredLengthRefusal(request, maxBytes);
  if (refusal !== null) return { ok: false, result: refusal };
  return { ok: true, body: request.body ?? new Blob([]).stream() };
}

/** The most a presign request body may be: a content type, a size and a lifetime. */
const MAX_PRESIGN_BODY_BYTES = 4096;

/** Read a small JSON request body and parse it with a wire contract's schema; a refusal is a `400`. */
export async function readContractBody<T>(
  request: Request,
  schema: {
    safeParse(input: unknown): { success: true; data: T } | { success: false };
  },
): Promise<{ ok: true; value: T } | { ok: false; result: FileResult }> {
  const body = await readBoundedJson(request, { maxBytes: MAX_PRESIGN_BODY_BYTES, problem });
  if (!body.ok) return body;
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) {
    return {
      ok: false,
      result: problem(400, 'malformed_body', 'The request body does not match the route’s schema.'),
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Turn a handler's `FileResult` into a `Response`. The binary arm never touches `JSON.stringify`.
 *
 * ## Why every response here carries `X-Content-Type-Options: nosniff`, and every download is an attachment
 *
 * W2-CP-03's verification round 1 found stored XSS on `GET /api/files/:id`: the route echoed the
 * uploader's own `Content-Type` back verbatim, with neither header, so any workspace member could
 * upload `<script>alert(document.domain)</script>` as `text/html` and have it served as active
 * content from the application's own origin to any other member. Three independent things now stop
 * that, and each one closes it alone:
 *
 *   1. `handlers.ts`'s `downloadContentType` never names a type outside its own closed table, so
 *      the response `Content-Type` is not caller-controlled text at all.
 *   2. `Content-Disposition: attachment` on every binary response — the browser saves the bytes
 *      instead of rendering them in a browsing context.
 *   3. `X-Content-Type-Options: nosniff` on every response, so a client cannot decide for itself
 *      that `application/octet-stream` "looks like" HTML and render it anyway.
 *
 * **The consequence, stated rather than glossed:** this route cannot be used as the `src` of an
 * inline preview — an `<img>` or a PDF frame pointed at `/api/files/:id` will download instead of
 * rendering. §16's "preview metadata" is served by `GET /api/files` (size, content type, modified
 * time) and is unaffected; an inline *content* preview needs a separate, sandboxed delivery path
 * (a distinct origin, or a one-time signed URL), which no task in this wave owns.
 */
export function toResponse(result: FileResult): Response {
  if (result.kind === 'empty') {
    return new Response(null, {
      status: result.status,
      headers: { 'x-content-type-options': 'nosniff' },
    });
  }
  if (result.kind === 'stream') {
    return new Response(result.body, {
      status: result.status,
      headers: {
        'content-type': result.contentType,
        'content-length': String(result.sizeBytes),
        'content-disposition': contentDisposition(result.filename),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    });
  }
  if (result.kind === 'binary') {
    // `new Blob([Uint8Array])` rather than passing the `Uint8Array` straight to `Response`: some
    // pinned `lib.dom.d.ts` versions type `BodyInit` in a way a plain typed array does not satisfy
    // even though every runtime here accepts one directly. `Blob` copies no text and applies no
    // encoding — it is still exactly `result.body`'s bytes, just wrapped in a type both sides agree
    // on.
    return new Response(new Blob([new Uint8Array(result.body)]), {
      status: result.status,
      headers: {
        'content-type': result.contentType,
        'content-disposition': contentDisposition(result.filename),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    });
  }
  return jsonBodyResponse(result.status, result.body, { 'x-content-type-options': 'nosniff' });
}

/** {@link toResponse} for a presigned URL, which is a bearer secret and must not be cached. */
export function toPresignedResponse(result: FileResult): Response {
  const response = toResponse(result);
  response.headers.set('cache-control', 'no-store');
  return response;
}

/**
 * Resolve the caller's workspace, hand the catalog and the catalog service to `run`, and return its
 * answer. Every files route goes through here — see `agents/http.ts`'s `withWorkspaceStore` for
 * why this is what makes tenant scoping a property of the route layer. A deployment without the
 * catalog service (no `AW_STORAGE_URL`) answers `503 files_runtime_not_configured`.
 */
export async function withCatalogService(
  request: Request,
  run: (storage: StorageService, catalog: ResourceCatalogRepository) => Promise<FileResult>,
  authenticatedWorkspaceId?: string,
): Promise<FileResult> {
  const files = applicationContext()?.files;
  const runtime = files?.kind === 'serving' ? files.runtime : null;
  if (runtime?.storage === undefined || runtime.catalog === undefined) {
    return problem(
      503,
      'files_runtime_not_configured',
      'The files API has no catalog service or workspace resolver wired into it. This deployment ' +
        'cannot serve file requests; it is not that the request was rejected.',
    );
  }
  const { storage } = runtime;

  const resolution: WorkspaceResolution =
    authenticatedWorkspaceId === undefined
      ? await runtime.resolveWorkspace(request)
      : { kind: 'workspace', workspaceId: authenticatedWorkspaceId };
  switch (resolution.kind) {
    case 'workspace':
      return run(storage, await runtime.catalog.forWorkspace(resolution.workspaceId));
    case 'unauthenticated':
      return problem(401, 'unauthenticated', resolution.reason);
    case 'forbidden':
      return problem(403, 'forbidden', resolution.reason);
    default: {
      const unreachable: never = resolution;
      return problem(
        500,
        'unhandled_workspace_resolution',
        `The workspace resolver returned a case this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/** Read `params` from a Next.js dynamic segment defensively — see `agents/http.ts`'s twin. */
export async function readIdParam(context: { params: Promise<{ id: string }> }): Promise<unknown> {
  return readRouteParam(context, 'id');
}
