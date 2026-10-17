/**
 * The HTTP edge of this task: the problem shape, the bounded body reader, and `authorise` — the
 * one call every route handler of this task makes before it does anything else.
 *
 * ## `authorise` derives the route from the request, and transcribes nothing
 *
 * The method and the path handed to `decide` come from the `Request`, not from an argument the
 * handler passes about itself. A handler that named its own route could name the wrong one, and a
 * matrix test would still be green because it asks `decide` the same question the handler asks.
 * Reading `new URL(request.url).pathname` removes that whole class of disagreement: the string
 * `decide` classifies is the string the router matched.
 *
 * ## The four answers, and why `refuse` is not a `403`
 *
 * ```text
 * runtime unwired     503 rbac_runtime_not_configured   nothing was checked, and nothing pretends to have been
 * identify() → null   401 unauthenticated               no session cookie and no usable API key
 * decide()  → refuse  500 authorisation_undecidable     the route is not classified; see decide.ts
 * decide()  → deny    403 forbidden                     §21 says no, and the body says which sentence
 * ```
 *
 * A `403` for the third case would be a lie with a plausible shape: it asserts a rule was applied.
 * ADR-0015 and ADR-0031 both land on the same line here — a check that cannot run must fail, and
 * it must fail as itself.
 */
import { decide, type Decision, type Ownership } from './decide';
import type { WorkspaceDirectory } from './directory';
import type { Principal } from './principal';
import { currentRbacRuntime } from './runtime';

/** A handler's answer, before it becomes a `Response`. */
export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  /** Extra response headers, e.g. `retry-after` on a `429`. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Bytes of request body these routes read. A user, a membership and an API key are each a handful
 * of short strings; anything larger is not one of them and does not need to be buffered to find
 * out.
 */
export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

const JSON_MEDIA_TYPE = 'application/json';

/**
 * The standard error envelope. `code` is stable; the prose is `message`. `detail` repeats the same
 * string until the next major release (ADR-0078 D7) so a reader written against the earlier `{ code, detail }` spelling keeps
 * working; it is removed in the next major release, no earlier than one minor after (ADR-0078 D7).
 */
export function problem(status: number, code: string, detail: string): ApiResult {
  return { status, body: { error: { code, message: detail, detail } } };
}

/**
 * Turn a result into a `Response`.
 *
 * A handler that answers "done, and there is nothing to say" writes `{ status: 204, body: null }`
 * — `deleteMembership` does. `JSON.stringify(null)` is the four-byte string
 * `"null"`, and the `Response` constructor rejects a body on a 204 outright (`TypeError: Invalid
 * response status code 204`), so serialising it turned every successful removal into a `500`. The
 * empty arm is therefore a body-less `Response`, with no `content-type` to describe a body that is
 * not there — the same decision `apiResultResponse` in `server/http/json-transport.ts` makes.
 */
export function toResponse(result: ApiResult): Response {
  // These bodies are per-caller and authorisation-dependent. A shared cache holding one would
  // serve one member's answer to another — which is as true of a 204 as of a body.
  const cacheControl = { ...result.headers, 'cache-control': 'no-store' };
  if (result.status === 204 || result.body === null) {
    return new Response(null, { status: result.status, headers: cacheControl });
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...cacheControl, 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Read a JSON body, bounded, or the problem that stopped it. */
export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  const contentType = request.headers.get('content-type');
  const mediaType =
    contentType === null ? '' : (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    return {
      ok: false,
      result: problem(
        415,
        'unsupported_media_type',
        `This route accepts ${JSON_MEDIA_TYPE}; the request declared ` +
          `${mediaType === '' ? 'no Content-Type' : JSON.stringify(mediaType)}.`,
      ),
    };
  }
  let text: string;
  try {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > MAX_REQUEST_BODY_BYTES) {
      return {
        ok: false,
        result: problem(
          413,
          'request_body_too_large',
          `This route reads at most ${String(MAX_REQUEST_BODY_BYTES)} bytes of request body.`,
        ),
      };
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return {
      ok: false,
      result: problem(400, 'malformed_body', 'The request body could not be read as UTF-8.'),
    };
  }
  if (text.trim() === '') {
    return {
      ok: false,
      result: problem(400, 'malformed_body', 'This route requires a JSON object body.'),
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      result: problem(400, 'malformed_body', 'The request body is not valid JSON.'),
    };
  }
}

/** What `authorise` hands a handler once every gate above it has answered yes. */
export interface AuthorisedRequest {
  readonly principal: Principal;
  readonly directory: import('./directory').WorkspaceDirectory;
  readonly decision: Decision;
}

/**
 * What an {@link OwnershipResolver} answers.
 *
 * `ownership` is the ordinary case: the resolver read the row (or decided none was needed) and
 * names what `decide()` should see. `refuse` is issue #117's "indistinguishable 404" case — the
 * row is absent from the caller's workspace, or in another tenant, and the resolver hands back the
 * exact {@link ApiResult} the route wants returned. `authorise` returns that result directly and
 * never calls `decide()` at all: a row that was never found was never measured against a rule, so
 * reaching decide() with a placeholder ownership would risk a `403` that asserts a check that did
 * not happen (ADR-0015 read the other way round from `refuse`'s own case in `decide.ts`).
 */
export type OwnershipOutcome =
  | { readonly kind: 'ownership'; readonly ownership: Ownership }
  | { readonly kind: 'refuse'; readonly result: ApiResult };

/**
 * Resolve the real ownership of the row a request names, once the caller's identity and a
 * workspace-scoped directory are both known.
 *
 * This exists because `decide()` needs `ownership` before a handler's own body runs — `authorise`
 * calls `decide()` and only then invokes `run` — so a handler that must READ THE ROW to answer
 * "own or other" cannot compute that value before calling `authorise`. A resolver defers the read
 * to the one point inside `authorise` where the caller's identity is already verified and no
 * verdict has been reached yet.
 */
export type OwnershipResolver = (
  principal: Principal,
  directory: WorkspaceDirectory,
) => Promise<OwnershipOutcome> | OwnershipOutcome;

/**
 * The call site. Every route handler of this task begins with it and none of them re-implements
 * any part of it.
 *
 * `ownership` is the handler's honest answer about whose row is being acted on: `not-applicable`
 * for a collection route, `own`/`other` where the handler has read the row, and `unknown` where it
 * has not. `unknown` denies for every grant narrower than `any`, which is the safe direction: a
 * route that has not established ownership cannot be given a permission that depends on it. It may
 * also be an {@link OwnershipResolver} — see that type's own comment — for a handler whose answer
 * depends on a row only the verified caller's workspace can read.
 */
export async function authorise(
  request: Request,
  ownership: Ownership | OwnershipResolver,
  run: (context: AuthorisedRequest) => Promise<ApiResult>,
): Promise<ApiResult> {
  const runtime = currentRbacRuntime();
  if (runtime === null) {
    return problem(
      503,
      'rbac_runtime_not_configured',
      'The users, memberships and API-key routes have no directory or identity resolver wired ' +
        'into them. This deployment cannot serve them; it is not that the request was rejected.',
    );
  }

  const principal = await runtime.identify(request);
  if (principal === null) {
    return problem(
      401,
      'unauthenticated',
      'This route requires a verified session cookie or an API key presented as ' +
        '"Authorization: Bearer ak_live_…".',
    );
  }

  const directory = runtime.directory.forWorkspace(principal.workspaceId);

  let resolvedOwnership: Ownership;
  if (typeof ownership === 'function') {
    const outcome = await ownership(principal, directory);
    if (outcome.kind === 'refuse') return outcome.result;
    resolvedOwnership = outcome.ownership;
  } else {
    resolvedOwnership = ownership;
  }

  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    // An unreadable URL is not a route this table can classify, and classifying it as anything
    // would be inventing the resource. Refused, by the same rule as an unclassified resource.
    return problem(
      500,
      'authorisation_undecidable',
      `The request URL ${JSON.stringify(request.url)} could not be read as a URL, so no route ` +
        `could be derived from it and no authorisation decision was made.`,
    );
  }

  const decision = decide({
    role: principal.role,
    method: request.method,
    path: pathname,
    ownership: resolvedOwnership,
    scope: principal.scope,
  });

  switch (decision.effect) {
    case 'allow':
      return run({ principal, directory, decision });
    case 'deny':
      return problem(403, decision.code ?? 'forbidden', decision.because);
    case 'refuse':
      return problem(
        500,
        'authorisation_undecidable',
        `${decision.because} No authorisation decision was made, so this request was neither ` +
          `allowed nor refused on its merits.`,
      );
    default: {
      const unreachable: never = decision;
      throw new Error(
        `unclassified decision ${JSON.stringify(unreachable)} — refusing to serve the request`,
      );
    }
  }
}

/** Read the `[id]` segment of a dynamic route without assuming it resolved to a string. */
export async function readIdParam(context: { params: Promise<{ id: string }> }): Promise<unknown> {
  const params: unknown = await context.params;
  if (typeof params !== 'object' || params === null) return undefined;
  return (params as Record<string, unknown>)['id'];
}
