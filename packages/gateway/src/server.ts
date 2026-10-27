import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  createJsonLogger,
  parseTraceparent,
  traceHeaders,
  type Logger,
} from '@agent-workspace/core/telemetry';
import { inServerSpan, SpanStatusCode } from '@agent-workspace/core/tracing';

import type { GatewayRouter, RequestContext } from './types.js';

export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * The longest one gateway request may hold its upstream call open, streamed or not. Ten minutes is
 * the Anthropic SDK's own default request timeout, so a call the SDK would not abandon is not
 * abandoned here either; a hung upstream no longer holds a connection forever.
 */
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

class RequestBodyTooLargeError extends Error {}

export type RequestContextResolver = (
  request: Request,
) => Promise<RequestContext | undefined> | RequestContext | undefined;

async function requestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;

  const declared = req.headers['content-length'];
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
    throw new RequestBodyTooLargeError();
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Join the caller's W3C trace, or start a fresh one (F-04). The direct caller is the agent sandbox,
 * whose code can send any trace id it likes, so an adopted id is for log correlation only and is
 * never trusted for anything else. A well-formed `traceparent` (normally the one the runner passed
 * the engine) is kept, rebuilt from its parsed fields, with its `tracestate`. Anything else is
 * replaced by a new random trace and its `tracestate` dropped, so every request the router sees
 * carries exactly one valid `traceparent` and nothing a caller wrote unvalidated. A fresh trace is
 * marked sampled: the gateway is its root, so its span is the one to record. Returns the adopted
 * trace id.
 */
export function adoptTrace(headers: Headers): string {
  const joined = traceHeaders(headers.get('traceparent'), headers.get('tracestate'));
  headers.delete('tracestate');
  const traceparent =
    joined['traceparent'] ??
    `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
  headers.set('traceparent', traceparent);
  if (joined['tracestate'] !== undefined) headers.set('tracestate', joined['tracestate']);
  // Cannot be null: the header was just set to a valid value.
  return parseTraceparent(traceparent)?.traceId ?? '';
}

function requestUrl(req: IncomingMessage): URL {
  const authority = req.headers.host ?? 'gateway';
  return new URL(req.url ?? '/', `http://${authority}`);
}

async function toRequest(req: IncomingMessage, signal: AbortSignal): Promise<Request> {
  const body = await requestBody(req);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  adoptTrace(headers);
  const init: RequestInit = {
    method: req.method ?? 'GET',
    headers,
    signal,
  };
  if (body !== undefined) init.body = body;
  return new Request(requestUrl(req), init);
}

const STRIPPED_RESPONSE_HEADERS = new Set([
  // Node's Fetch implementation decodes gzip/br/deflate response bodies while retaining the
  // upstream representation headers. Forwarding either header makes the downstream client decode
  // already-decoded bytes or wait for a length that can no longer be true.
  'content-encoding',
  'content-length',
  // Hop-by-hop headers describe the upstream connection, never this one.
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
  });
  if (response.body === null) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), res);
}

function internalError(): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'gateway_internal_error', message: 'The gateway request failed.' },
      request_id: `gateway_${crypto.randomUUID()}`,
    }),
    { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

function requestTooLarge(): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'request_too_large',
        message: `Request body exceeds the ${String(MAX_BODY_BYTES)} byte limit.`,
      },
      request_id: `gateway_${crypto.randomUUID()}`,
    }),
    { status: 413, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

/**
 * `router.fetch` inside the request's SERVER span (ADR-0155), continuing the trace {@link adoptTrace}
 * set, so the span and the request's log lines share one trace id. The span names the route only
 * when it is one of the router's fixed paths; it never carries the URL, a header or the body.
 */
export function fetchInSpan(
  router: GatewayRouter,
  request: Request,
  context?: RequestContext,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route = router.routes.find((candidate) => candidate.path === pathname)?.path;
  return inServerSpan(
    `${request.method} ${route ?? 'other'}`,
    request.headers.get('traceparent'),
    {
      'http.request.method': request.method,
      ...(route === undefined ? {} : { 'http.route': route }),
    },
    async (span) => {
      const response = await router.fetch(request, context);
      span.setAttribute('http.response.status_code', response.status);
      if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      return response;
    },
  );
}

/** `logger` joined to the trace `request` carries, once {@link adoptTrace} has run on it. */
export function requestLogger(logger: Logger, request: Request | undefined): Logger {
  const trace = parseTraceparent(request?.headers.get('traceparent'));
  return trace === null ? logger : logger.child({ traceId: trace.traceId });
}

/**
 * Adapt the Fetch-style gateway router to Node HTTP. Context resolution is injected so this
 * server has no credential store and never falls back to the process environment.
 */
export function createGatewayServer(
  router: GatewayRouter,
  resolveContext: RequestContextResolver = () => undefined,
  logger: Logger = createJsonLogger({ service: 'gateway' }),
): Server {
  return createServer((incoming, outgoing) => {
    // A client hang-up or the upstream timeout aborts `request.signal`, which every provider passes
    // to its upstream `fetch`; that errors the upstream body, so a streamed usage capture stops too.
    const hangUp = new AbortController();
    incoming.once('aborted', () => hangUp.abort());
    outgoing.once('close', () => hangUp.abort());
    const signal = AbortSignal.any([hangUp.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
    void (async () => {
      let request: Request | undefined;
      try {
        request = await toRequest(incoming, signal);
        const resolved = await resolveContext(request);
        const context = resolved === undefined ? undefined : { ...resolved, signal };
        await writeResponse(outgoing, await fetchInSpan(router, request, context));
      } catch (error) {
        if (outgoing.headersSent || outgoing.destroyed) {
          outgoing.destroy();
        } else if (error instanceof RequestBodyTooLargeError) {
          await writeResponse(outgoing, requestTooLarge());
        } else {
          requestLogger(logger, request).error('gateway request failed', { error });
          await writeResponse(outgoing, internalError());
        }
      }
    })();
  });
}
