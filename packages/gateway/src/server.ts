import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
 * Adapt the Fetch-style gateway router to Node HTTP. Context resolution is injected so this
 * server has no credential store and never falls back to the process environment.
 */
export function createGatewayServer(
  router: GatewayRouter,
  resolveContext: RequestContextResolver = () => undefined,
): Server {
  return createServer((incoming, outgoing) => {
    // A client hang-up or the upstream timeout aborts `request.signal`, which every provider passes
    // to its upstream `fetch`; that errors the upstream body, so a streamed usage capture stops too.
    const hangUp = new AbortController();
    incoming.once('aborted', () => hangUp.abort());
    outgoing.once('close', () => hangUp.abort());
    const signal = AbortSignal.any([hangUp.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
    void (async () => {
      try {
        const request = await toRequest(incoming, signal);
        const resolved = await resolveContext(request);
        const context = resolved === undefined ? undefined : { ...resolved, signal };
        await writeResponse(outgoing, await router.fetch(request, context));
      } catch (error) {
        if (outgoing.headersSent || outgoing.destroyed) {
          outgoing.destroy();
        } else {
          await writeResponse(
            outgoing,
            error instanceof RequestBodyTooLargeError ? requestTooLarge() : internalError(),
          );
        }
      }
    })();
  });
}
