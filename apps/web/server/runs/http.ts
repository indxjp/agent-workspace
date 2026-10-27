/**
 * The small HTTP helpers the three §34 run routes share.
 *
 * Deliberately tiny and deliberately not a framework (§53, §40): four functions, no router, no
 * middleware chain, no validation library. Spec §34 says "Do not invent RPC frameworks if
 * ordinary HTTP is enough", and for three routes it is.
 */

import { problemBody } from '../http/result';

export function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  details?: readonly string[],
): Response {
  return json(problemBody(code, message, details), status);
}

/**
 * RFC 9562 canonical textual form, any version. Route parameters are client-controlled strings
 * and every id in this platform is a `uuid` column, so an id is parsed before it is looked up —
 * never passed through to a store to see what happens.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** The result of reading a JSON request body. Total: no arm returns a partially parsed value. */
export type JsonBodyResult =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * The largest JSON request body a run route will read.
 *
 * Comfortably above `MAX_PROMPT_CHARS` (`service.ts`) worth of escaped UTF-8 and far below
 * anything worth buffering. An App Router route handler has no body limit of its own, so without
 * this the prompt cap `parseStartRunBody` applies would only be enforced *after* the whole body had been read into memory — a cap
 * that arrives too late to be one.
 */
export const MAX_JSON_BODY_BYTES = 2_000_000;

type TextBodyResult =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Read a request body as text, refusing anything over `max` bytes **while reading**.
 *
 * The limit is enforced on bytes seen, not on `Content-Length`. A header is a claim; a check that
 * relies on it silently does nothing when the header is absent, which is the ADR-0015 shape.
 */
async function readBoundedText(request: Request, max: number): Promise<TextBodyResult> {
  const body = request.body;
  if (body === null) return { kind: 'ok', text: '' };
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) {
        return {
          kind: 'rejected',
          reason: `the request body exceeds ${String(max)} bytes`,
        };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { kind: 'ok', text };
  } catch {
    return { kind: 'rejected', reason: 'the request body could not be read' };
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read and parse a JSON request body.
 *
 * A missing or wrong `Content-Type` is rejected rather than sniffed: a check that cannot
 * positively identify JSON has not identified JSON.
 */
export async function readJsonBody(request: Request): Promise<JsonBodyResult> {
  const contentType = request.headers.get('content-type');
  if (contentType === null) {
    return {
      kind: 'rejected',
      reason: 'the request carried no Content-Type; send application/json',
    };
  }
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mime !== 'application/json') {
    return {
      kind: 'rejected',
      reason: `the request Content-Type is ${JSON.stringify(contentType)}, not application/json`,
    };
  }
  const read = await readBoundedText(request, MAX_JSON_BODY_BYTES);
  if (read.kind !== 'ok') return read;
  try {
    return { kind: 'ok', value: JSON.parse(read.text) };
  } catch {
    return { kind: 'rejected', reason: 'the request body is not valid JSON.' };
  }
}
