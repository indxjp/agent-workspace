import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { createRouter } from './router.js';
import { createGatewayServer, MAX_BODY_BYTES } from './server.js';
import type { ModelCapabilities, ModelProvider, RequestContext } from './types.js';

const capabilities: ModelCapabilities = {
  streaming: true,
  toolUse: true,
  thinking: false,
  promptCaching: false,
  structuredOutput: false,
  contextManagement: false,
  webSearch: false,
  tokenCounting: true,
};

const provider: ModelProvider = {
  id: 'stub',
  capabilities,
  listModels() {
    return Promise.resolve([
      {
        id: 'stub-model',
        type: 'model',
        display_name: 'Stub model',
        created_at: '2026-09-08T00:00:00Z',
      },
    ]);
  },
  createMessage(request, context) {
    return Promise.resolve(Response.json({ model: request.model, request_id: context.requestId }));
  },
  countTokens() {
    return Promise.resolve({ input_tokens: 7 });
  },
};

const context: RequestContext = {
  providerId: 'stub',
  credential: 'server-test-credential',
  requestId: 'server-test-request',
  settings: {},
};

const openServers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        }),
    ),
  );
});

async function listen(server: ReturnType<typeof createHttpServer>): Promise<string> {
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

async function rawPost(
  url: string,
  headers: Readonly<Record<string, string>>,
  body?: Buffer,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpRequest(url, { method: 'POST', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        settled = true;
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        });
      });
    });
    request.on('error', (error) => {
      if (!settled) reject(error);
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

describe('Node gateway server', () => {
  it('serves the health route through the Fetch-style router', async () => {
    const baseUrl = await listen(createGatewayServer(createRouter([])));
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('injects resolved context into provider requests', async () => {
    const baseUrl = await listen(createGatewayServer(createRouter([provider]), () => context));
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [] }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      model: 'stub-model',
      request_id: context.requestId,
    });
  });

  it.each([{}, { model: '' }, { model: 42 }])(
    'rejects a malformed gateway request before calling a provider (%j)',
    async (body) => {
      const baseUrl = await listen(createGatewayServer(createRouter([provider]), () => context));
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        type: 'error',
        error: { type: 'invalid_request_error' },
      });
    },
  );

  it('preflights an excessive Content-Length and returns a typed 413', async () => {
    let resolved = false;
    const baseUrl = await listen(
      createGatewayServer(createRouter([]), () => {
        resolved = true;
        return undefined;
      }),
    );
    const response = await rawPost(`${baseUrl}/v1/messages`, {
      'content-type': 'application/json',
      'content-length': String(MAX_BODY_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      type: 'error',
      error: { type: 'request_too_large' },
    });
    expect(resolved).toBe(false);
  });

  it('retains the byte limit for chunked bodies without Content-Length', async () => {
    const baseUrl = await listen(createGatewayServer(createRouter([])));
    const response = await rawPost(
      `${baseUrl}/v1/messages`,
      { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      Buffer.alloc(MAX_BODY_BYTES + 1, 0x20),
    );

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      type: 'error',
      error: { type: 'request_too_large' },
    });
  });

  it.each([
    ['plain', undefined, (body: Buffer) => body],
    ['gzip', 'gzip', gzipSync],
    ['brotli', 'br', brotliCompressSync],
  ] as const)(
    'bridges %s JSON after Fetch representation decoding',
    async (path, encoding, encode) => {
      const expected = Buffer.from(JSON.stringify({ path, ok: true }));
      const upstream = await listen(
        createHttpServer((_request, response) => {
          const body = encode(expected);
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json');
          response.setHeader('content-length', String(body.byteLength));
          if (encoding !== undefined) response.setHeader('content-encoding', encoding);
          response.end(body);
        }),
      );
      const bridgeProvider: ModelProvider = {
        ...provider,
        createMessage(_request, requestContext) {
          return fetch(upstream, requestContext.signal ? { signal: requestContext.signal } : {});
        },
      };
      const baseUrl = await listen(
        createGatewayServer(createRouter([bridgeProvider]), () => context),
      );
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'stub-model', messages: [] }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(response.headers.get('content-length')).toBeNull();
      await expect(response.json()).resolves.toEqual({ path, ok: true });
    },
  );

  it('preserves an upstream error status while removing stale representation headers', async () => {
    const expected = Buffer.from(JSON.stringify({ error: { type: 'rate_limit_error' } }));
    const upstream = await listen(
      createHttpServer((_request, response) => {
        const body = brotliCompressSync(expected);
        response.statusCode = 429;
        response.setHeader('content-type', 'application/json');
        response.setHeader('content-encoding', 'br');
        response.setHeader('content-length', String(body.byteLength));
        response.end(body);
      }),
    );
    const bridgeProvider: ModelProvider = {
      ...provider,
      createMessage(_request, requestContext) {
        return fetch(upstream, requestContext.signal ? { signal: requestContext.signal } : {});
      },
    };
    const baseUrl = await listen(
      createGatewayServer(createRouter([bridgeProvider]), () => context),
    );
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [] }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: { type: 'rate_limit_error' } });
  });

  it('streams SSE deltas before the upstream response finishes', async () => {
    const pauseMs = 300;
    const upstream = await listen(
      createHttpServer((_request, response) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'text/event-stream');
        response.flushHeaders();
        response.write('data: first\n\n');
        void delay(pauseMs).then(() => response.end('data: second\n\n'));
      }),
    );
    const bridgeProvider: ModelProvider = {
      ...provider,
      createMessage(_request, requestContext) {
        return fetch(upstream, requestContext.signal ? { signal: requestContext.signal } : {});
      },
    };
    const baseUrl = await listen(
      createGatewayServer(createRouter([bridgeProvider]), () => context),
    );
    const started = performance.now();
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [] }),
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader!.read();
    const firstAt = performance.now() - started;
    const second = await reader!.read();
    const secondAt = performance.now() - started;

    expect(Buffer.from(first.value ?? []).toString()).toContain('data: first');
    expect(firstAt).toBeLessThan(pauseMs);
    expect(Buffer.from(second.value ?? []).toString()).toContain('data: second');
    expect(secondAt).toBeGreaterThanOrEqual(pauseMs - 40);
  });
  it('aborts the upstream call when the client hangs up mid-stream', async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
    const upstream = await listen(
      createHttpServer((_request, response) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'text/event-stream');
        response.flushHeaders();
        response.write('data: first\n\n');
        response.once('close', upstreamClosed);
      }),
    );
    // The production server is started without a context resolver: the provider sees only
    // `request.signal`. The body is teed like the streamed usage capture in `auth.ts`, whose
    // still-reading branch keeps the upstream open after the forwarded branch is cancelled.
    const router = {
      routes: [],
      async fetch(request: Request) {
        const upstreamResponse = await fetch(upstream, { signal: request.signal });
        const [forward, capture] = upstreamResponse.body!.tee();
        void new Response(capture).text().catch(() => undefined);
        return new Response(forward, { headers: upstreamResponse.headers });
      },
    };
    const baseUrl = await listen(createGatewayServer(router));
    const client = new AbortController();
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      body: '{}',
      signal: client.signal,
    });
    await response.body?.getReader().read();
    client.abort();

    await expect(closed).resolves.toBeUndefined();
  });
});
