/**
 * The HTTP edge of the files routes — mirrors `apps/web/server/agents/http.ts`'s split between
 * "turn a `Request` into what a handler needs" and "turn a handler's `ApiResult` into a
 * `Response`", extended with a binary body path `agents/http.ts` never needed.
 */
import { problem, type ApiResult } from './handlers';
import { currentFilesRuntime } from './runtime';
import { jsonBodyResponse, readRouteParam } from '../http/json-transport';
import type { ObjectStore } from './object-store-bridge';
import type { ResourceCatalogRepository } from '@agent-workspace/core/db';

/** The most bytes a single upload may carry. MVP proxies bytes through this route (R-15 §2: a
 * presigned URL is the scale answer; correctness at this size does not need one yet). 64 MiB is
 * comfortably above the `pricing.xlsx`/`report-template.docx` examples spec §16 itself shows. */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

function tooLarge(observed: string): ApiResult {
  return problem(
    413,
    'request_body_too_large',
    `This route reads at most ${String(MAX_UPLOAD_BYTES)} bytes of request body; the request ${observed}.`,
  );
}

/**
 * Read a request body as raw bytes, bounded while it streams — the same shape
 * `agents/http.ts`'s `readBoundedBodyText` uses, kept binary throughout rather than decoded to a
 * string anywhere, per this task's "byte-identical, no implicit text mode" mandate.
 */
export async function readBoundedBodyBytes(
  request: Request,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; result: ApiResult }> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0) {
      return {
        ok: false,
        result: problem(
          400,
          'malformed_body',
          `The Content-Length header is ${JSON.stringify(declared)}, which is not a byte count.`,
        ),
      };
    }
    if (length > MAX_UPLOAD_BYTES)
      return { ok: false, result: tooLarge(`declared a Content-Length of ${String(length)}`) };
  }

  const body = request.body;
  if (body === null || body === undefined) return { ok: true, bytes: new Uint8Array(0) };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_UPLOAD_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The body is being abandoned either way.
      }
      return { ok: false, result: tooLarge('sent more than that and was not read to the end') };
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: joined };
}

/**
 * `Content-Disposition` for a download, in the two-form shape RFC 6266 §4.3 specifies: a quoted
 * ASCII `filename` every client understands, and a `filename*` carrying the real name in
 * `UTF-8''`-percent-encoded form for the ones that do.
 *
 * The ASCII form is built from a positive character set — letters, digits and a short list of
 * punctuation — with everything else replaced, rather than by deleting the characters that would
 * break the quoting. A key is a caller-supplied string, so a name containing `"`, `\`, a newline or
 * a `;` must not be able to close the quoted string and add a header parameter of its own, and a
 * substitution that starts from what is *allowed* cannot miss a case the way one that starts from
 * what is forbidden can (ADR-0015).
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  // `filename` comes from a key that passed `key-safety.ts`, so it is never empty and has no `/`;
  // the fallback is here because this function must produce a well-formed header regardless.
  const quoted = ascii === '' ? 'download' : ascii;
  return `attachment; filename="${quoted}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Turn a handler's `ApiResult` into a `Response`. The binary arm never touches `JSON.stringify`.
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
export function toResponse(result: ApiResult): Response {
  if (result.kind === 'empty') {
    return new Response(null, {
      status: result.status,
      headers: { 'x-content-type-options': 'nosniff' },
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

/**
 * Resolve the caller's workspace, hand the matching {@link ObjectStore} to `run`, and return its
 * answer. Every files route goes through here — see `agents/http.ts`'s `withWorkspaceStore` for
 * why this is what makes tenant scoping a property of the route layer.
 */
export async function withWorkspaceObjectStore(
  request: Request,
  run: (store: ObjectStore, catalog: ResourceCatalogRepository | null) => Promise<ApiResult>,
  authenticatedWorkspaceId?: string,
): Promise<ApiResult> {
  const runtime = currentFilesRuntime();
  if (runtime === null) {
    return problem(
      503,
      'files_runtime_not_configured',
      'The files API has no store or workspace resolver wired into it. This deployment cannot ' +
        'serve file requests; it is not that the request was rejected.',
    );
  }

  if (authenticatedWorkspaceId !== undefined) {
    return run(
      runtime.store.forWorkspace(authenticatedWorkspaceId),
      runtime.catalog === undefined
        ? null
        : await runtime.catalog.forWorkspace(authenticatedWorkspaceId),
    );
  }

  const resolution = await runtime.resolveWorkspace(request);
  switch (resolution.kind) {
    case 'workspace':
      return run(
        runtime.store.forWorkspace(resolution.workspaceId),
        runtime.catalog === undefined
          ? null
          : await runtime.catalog.forWorkspace(resolution.workspaceId),
      );
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
