/**
 * The HTTP edge of the skills routes — mirrors `apps/web/server/files/http.ts`'s split between
 * "turn a `Request` into what a handler needs" and "turn a handler's `ApiResult` into a
 * `Response`".
 *
 * Every skills route carries its payload as a JSON body — `contentBase64` per file, never raw
 * bytes in the request body — so this file's bounded reader produces *text*, not bytes, unlike
 * `files/http.ts`'s. That choice, and why it is what makes the byte-identical round trip a property
 * of `handlers.ts` alone rather than of anything this file does, is `docs/adr/
 * W2-CP-04-skill-storage-keys.md`'s "Why a JSON manifest, not a multipart or archive upload".
 */
import { MAX_SKILL_REQUEST_BODY_BYTES } from '@indx-workspace/contracts/skills';

import { problem, type ApiResult } from './handlers';
import { currentSkillsRuntime } from './runtime';
import { jsonBodyResponse, readRouteParam } from '../http/json-transport';
import type { ObjectStore } from './object-store-bridge';
import type { ResourceCatalogRepository } from '@agent-workspace/core/db';

function tooLarge(observed: string): ApiResult {
  return problem(
    413,
    'request_body_too_large',
    `This route reads at most ${String(MAX_SKILL_REQUEST_BODY_BYTES)} bytes of request body; the request ${observed}.`,
  );
}

/**
 * Read a request body as UTF-8 text, bounded while it streams. Mirrors `files/http.ts`'s
 * `readBoundedBodyBytes`, decoding to text at the end rather than never — every skills route's body
 * is a JSON envelope, and the file bytes inside it travel as base64 text, so nothing here decodes
 * or re-encodes a skill file's own bytes (that happens once, in `handlers.ts`, from the base64
 * string straight to a `Uint8Array`).
 */
export async function readBoundedBodyText(
  request: Request,
): Promise<{ ok: true; text: string } | { ok: false; result: ApiResult }> {
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
    if (length > MAX_SKILL_REQUEST_BODY_BYTES) {
      return { ok: false, result: tooLarge(`declared a Content-Length of ${String(length)}`) };
    }
  }

  const body = request.body;
  if (body === null || body === undefined) return { ok: true, text: '' };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_SKILL_REQUEST_BODY_BYTES) {
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
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(joined) };
  } catch {
    return {
      ok: false,
      result: problem(400, 'malformed_body', 'The request body is not valid UTF-8.'),
    };
  }
}

/**
 * Read and JSON-parse a request body that must be `application/json`, bounded per
 * {@link readBoundedBodyText}. Every skills route with a body goes through this, so the
 * `415`/`400` shape is identical across all of them.
 */
export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  const contentType = request.headers.get('content-type');
  if (contentType === null || !contentType.toLowerCase().startsWith('application/json')) {
    return {
      ok: false,
      result: problem(415, 'unsupported_media_type', 'This route accepts application/json.'),
    };
  }
  const bounded = await readBoundedBodyText(request);
  if (!bounded.ok) return bounded;
  try {
    return { ok: true, value: JSON.parse(bounded.text) };
  } catch {
    return {
      ok: false,
      result: problem(400, 'malformed_body', 'The request body is not valid JSON.'),
    };
  }
}

/** Turn a handler's `ApiResult` into a `Response`. Every response is JSON; see this module's header. */
export function toResponse(result: ApiResult): Response {
  if (result.status === 204) return new Response(null, { status: 204 });
  return jsonBodyResponse(result.status, result.body, { 'x-content-type-options': 'nosniff' });
}

/**
 * Resolve the caller's workspace, hand the matching {@link ObjectStore} to `run`, and return its
 * answer. Every skills route goes through here — see `files/http.ts`'s twin for why this is what
 * makes tenant scoping a property of the route layer.
 */
export async function withWorkspaceSkillsStore(
  request: Request,
  run: (store: ObjectStore, catalog: ResourceCatalogRepository | null) => Promise<ApiResult>,
  authenticatedWorkspaceId?: string,
): Promise<ApiResult> {
  const runtime = currentSkillsRuntime();
  if (runtime === null) {
    return problem(
      503,
      'skills_runtime_not_configured',
      'The skills API has no store or workspace resolver wired into it. This deployment cannot ' +
        'serve skill requests; it is not that the request was rejected.',
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

/** Read `params` from a Next.js dynamic segment defensively — see `files/http.ts`'s twin. */
export async function readNameParam(context: {
  params: Promise<{ name: string }>;
}): Promise<unknown> {
  return readRouteParam(context, 'name');
}
