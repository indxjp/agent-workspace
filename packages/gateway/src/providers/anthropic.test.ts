import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { runCompatibilitySuite } from '../../../../tests/providers/harness.js';
import { createRouter } from '../router.js';
import type { ModelInfo, RequestContext } from '../types.js';
import { createAnthropicProvider } from './anthropic.js';

type FixtureServer = {
  readonly url: string;
  readonly requests: string[];
  close(): Promise<void>;
};

const openServers: FixtureServer[] = [];

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(
    await readFile(
      new URL(`../../../../docs/research/fixtures/anthropic/${name}`, import.meta.url),
      'utf8',
    ),
  ) as T;
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function startFixtureServer(): Promise<FixtureServer> {
  const basic = await fixture<Record<string, unknown>>('messages-basic.response.json');
  const tool = await fixture<Record<string, unknown>>('messages-tool-use.response.json');
  const multiple = await fixture<Record<string, unknown>>(
    'messages-parallel-tool-use.response.json',
  );
  const errors = await fixture<{
    cases: { status: number; body: unknown; response_headers: Record<string, string> }[];
  }>('errors.json');
  const stream = await fixture<{ events: { event: string; data: unknown }[] }>('stream-basic.json');
  const requests: string[] = [];

  const server = createServer((incoming, response) => {
    void (async () => {
      const wire = await requestBody(incoming);
      requests.push(wire);
      const parsed = JSON.parse(wire) as Record<string, unknown>;
      const metadata = parsed['metadata'] as Record<string, unknown> | undefined;
      const scenario = metadata?.['compatibility_scenario'];

      expect(incoming.url).toBe('/v1/messages');
      expect(incoming.headers['anthropic-version']).toBe('2023-06-01');
      expect(['fixture-provider-key', 'compatibility-fixture-credential']).toContain(
        incoming.headers['x-api-key'],
      );

      if (scenario === 'streaming') {
        const body = stream.events
          .map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
          .join('');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(body);
        return;
      }
      if (scenario === 'tool-call') return sendJson(response, 200, tool);
      if (scenario === 'multiple-tool-calls') return sendJson(response, 200, multiple);
      if (scenario === 'errors') {
        const selected = errors.cases.find((candidate) => candidate.status === 429);
        if (selected === undefined) throw new Error('R-03 errors fixture has no 429 case');
        response.writeHead(selected.status, {
          'content-type': 'application/json',
          ...selected.response_headers,
        });
        response.end(JSON.stringify(selected.body));
        return;
      }
      sendJson(response, 200, basic);
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const result: FixtureServer = {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
  openServers.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function context(): RequestContext {
  return {
    providerId: 'anthropic',
    credential: 'fixture-provider-key',
    requestId: 'req_fixture',
    settings: {},
  };
}

describe('Anthropic provider', () => {
  it('passes all ten required §41 scenarios against R-03 fixtures', async () => {
    const fixtureServer = await startFixtureServer();
    const provider = createAnthropicProvider({ baseUrl: fixtureServer.url });
    const report = await runCompatibilitySuite(provider);

    expect(report.outcomes.slice(0, 10).map((outcome) => outcome.verdict)).toEqual(
      Array.from({ length: 10 }, () => 'native'),
    );
    expect(report.ok).toBe(true);
  });

  it('passes request bytes through createRouter and streams recorded event names in order', async () => {
    const fixtureServer = await startFixtureServer();
    const modelFixture = await fixture<{ data: ModelInfo[] }>('models-list.response.json');
    const provider = createAnthropicProvider({
      baseUrl: fixtureServer.url,
      models: modelFixture.data,
    });
    const router = createRouter([provider]);
    const recordedRequest = await fixture<Record<string, unknown>>('messages-basic.request.json');

    const response = await router.fetch(
      new Request('http://gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(recordedRequest),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(fixtureServer.requests).toEqual([JSON.stringify(recordedRequest)]);

    const streaming = await router.fetch(
      new Request('http://gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...recordedRequest,
          stream: true,
          metadata: { compatibility_scenario: 'streaming' },
        }),
      }),
      context(),
    );
    const recordedStream = await fixture<{ events: { event: string }[] }>('stream-basic.json');
    const names = [...(await streaming.text()).matchAll(/^event:\s*(.+)$/gm)].map(
      (match) => match[1],
    );
    expect(names).toEqual(recordedStream.events.map((event) => event.event));
  });

  it('forwards the open anthropic header list with context_management on message requests', async () => {
    let upstreamHeaders = new Headers();
    let upstreamBody: unknown;
    const provider = createAnthropicProvider({
      baseUrl: 'http://localhost:9999',
      fetch: (_input, init) => {
        upstreamHeaders = new Headers(init?.headers);
        if (typeof init?.body !== 'string') throw new Error('expected a JSON request body');
        upstreamBody = JSON.parse(init.body);
        return Promise.resolve(
          Response.json({
            id: 'msg_context_management',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      },
    });
    const body = {
      model: 'claude-opus-5',
      messages: [],
      context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
    };

    const response = await createRouter([provider]).fetch(
      new Request('http://gateway/v1/messages?beta=true', {
        method: 'POST',
        headers: {
          authorization: 'Bearer sandbox-run-token',
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'context-management-2025-06-27,context-1m-2025-08-07',
          'anthropic-future-capability': 'enabled',
        },
        body: JSON.stringify(body),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(upstreamBody).toEqual(body);
    expect(upstreamHeaders.get('anthropic-beta')).toBe(
      'context-management-2025-06-27,context-1m-2025-08-07',
    );
    expect(upstreamHeaders.get('anthropic-future-capability')).toBe('enabled');
    expect(upstreamHeaders.get('x-api-key')).toBe('fixture-provider-key');
    expect(upstreamHeaders.get('authorization')).toBeNull();
  });

  it('keeps the run trace headers inside the platform (F-04)', async () => {
    let upstreamHeaders = new Headers();
    const provider = createAnthropicProvider({
      baseUrl: 'http://localhost:9999',
      fetch: (_input, init) => {
        upstreamHeaders = new Headers(init?.headers);
        return Promise.resolve(
          Response.json({
            id: 'msg_trace',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      },
    });

    const response = await createRouter([provider]).fetch(
      new Request('http://gateway/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          tracestate: 'aw=1',
        },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(upstreamHeaders.get('traceparent')).toBeNull();
    expect(upstreamHeaders.get('tracestate')).toBeNull();
  });

  it('forwards context-management beta headers to token counting', async () => {
    let upstreamHeaders = new Headers();
    const provider = createAnthropicProvider({
      baseUrl: 'http://localhost:9999',
      fetch: (_input, init) => {
        upstreamHeaders = new Headers(init?.headers);
        return Promise.resolve(Response.json({ input_tokens: 7 }));
      },
    });

    const response = await createRouter([provider]).fetch(
      new Request('http://gateway/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-beta': 'context-management-2025-06-27',
        },
        body: JSON.stringify({
          model: 'claude-opus-5',
          messages: [],
          context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
        }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(upstreamHeaders.get('anthropic-beta')).toBe('context-management-2025-06-27');
    expect(upstreamHeaders.get('x-api-key')).toBe('fixture-provider-key');
  });

  it('passes the agent only the allowlisted upstream response headers', async () => {
    const provider = createAnthropicProvider({
      baseUrl: 'http://localhost:9999',
      fetch: () =>
        Promise.resolve(
          new Response('event: message_stop\ndata: {}\n\n', {
            headers: {
              'content-type': 'text/event-stream',
              'request-id': 'req_upstream',
              'set-cookie': 'session=upstream',
              'anthropic-organization-id': 'org_upstream',
              'anthropic-ratelimit-tokens-remaining': '1000',
            },
          }),
        ),
    });

    const response = await provider.createMessage(
      { model: 'claude-opus-5', max_tokens: 1, messages: [] },
      context(),
    );

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('request-id')).toBe('req_upstream');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('anthropic-organization-id')).toBeNull();
    expect(response.headers.get('anthropic-ratelimit-tokens-remaining')).toBeNull();
    await expect(response.text()).resolves.toContain('message_stop');
  });

  it('never discovers a provider credential from the process environment', async () => {
    const source = await readFile(new URL('./anthropic.ts', import.meta.url), 'utf8');
    expect(source).not.toContain(['process', 'env'].join('.'));
  });

  it('refuses a base URL that resolves to a link-local / cloud-metadata address (W9-PROV-127)', async () => {
    const provider = createAnthropicProvider({ baseUrl: 'https://169.254.169.254' });
    await expect(
      provider.createMessage({ model: 'claude-opus-5', messages: [] }, context()),
    ).rejects.toThrow(/Egress policy refused/);
  });

  it('refuses a redirect from the upstream instead of following it (W9-PROV-127)', async () => {
    // The redirect target below is a second *real, reachable* loopback server that answers 200 if
    // ever actually contacted. Pointing the redirect at a nonexistent domain instead (as this test
    // used to) would make it pass for the wrong reason: following a broken redirect also rejects
    // with a DNS failure even when the egress policy's redirect refusal is missing entirely. Only a
    // redirect target that would succeed if followed can tell the two apart.
    const targetRequests: string[] = [];
    const target = createServer((_request, response) => {
      targetRequests.push(_request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    openServers.push({
      url: '',
      requests: targetRequests,
      close: () => new Promise<void>((done) => target.close(() => done())),
    });
    await new Promise<void>((ready) => target.listen(0, '127.0.0.1', ready));
    const targetPort = (target.address() as AddressInfo).port;

    const server = createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${String(targetPort)}/v1/messages` });
      response.end();
    });
    openServers.push({
      url: '',
      requests: [],
      close: () => new Promise<void>((done) => server.close(() => done())),
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const { port } = server.address() as AddressInfo;
    const provider = createAnthropicProvider({ baseUrl: `http://127.0.0.1:${port}` });

    let caught: unknown;
    try {
      await provider.createMessage({ model: 'claude-opus-5', messages: [] }, context());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const cause = (caught as Error).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(/redirect/i);
    expect(targetRequests).toEqual([]);
  });
});
