import { jsonBodyResponse } from './json-transport';

/*
 * Every owned JSON route builds its `{ error: { code, message } }` envelope here. The deliberate
 * wire variants that do not:
 * - `surfaces/public`: public surface pages, which answer with HTML or a page-shaped body.
 * - `versioning/contracts-version.ts`: the 426 edge, which must answer before any domain loads.
 * - `cli-auth/verify-page.ts`: an HTML page for a browser, not a JSON client.
 * - `a2a/**`: JSON-RPC error objects, whose shape the protocol fixes.
 */

/** A status and a body, before either becomes an HTTP response. `body: null` means "no content". */
export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  /** Extra response headers, e.g. `retry-after` on a `429`. Only {@link noStoreResultResponse} reads them. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** The error envelope every failing route returns. One shape, so a client parses errors once. */
export interface ApiProblem {
  readonly error: {
    readonly code: string;
    readonly message: string;
    /** Present only when there is more to say than the message — e.g. per-field parse errors. */
    readonly details?: readonly string[];
    /** The RBAC family repeats `message` here until the next major release (ADR-0078 D7). */
    readonly detail?: string;
  };
}

/** Build a problem body. `details` is omitted rather than set to `undefined` (`exactOptionalPropertyTypes`). */
export function problemBody(
  code: string,
  message: string,
  details?: readonly string[],
): ApiProblem {
  const error =
    details === undefined || details.length === 0
      ? { code, message }
      : { code, message, details: [...details] };
  return { error };
}

/**
 * The `details` lines for a refused body: one `<dotted.path>: <message>` per Zod issue, `(root)`
 * for the body itself. Structural, because `apps/web` does not depend on `zod` directly.
 */
export function formatIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string[] {
  return issues.map(
    (issue) =>
      `${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')}: ${issue.message}`,
  );
}

/** Build a problem result. */
export function problem(
  status: number,
  code: string,
  message: string,
  details?: readonly string[],
): ApiResult {
  return { status, body: problemBody(code, message, details) };
}

/**
 * The RBAC family's envelope: `message` repeated as `detail` until the next major release, so a
 * reader written against the earlier `{ code, detail }` spelling keeps working (ADR-0078 D7).
 */
export function problemWithDetail(status: number, code: string, message: string): ApiResult {
  return { status, body: { error: { ...problemBody(code, message).error, detail: message } } };
}

/**
 * Turn a result into a `Response` that no shared cache may keep: these bodies are per-caller and
 * authorisation-dependent, which is as true of a 204 as of a body. A 204 or `null` body is a
 * body-less `Response` with no `content-type` (the constructor rejects a body on a 204).
 */
export function noStoreResultResponse(result: ApiResult): Response {
  const headers = { ...result.headers, 'cache-control': 'no-store' };
  if (result.status === 204 || result.body === null) {
    return new Response(null, { status: result.status, headers });
  }
  return jsonBodyResponse(result.status, result.body, headers);
}

/**
 * Bytes of request body the RBAC-family routes read. A user, a membership and an API key are each a
 * handful of short strings; anything larger is not one of them and does not need to be buffered to
 * find out.
 */
export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

const JSON_MEDIA_TYPE = 'application/json';

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
      result: problemWithDetail(
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
        result: problemWithDetail(
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
      result: problemWithDetail(
        400,
        'malformed_body',
        'The request body could not be read as UTF-8.',
      ),
    };
  }
  if (text.trim() === '') {
    return {
      ok: false,
      result: problemWithDetail(400, 'malformed_body', 'This route requires a JSON object body.'),
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      result: problemWithDetail(400, 'malformed_body', 'The request body is not valid JSON.'),
    };
  }
}
