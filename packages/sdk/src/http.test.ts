import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AgentPolicy } from '@indx-workspace/contracts/agents';
import type { AgentVersionDraftInput } from '@indx-workspace/contracts/agent-versions';

import {
  AgentWorkspaceError,
  ApiProblemError,
  ContractViolationError,
  InvalidArgumentError,
  TransportError,
} from './errors.js';
import { HttpClient, resolveApiUrl, segment } from './http.js';
import { createClient, type AgentWorkspaceClient } from './index.js';
import { fetchDouble, fixtures, jsonResponse, type RecordedRequest } from './testing.js';

const Echo = z.object({ ok: z.literal(true) }).strict();

function sessionClient(fetchImpl: typeof fetch): HttpClient {
  return new HttpClient({ baseUrl: 'https://x', auth: { kind: 'session' }, fetch: fetchImpl });
}

const echo = (client: HttpClient, signal?: AbortSignal) =>
  client.json({
    operation: 'echo',
    method: 'GET',
    path: '/api/echo',
    expect: [200],
    schema: Echo,
    signal,
  });

describe('resolveApiUrl', () => {
  it('keeps a base path prefix and never doubles a slash', () => {
    expect(resolveApiUrl('https://aw.example.com', '/api/agents').href).toBe(
      'https://aw.example.com/api/agents',
    );
    expect(resolveApiUrl('https://aw.example.com/tenant-a/', '/api/agents').href).toBe(
      'https://aw.example.com/tenant-a/api/agents',
    );
    const query = new URLSearchParams({ limit: '5' });
    expect(resolveApiUrl(new URL('http://localhost:3000'), '/api/runs', query).href).toBe(
      'http://localhost:3000/api/runs?limit=5',
    );
  });
});

describe('HttpClient', () => {
  it('sends an API key as a bearer token, JSON headers, and the caller headers', async () => {
    const api = fetchDouble(() => jsonResponse(200, { ok: true }));
    const client = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_key' },
      fetch: api.fetch,
      headers: { 'x-trace-id': 'trace-1' },
    });
    await client.json({
      operation: 'echo',
      method: 'POST',
      path: '/api/echo',
      body: { hello: 'world' },
      expect: [200],
      schema: Echo,
    });
    const [call] = api.calls;
    expect(call?.url.href).toBe('https://aw.example.com/api/echo');
    expect(call?.headers.get('authorization')).toBe('Bearer ak_live_key');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.headers.get('accept')).toBe('application/json');
    expect(call?.headers.get('x-trace-id')).toBe('trace-1');
    expect(call?.json).toEqual({ hello: 'world' });
    expect(call?.init.credentials).toBeUndefined();
  });

  it('sends cookies and no Authorization for a session client', async () => {
    const api = fetchDouble(() => jsonResponse(200, { ok: true }));
    await echo(sessionClient(api.fetch));
    const [call] = api.calls;
    expect(call?.headers.has('authorization')).toBe(false);
    expect(call?.init.credentials).toBe('include');
    expect(call?.init.body).toBeUndefined();
  });

  it('sends a raw body as-is, with the caller headers and no JSON content-type of its own', async () => {
    const api = fetchDouble(() => jsonResponse(201, { ok: true }));
    const bytes = new Blob([new Uint8Array([1, 2, 3])]);
    await sessionClient(api.fetch).json({
      operation: 'upload',
      method: 'POST',
      path: '/api/files',
      rawBody: bytes,
      headers: { 'x-file-path': 'a.bin' },
      expect: [201],
      schema: Echo,
    });
    const [call] = api.calls;
    expect(call?.init.body).toBe(bytes);
    expect(call?.headers.get('content-type')).toBeNull();
    expect(call?.headers.get('x-file-path')).toBe('a.bin');
    expect(call?.json).toBeUndefined();
  });

  it('turns the platform envelope into an ApiProblemError with status, code and Retry-After', async () => {
    const api = fetchDouble(() =>
      jsonResponse(
        429,
        { error: { code: 'rate_limited', message: 'Slow down.', details: ['a'] } },
        { 'retry-after': '7' },
      ),
    );
    const failure = await echo(sessionClient(api.fetch)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiProblemError);
    const problem = failure as ApiProblemError;
    expect(problem.status).toBe(429);
    expect(problem.code).toBe('rate_limited');
    expect(problem.message).toBe('Slow down.');
    expect(problem.details).toEqual(['a']);
    expect(problem.retryAfterSeconds).toBe(7);
  });

  it.each([
    ['a message-only body', { code: 'last_owner', message: 'The last owner cannot leave.' }],
    ['a detail-only body', { code: 'last_owner', detail: 'The last owner cannot leave.' }],
    [
      'a body carrying both spellings',
      {
        code: 'last_owner',
        message: 'The last owner cannot leave.',
        detail: 'The last owner cannot leave.',
      },
    ],
  ])('reads %s into the same code and message', async (_name, error) => {
    const api = fetchDouble(() => jsonResponse(409, { error }));
    const failure = await echo(sessionClient(api.fetch)).catch((thrown: unknown) => thrown);
    expect(failure).toBeInstanceOf(ApiProblemError);
    const problem = failure as ApiProblemError;
    expect(problem.status).toBe(409);
    expect(problem.code).toBe('last_owner');
    expect(problem.message).toBe('The last owner cannot leave.');
    expect(problem.details).toEqual([]);
  });

  it('reads the code of an envelope from a newer server that added fields to it', async () => {
    const api = fetchDouble(() =>
      jsonResponse(409, {
        error: { code: 'last_owner', message: 'The last owner cannot leave.', requestId: 'r-1' },
        traceId: 't-1',
      }),
    );
    const failure = await echo(sessionClient(api.fetch)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('last_owner');
    expect((failure as ApiProblemError).message).toBe('The last owner cannot leave.');
  });

  it('reads the bare-code envelope of runtimes/test, and of audit-events on an older deployment', async () => {
    const api = fetchDouble(() => jsonResponse(400, { error: 'invalid_limit' }));
    const failure = await echo(sessionClient(api.fetch)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('invalid_limit');
    expect((failure as ApiProblemError).message).toBe('');
    expect((failure as ApiProblemError).status).toBe(400);
  });

  it('names a non-envelope failure body rather than guessing a code', async () => {
    const api = fetchDouble(() => new Response('<html>502</html>', { status: 502 }));
    const failure = await echo(sessionClient(api.fetch)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('unrecognised_error_body');
    expect((failure as ApiProblemError).status).toBe(502);
  });

  it('refuses a successful body the contract does not accept', async () => {
    const api = fetchDouble(() => jsonResponse(200, { ok: 'yes' }));
    const failure = await echo(sessionClient(api.fetch)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).issues[0]).toContain('ok');
  });

  it('treats an unexpected success status as a problem, never as a value', async () => {
    const api = fetchDouble(() => jsonResponse(200, { ok: true }));
    const failure = await sessionClient(api.fetch)
      .json({ operation: 'create', method: 'POST', path: '/api/x', expect: [201], schema: Echo })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(200);
  });

  it('yields null for a 204 and wraps a network failure as a TransportError', async () => {
    const empty = fetchDouble(() => jsonResponse(204, null));
    await expect(
      sessionClient(empty.fetch).json({
        operation: 'rm',
        method: 'DELETE',
        path: '/api/x',
        expect: [204],
        schema: z.null(),
      }),
    ).resolves.toBeNull();

    const broken = fetchDouble(() => Promise.reject(new TypeError('fetch failed')));
    const failure = await echo(sessionClient(broken.fetch)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(false);
    expect((failure as TransportError).cause).toBeInstanceOf(TypeError);
  });

  it('names the network failure behind a TransportError in its message (BH061-039)', () => {
    const refused = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    const failure = new TransportError({
      operation: 'agents.list',
      aborted: false,
      cause: new TypeError('fetch failed', { cause: refused }),
    });
    expect(failure.message).toBe(
      'agents.list: the request could not be completed (fetch failed: ECONNREFUSED)',
    );
    expect(
      new TransportError({ operation: 'runs.get', aborted: false, cause: 'opaque' }).message,
    ).toBe('runs.get: the request could not be completed');
  });

  it('refuses a baseUrl without an http(s) scheme when the client is built (BH061-039)', () => {
    for (const baseUrl of ['localhost:3000', 'aw.example.com', 'ftp://aw.example.com']) {
      expect(() => new HttpClient({ baseUrl, auth: { kind: 'session' } })).toThrow(
        /baseUrl must be an absolute http\(s\) URL/u,
      );
    }
  });

  it('applies timeoutMs to the response headers and never to a body that is still open', async () => {
    const encoder = new TextEncoder();
    // A fetch that behaves like the real one: the signal rejects the request before headers and
    // errors the body after them. An aborted body would end this stream after 2 of 4 chunks.
    const api = fetchDouble((request) => {
      const signal = request.init.signal;
      if (signal === undefined || signal === null) throw new Error('no signal');
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          signal.addEventListener('abort', () => {
            controller.error(signal.reason);
          });
          for (const chunk of ['a', 'b', 'c', 'd']) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    });
    const client = new HttpClient({
      baseUrl: 'https://x',
      auth: { kind: 'session' },
      fetch: api.fetch,
      timeoutMs: 15,
    });
    const response = await client.send({
      operation: 'stream',
      method: 'GET',
      path: '/api/stream',
      expect: [200],
    });
    await expect(response.text()).resolves.toBe('abcd');
  });

  it('reports a request that produced no headers within timeoutMs as an aborted transport failure', async () => {
    const api = fetchDouble(
      (request) =>
        new Promise((_, reject) => {
          const signal = request.init.signal;
          signal?.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
          });
        }),
    );
    const client = new HttpClient({
      baseUrl: 'https://x',
      auth: { kind: 'session' },
      fetch: api.fetch,
      timeoutMs: 5,
    });
    const failure = await echo(client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect((failure as TransportError).cause).toBeInstanceOf(DOMException);
    expect(((failure as TransportError).cause as DOMException).name).toBe('TimeoutError');
  });

  it('reports an abort as aborted and passes the signal to fetch', async () => {
    const controller = new AbortController();
    const api = fetchDouble((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    controller.abort();
    const failure = await echo(sessionClient(api.fetch), controller.signal).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });
});

describe('browser-token auth (issue #236, SDK-04, S-1)', () => {
  it('sends the token as a bearer and never sets credentials: include', async () => {
    const api = fetchDouble(() => jsonResponse(200, { ok: true }));
    const client = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'browser-token', token: 'awt_live_token' },
      fetch: api.fetch,
    });
    await echo(client);
    const [call] = api.calls;
    expect(call?.headers.get('authorization')).toBe('Bearer awt_live_token');
    expect(call?.init.credentials).toBeUndefined();
  });
});

describe('access-token auth (ADR-0161)', () => {
  const ACCESS_TOKEN = `awo_live_${'a'.repeat(22)}_${'b'.repeat(43)}`;

  it('sends the exchanged token as a bearer and never sets credentials: include', async () => {
    const api = fetchDouble(() => jsonResponse(200, { ok: true }));
    const client = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'access-token', token: ACCESS_TOKEN },
      fetch: api.fetch,
    });
    await echo(client);
    const [call] = api.calls;
    expect(call?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call?.init.credentials).toBeUndefined();
    expect(client.authKind).toBe('access-token');
  });

  it('is bound to one workspace, so ClientOptions.workspace is refused', () => {
    expect(
      () =>
        new HttpClient({
          baseUrl: 'https://x',
          auth: { kind: 'access-token', token: ACCESS_TOKEN },
          workspace: 'acme',
        }),
    ).toThrow(/session/u);
  });
});

describe('ClientOptions.workspace (issue #236, SDK-04, S-2)', () => {
  it('rejects at construction for any auth kind other than session', () => {
    expect(
      () =>
        new HttpClient({
          baseUrl: 'https://x',
          auth: { kind: 'api-key', apiKey: 'ak_live_key' },
          workspace: 'acme',
        }),
    ).toThrow(/session/u);
    expect(
      () =>
        new HttpClient({
          baseUrl: 'https://x',
          auth: { kind: 'browser-token', token: 'awt_live_token' },
          workspace: 'acme',
        }),
    ).toThrow(/session/u);
    expect(
      () => new HttpClient({ baseUrl: 'https://x', auth: { kind: 'session' }, workspace: 'acme' }),
    ).not.toThrow();
  });

  it('switches the workspace once before the first request, then proceeds', async () => {
    const calls: string[] = [];
    const api = fetchDouble((request) => {
      calls.push(request.url.pathname);
      if (request.url.pathname === '/api/auth/workspace') {
        expect(request.method).toBe('POST');
        expect(request.headers.get('content-type')).toBe('application/json');
        expect(request.json).toEqual({ workspace: 'acme' });
        expect(request.init.credentials).toBe('include');
        return jsonResponse(200, { workspace: { id: 'ws-a' } });
      }
      return jsonResponse(200, { ok: true });
    });
    const client = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      workspace: 'acme',
      fetch: api.fetch,
    });
    await echo(client);
    expect(calls).toEqual(['/api/auth/workspace', '/api/echo']);
  });

  it('runs the switch exactly once under concurrent first calls', async () => {
    let switches = 0;
    const api = fetchDouble((request) => {
      if (request.url.pathname === '/api/auth/workspace') {
        switches += 1;
        return jsonResponse(200, { workspace: { id: 'ws-a' } });
      }
      return jsonResponse(200, { ok: true });
    });
    const client = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      workspace: 'acme',
      fetch: api.fetch,
    });
    await Promise.all([echo(client), echo(client), echo(client)]);
    expect(switches).toBe(1);
  });

  it('a failed switch surfaces as an ApiProblemError and blocks the request it gated', async () => {
    const api = fetchDouble((request) =>
      request.url.pathname === '/api/auth/workspace'
        ? jsonResponse(404, { error: { code: 'workspace_not_available', message: 'no' } })
        : jsonResponse(200, { ok: true }),
    );
    const client = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      workspace: 'no-such-workspace',
      fetch: api.fetch,
    });
    await expect(echo(client)).rejects.toBeInstanceOf(ApiProblemError);
  });

  it('retries the switch after a transient failure instead of caching the rejection', async () => {
    let switches = 0;
    const api = fetchDouble((request) => {
      if (request.url.pathname !== '/api/auth/workspace') return jsonResponse(200, { ok: true });
      switches += 1;
      return switches === 1
        ? jsonResponse(503, { error: { code: 'unavailable', message: 'try again' } })
        : jsonResponse(200, { workspace: { id: 'ws-a' } });
    });
    const client = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      workspace: 'acme',
      fetch: api.fetch,
    });

    // Memoising the rejected promise would permanently brick the client: every later request
    // would re-throw this first error and the switch would never be attempted again.
    await expect(echo(client)).rejects.toBeInstanceOf(ApiProblemError);
    await expect(echo(client)).resolves.toEqual({ ok: true });
    expect(switches).toBe(2);

    // Still memoised on success — the third call adds no fourth switch.
    await echo(client);
    expect(switches).toBe(2);
  });

  it('surfaces a dropped connection on the switch as a TransportError, not a raw TypeError', async () => {
    const api = fetchDouble((request) =>
      request.url.pathname === '/api/auth/workspace'
        ? Promise.reject(new TypeError('fetch failed'))
        : jsonResponse(200, { ok: true }),
    );
    const client = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      workspace: 'acme',
      fetch: api.fetch,
    });

    const failure = await echo(client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransportError);
    // Named for the request that actually failed, not for the caller's `echo`.
    expect((failure as TransportError).message).toContain('workspaces.select');
    expect((failure as TransportError).aborted).toBe(false);
    expect((failure as TransportError).cause).toBeInstanceOf(TypeError);
  });

  it('reports a switch that outlives timeoutMs as an aborted TransportError', async () => {
    const api = fetchDouble((request) => {
      if (request.url.pathname !== '/api/auth/workspace') return jsonResponse(200, { ok: true });
      return new Promise((_, reject) => {
        const signal = request.init.signal;
        signal?.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        });
      });
    });
    const client = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      workspace: 'acme',
      fetch: api.fetch,
      timeoutMs: 5,
    });

    const failure = await echo(client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).message).toContain('workspaces.select');
    // The whole point of the deadline: a caller can tell a timeout from any other failure.
    expect((failure as TransportError).aborted).toBe(true);
    expect(((failure as TransportError).cause as DOMException).name).toBe('TimeoutError');
  });

  it('applies ClientOptions.headers and timeoutMs to the switch request itself', async () => {
    const api = fetchDouble((request) =>
      request.url.pathname === '/api/auth/workspace'
        ? jsonResponse(200, { workspace: { id: 'ws-a' } })
        : jsonResponse(200, { ok: true }),
    );
    const client = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      workspace: 'acme',
      headers: { 'x-trace-id': 'trace-1' },
      timeoutMs: 30_000,
      fetch: api.fetch,
    });
    await echo(client);

    const [swap] = api.calls;
    expect(swap?.url.pathname).toBe('/api/auth/workspace');
    expect(swap?.headers.get('x-trace-id')).toBe('trace-1');
    // The route's own content type still wins over anything a caller configured.
    expect(swap?.headers.get('content-type')).toBe('application/json');
    // Bounded like every other request this client makes, rather than able to hang forever.
    expect(swap?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not switch when no workspace is configured', async () => {
    const api = fetchDouble(() => jsonResponse(200, { ok: true }));
    await echo(sessionClient(api.fetch));
    expect(api.calls.map((call) => call.url.pathname)).toEqual(['/api/echo']);
  });
});

/**
 * Issue #488: the segments `encodeURIComponent` leaves as they are and that change the route, plus
 * values holding a lone surrogate, on which `encodeURIComponent` throws a raw, untyped `URIError`.
 */
const PATH_CHANGING_SEGMENTS = ['', '.', '..', '\ud800', 'a\udc00b'] as const;

describe('segment (issue #488)', () => {
  it.each(PATH_CHANGING_SEGMENTS)('refuses %j with a typed InvalidArgumentError', (value) => {
    const refusal = ((): unknown => {
      try {
        segment(value);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refusal).toBeInstanceOf(InvalidArgumentError);
    expect(refusal).toBeInstanceOf(AgentWorkspaceError);
    expect(refusal).toMatchObject({
      name: 'InvalidArgumentError',
      kind: 'argument',
      code: 'invalid_path_segment',
      value,
      message: `a path segment must not be empty, "." or ".." or hold a lone surrogate (got ${JSON.stringify(value)})`,
    });
    expect(refusal).not.toHaveProperty('status');
  });

  it('encodes every other id exactly as before, as one opaque segment', () => {
    expect(segment('a b')).toBe('a%20b');
    expect(segment('../admin?x=1')).toBe('..%2Fadmin%3Fx%3D1');
    expect(segment('...')).toBe('...');
    expect(segment('.a')).toBe('.a');
    expect(segment('a.')).toBe('a.');
    // A caller-typed dot-segment spelling is escaped again, so the URL parser never sees `%2e`.
    expect(segment('%2e')).toBe('%252e');
    expect(segment('%2e%2e')).toBe('%252e%252e');
    expect(segment('a/b')).toBe('a%2Fb');
    expect(segment('é-🙂')).toBe('%C3%A9-%F0%9F%99%82');
    // A well-formed surrogate pair is one code point, not a lone surrogate.
    expect(segment('🙂')).toBe('%F0%9F%99%82');
    expect(segment('0b3e4f6a-1c2d-4e5f-8a9b-0c1d2e3f4a5b')).toBe(
      '0b3e4f6a-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
    );
  });
});

const draft: AgentVersionDraftInput = (() => {
  const version = fixtures.agentVersion();
  return { summary: version.summary, via: 'api', body: version.body };
})();

const policy: AgentPolicy = {
  engine: 'claude-agent-sdk',
  tools: {
    base: 'claude_code_preset',
    autoApprove: [],
    deny: [],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
  },
  skills: { mode: 'allowlist', names: [] },
  limits: { maxTurns: 20, maxBudgetUsd: null },
};

interface SegmentOperation {
  readonly name: string;
  /** Calls the operation with `id` in its path position and minimal valid other arguments. */
  readonly call: (aw: AgentWorkspaceClient, id: string) => Promise<unknown>;
  /**
   * The ids the operation must refuse. A file is addressed by `fileRouteId(path)`, base64url
   * text that is never `.` or `..`, so only the empty path reaches the refusal there.
   */
  readonly refuses?: readonly string[];
}

/**
 * Every public operation whose path is built with `segment()`: the result of scanning `segment(`
 * (and its private callers `#path`, `#transition` and `#policyOf`) across
 * `packages/sdk/src/resources/*.ts`. A new call site belongs in this table.
 */
const SEGMENT_OPERATIONS: readonly SegmentOperation[] = [
  // agent-definitions.ts (#policyOf), reached through agents.export
  { name: 'agents.export', call: (aw, id) => aw.agents.export(id) },
  // agent-versions.ts
  { name: 'agents.versions.list', call: (aw, id) => aw.agents.versions.list(id) },
  { name: 'agents.versions.create', call: (aw, id) => aw.agents.versions.create(id, draft) },
  { name: 'agents.versions.check', call: (aw, id) => aw.agents.versions.check(id, draft) },
  {
    name: 'agents.pointers.set',
    call: (aw, id) => aw.agents.pointers.set(id, { environment: 'local', version: 1 }),
  },
  // agents.ts
  { name: 'agents.get', call: (aw, id) => aw.agents.get(id) },
  { name: 'agents.update', call: (aw, id) => aw.agents.update(id, {}) },
  { name: 'agents.remove', call: (aw, id) => aw.agents.remove(id) },
  {
    name: 'agents.getResourceAssignments',
    call: (aw, id) => aw.agents.getResourceAssignments(id),
  },
  {
    name: 'agents.replaceResourceAssignments',
    call: (aw, id) =>
      aw.agents.replaceResourceAssignments(id, { files: [], skillIds: [], connectorIds: [] }),
  },
  { name: 'agents.getGrants', call: (aw, id) => aw.agents.getGrants(id) },
  { name: 'agents.replaceGrants', call: (aw, id) => aw.agents.replaceGrants(id, []) },
  { name: 'agents.getPolicy', call: (aw, id) => aw.agents.getPolicy(id) },
  { name: 'agents.replacePolicy', call: (aw, id) => aw.agents.replacePolicy(id, policy) },
  // connectors.ts
  { name: 'connectors.get', call: (aw, id) => aw.connectors.get(id) },
  { name: 'connectors.remove', call: (aw, id) => aw.connectors.remove(id) },
  {
    name: 'connectors.rotateCredential',
    call: (aw, id) => aw.connectors.rotateCredential(id, 'credential'),
  },
  { name: 'connectors.update', call: (aw, id) => aw.connectors.update(id, {}) },
  { name: 'connectors.test', call: (aw, id) => aw.connectors.test(id) },
  // files.ts (#path)
  { name: 'files.download', call: (aw, id) => aw.files.download(id), refuses: [''] },
  { name: 'files.move', call: (aw, id) => aw.files.move(id, 'docs/b.md'), refuses: [''] },
  { name: 'files.remove', call: (aw, id) => aw.files.remove(id), refuses: [''] },
  // models.ts
  { name: 'models.connections.get', call: (aw, id) => aw.models.connections.get(id) },
  { name: 'models.connections.update', call: (aw, id) => aw.models.connections.update(id, {}) },
  { name: 'models.connections.remove', call: (aw, id) => aw.models.connections.remove(id) },
  {
    name: 'models.connections.rotateCredential',
    call: (aw, id) => aw.models.connections.rotateCredential(id, 'credential'),
  },
  { name: 'models.connections.test', call: (aw, id) => aw.models.connections.test(id) },
  // projects.ts (and #transition)
  { name: 'projects.get', call: (aw, id) => aw.projects.get(id) },
  { name: 'projects.update', call: (aw, id) => aw.projects.update(id, {}) },
  { name: 'projects.archive', call: (aw, id) => aw.projects.archive(id) },
  { name: 'projects.restore', call: (aw, id) => aw.projects.restore(id) },
  { name: 'projects.startSession', call: (aw, id) => aw.projects.startSession(id) },
  {
    name: 'projects.adoptSession',
    call: (aw, id) => aw.projects.adoptSession(id, fixtures.session().id),
  },
  // runs.ts
  { name: 'runs.start', call: (aw, id) => aw.runs.start(id, { prompt: 'hello' }) },
  { name: 'runs.get', call: (aw, id) => aw.runs.get(id) },
  { name: 'runs.interrupt', call: (aw, id) => aw.runs.interrupt(id) },
  { name: 'runs.approve', call: (aw, id) => aw.runs.approve(id) },
  { name: 'runs.reject', call: (aw, id) => aw.runs.reject(id) },
  { name: 'runs.revokeTokens', call: (aw, id) => aw.runs.revokeTokens(id) },
  { name: 'runs.rate', call: (aw, id) => aw.runs.rate(id, { rating: 'down' }) },
  { name: 'runs.events', call: (aw, id) => aw.runs.events(id).next() },
  {
    name: 'runs.follow',
    call: (aw, id) => aw.runs.follow(id, { reconnectDelayMs: 0 }).next(),
  },
  {
    name: 'runs.waitForOutcome',
    call: (aw, id) => aw.runs.waitForOutcome(id, { reconnectDelayMs: 0 }),
  },
  // runtimes.ts
  { name: 'runtimes.profiles.get', call: (aw, id) => aw.runtimes.profiles.get(id) },
  { name: 'runtimes.profiles.update', call: (aw, id) => aw.runtimes.profiles.update(id, {}) },
  { name: 'runtimes.profiles.remove', call: (aw, id) => aw.runtimes.profiles.remove(id) },
  // secrets.ts
  { name: 'secrets.replace', call: (aw, id) => aw.secrets.replace(id, 'value') },
  { name: 'secrets.remove', call: (aw, id) => aw.secrets.remove(id) },
  // sessions.ts
  { name: 'sessions.transcript.read', call: (aw, id) => aw.sessions.transcript.read(id) },
  { name: 'sessions.transcript.subkeys', call: (aw, id) => aw.sessions.transcript.subkeys(id) },
  { name: 'sessions.get', call: (aw, id) => aw.sessions.get(id) },
  { name: 'sessions.update', call: (aw, id) => aw.sessions.update(id, {}) },
  // shares.ts
  { name: 'shares.revoke', call: (aw, id) => aw.shares.revoke(id) },
  // skills.ts
  { name: 'skills.get', call: (aw, id) => aw.skills.get(id) },
  { name: 'skills.export', call: (aw, id) => aw.skills.export(id) },
  { name: 'skills.update', call: (aw, id) => aw.skills.update(id, {}) },
  { name: 'skills.publish', call: (aw, id) => aw.skills.publish(id, { files: [] }) },
  { name: 'skills.remove', call: (aw, id) => aw.skills.remove(id) },
  // storage.ts (`get` takes the segment path only for a UUID, so it refuses nothing)
  { name: 'storage.connections.update', call: (aw, id) => aw.storage.connections.update(id, {}) },
  { name: 'storage.connections.remove', call: (aw, id) => aw.storage.connections.remove(id) },
  {
    name: 'storage.connections.rotateCredential',
    call: (aw, id) => aw.storage.connections.rotateCredential(id, { provider: 'file' }),
  },
  { name: 'storage.connections.test', call: (aw, id) => aw.storage.connections.test(id) },
  {
    name: 'storage.connections.browse',
    call: (aw, id) => aw.storage.connections.browse(id).next(),
  },
  // team.ts
  { name: 'team.members.setRole', call: (aw, id) => aw.team.members.setRole(id, 'viewer') },
  { name: 'team.members.remove', call: (aw, id) => aw.team.members.remove(id) },
  { name: 'team.invitations.resend', call: (aw, id) => aw.team.invitations.resend(id) },
  { name: 'team.invitations.revoke', call: (aw, id) => aw.team.invitations.revoke(id) },
  { name: 'team.invitations.accept', call: (aw, id) => aw.team.invitations.accept(id, 'token') },
  { name: 'team.apiKeys.revoke', call: (aw, id) => aw.team.apiKeys.revoke(id) },
  // workspaces.ts
  { name: 'workspaces.get', call: (aw, id) => aw.workspaces.get(id) },
  { name: 'workspaces.update', call: (aw, id) => aw.workspaces.update(id, {}) },
];

const SEGMENT_CASES = SEGMENT_OPERATIONS.flatMap((operation) =>
  (operation.refuses ?? PATH_CHANGING_SEGMENTS).map((id) => ({ ...operation, id })),
);

function refusingClient(status = 500): {
  readonly aw: AgentWorkspaceClient;
  readonly calls: readonly RecordedRequest[];
} {
  const api = fetchDouble(() => jsonResponse(status, {}));
  const aw = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { aw, calls: api.calls };
}

describe('every operation with an id in its path refuses a path-changing id (issue #488)', () => {
  it('lists each operation once', () => {
    const names = SEGMENT_OPERATIONS.map((operation) => operation.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(SEGMENT_CASES)('$name($id) rejects before any request', async ({ call, id }) => {
    const { aw, calls } = refusingClient();
    let pending: Promise<unknown> = Promise.resolve();
    // A refusal is a rejection, never a synchronous throw, so `.catch()` and `await` both see it.
    expect(() => {
      pending = call(aw, id);
    }).not.toThrow();
    await expect(pending).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(pending).rejects.toMatchObject({ code: 'invalid_path_segment', value: id });
    expect(calls).toEqual([]);
  });

  it('still addresses a file whose path is "." or "..": its route id is base64url', async () => {
    const { aw, calls } = refusingClient(404);
    await expect(aw.files.remove('.')).rejects.toBeInstanceOf(ApiProblemError);
    await expect(aw.files.remove('..')).rejects.toBeInstanceOf(ApiProblemError);
    expect(calls.map((call) => call.url.pathname)).toEqual(['/api/files/Lg', '/api/files/Li4']);
  });
});
