import type { IncomingMessage, ServerResponse } from 'node:http';

/** A run request is a JSON object of bounded size. 1 MiB is far more than `RunRequest` can need. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * R-13's three headers, and only three. `Content-Encoding: none`, `Connection: keep-alive` and
 * `X-Content-Type-Options: nosniff` were each removed from that note's contract for a stated
 * reason; do not add them back here without reading the omitted-headers table.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
};

const JSON_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

// ── Small HTTP helpers ──────────────────────────────────────────────────────────────────

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': String(payload.byteLength) });
  res.end(payload);
}

/** A refusal that names itself: a stable machine code, and a sentence a human can act on. */
export function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  message: string,
): void {
  sendJson(res, status, { error, message });
}

export function sendMethodNotAllowed(res: ServerResponse, path: string, allow: string): void {
  if (res.headersSent) return;
  const payload = Buffer.from(
    JSON.stringify({
      error: 'method_not_allowed',
      message: `${path} accepts ${allow} only (spec §14.3).`,
    }),
    'utf8',
  );
  res.writeHead(405, {
    ...JSON_HEADERS,
    Allow: allow,
    'Content-Length': String(payload.byteLength),
  });
  res.end(payload);
}

type BodyResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly message: string;
    };

/**
 * Read a bounded request body and parse it as a JSON object.
 *
 * Every failure arm is explicit and none of them falls through to "assume `{}`": an empty body, a
 * body that is not JSON, and a body that is JSON but not an object are three different mistakes
 * and are reported as three different messages. A `RunRequest` built from a silently defaulted
 * body is exactly the run this platform must not start.
 */
export async function readJsonObject(req: IncomingMessage): Promise<BodyResult> {
  const raw = await new Promise<Buffer | 'too-large'>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(overflowed ? 'too-large' : Buffer.concat(chunks));
    });
    req.on('error', (error: Error) => {
      reject(error);
    });
  });

  if (raw === 'too-large') {
    return {
      ok: false,
      status: 413,
      error: 'body_too_large',
      message: `the request body exceeds ${String(MAX_BODY_BYTES)} bytes.`,
    };
  }
  if (raw.byteLength === 0) {
    return {
      ok: false,
      status: 400,
      error: 'empty_body',
      message: 'the request body is empty; a JSON RunRequest object is required.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_json',
      message: `the request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_body',
      message: 'the request body must be a JSON object.',
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

// ── SSE framing ─────────────────────────────────────────────────────────────────────────

/**
 * One frame. `id` is monotonic within the stream and is the resume cursor a relay seeks to;
 * `JSON.stringify` is what guarantees `data` contains no raw newline, which HTML §9.2 would
 * otherwise read as a second `data:` line.
 */
export function sseFrame(name: string, id: number, data: unknown): string {
  return `event: ${name}\nid: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Write one chunk, respecting backpressure.
 *
 * Resolves on `drain` when the socket buffer is full, and on `close` when it will never drain
 * because the client went away — without the second listener a disconnected slow consumer parks
 * this run forever on a promise nothing will settle.
 */
export function writeChunk(res: ServerResponse, chunk: string): Promise<void> {
  if (res.writableEnded || res.destroyed) return Promise.resolve();
  if (res.write(chunk)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}
