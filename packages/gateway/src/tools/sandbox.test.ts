import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { DatabaseRoot, RunRecord } from '@agent-workspace/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { GatewayRunResolver } from '../auth.js';
import { createGatewayApplication } from '../index.js';
import { createEndpointGrantCodec } from '../tokens/endpoint-grant.js';
import { createRunTokenCodec, toolSandboxRunToken } from '../tokens/run-token.js';
import { createDatabaseToolSandboxResolver, type ToolSandboxResolver } from './sandbox.js';

const SECRET = 'fixture-signing-secret-that-is-longer-than-32-bytes';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const RUN = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN = '33333333-3333-4333-8333-333333333333';
const SUBJECT = {
  runId: RUN,
  sessionId: 'session-1',
  workspaceId: WORKSPACE,
  agentId: 'agent-1',
  modelConnectionId: 'connection-1',
} as const;

type Seen = { readonly headers: IncomingHttpHeaders; readonly body: string; readonly url: string };

let sandbox: Server;
let origin = '';
const seen: Seen[] = [];

beforeAll(async () => {
  sandbox = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        url: request.url ?? '',
      });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
    });
  });
  await new Promise<void>((resolve) => sandbox.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((sandbox.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => sandbox.close(() => resolve()));
});

function gateway(
  resolve: ToolSandboxResolver['resolve'],
  options: { readonly fetch?: typeof fetch; readonly runnerManagerToken?: string } = {},
) {
  const model: GatewayRunResolver & { calls: number } = {
    calls: 0,
    resolve() {
      model.calls += 1;
      return Promise.resolve({ state: 'missing' });
    },
  };
  const application = createGatewayApplication({
    tokenSecret: SECRET,
    resolver: model,
    toolSandbox: { resolve },
    ...(options.fetch === undefined ? {} : { toolSandboxFetch: options.fetch }),
    ...(options.runnerManagerToken === undefined
      ? {}
      : { runnerManagerToken: options.runnerManagerToken }),
  });
  return { application, model };
}

async function call(
  application: ReturnType<typeof gateway>['application'],
  headers: Record<string, string> = {},
  token?: string,
): Promise<Response> {
  const bearer = token ?? (await createRunTokenCodec({ secret: SECRET }).issue(SUBJECT));
  return application.fetch(
    new Request('http://gateway:4000/v1/tool-sandbox/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
  );
}

describe('POST /v1/tool-sandbox/mcp', () => {
  it("forwards to the run's sandbox with the recomputed tool token and no caller credential", async () => {
    const { application, model } = gateway(() => Promise.resolve({ ok: true, origin }));
    seen.length = 0;
    const response = await call(application, {
      'x-aw-run-id': OTHER_RUN,
      'x-aw-agent': 'support',
      cookie: 'session=secret',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [] },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/mcp');
    expect(seen[0]?.body).toBe(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${await toolSandboxRunToken(SECRET, RUN)}`);
    expect(seen[0]?.headers['x-aw-run-id']).toBe(RUN);
    expect(seen[0]?.headers['x-aw-agent']).toBe('support');
    expect(seen[0]?.headers.cookie).toBeUndefined();
    expect(model.calls).toBe(0);
  });

  it('keeps the path of a hosted sandbox origin, which the manager serves under /tool-sandboxes/<id>', async () => {
    const { application } = gateway(() =>
      Promise.resolve({ ok: true, origin: `${origin}/tool-sandboxes/sealed-id/` }),
    );
    seen.length = 0;
    expect((await call(application)).status).toBe(200);
    expect(seen[0]?.url).toBe('/tool-sandboxes/sealed-id/mcp');
  });

  it('sends the manager token only to a manager-served origin, with the run token beside it (ADR-0132)', async () => {
    const MANAGER_TOKEN = 'runner-manager-fixture-token-more-than-32-characters';
    const runToken = `Bearer ${await toolSandboxRunToken(SECRET, RUN)}`;
    const hosted = gateway(
      () => Promise.resolve({ ok: true, origin: `${origin}/tool-sandboxes/sealed-id` }),
      { runnerManagerToken: MANAGER_TOKEN },
    );
    seen.length = 0;
    expect((await call(hosted.application)).status).toBe(200);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${MANAGER_TOKEN}`);
    expect(seen[0]?.headers['x-aw-tool-authorization']).toBe(runToken);

    // A container origin (Docker) is the tool host itself: it never sees the manager token.
    const direct = gateway(() => Promise.resolve({ ok: true, origin }), {
      runnerManagerToken: MANAGER_TOKEN,
    });
    seen.length = 0;
    expect((await call(direct.application)).status).toBe(200);
    expect(seen[0]?.headers.authorization).toBe(runToken);
    expect(JSON.stringify(seen[0]?.headers)).not.toContain(MANAGER_TOKEN);
  });

  it('refuses without a run token, and never dials the sandbox', async () => {
    const { application } = gateway(() => Promise.resolve({ ok: true, origin }));
    seen.length = 0;
    const response = await application.fetch(
      new Request('http://gateway:4000/v1/tool-sandbox/mcp', { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it.each([
    [{ ok: false, status: 401, code: 'tool_run_not_active' }, 401],
    [{ ok: false, status: 403, code: 'tool_not_in_run' }, 403],
  ] as const)('answers the resolver refusal %j with %i', async (refusal, status) => {
    const { application } = gateway(() => Promise.resolve(refusal));
    seen.length = 0;
    const response = await call(application);
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code: refusal.code } });
    expect(seen).toHaveLength(0);
  });

  it('answers 405 to GET', async () => {
    const { application } = gateway(() => Promise.resolve({ ok: true, origin }));
    const response = await application.fetch(
      new Request('http://gateway:4000/v1/tool-sandbox/mcp', { method: 'GET' }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('answers 502 without naming the sandbox when it cannot be reached', async () => {
    const { application } = gateway(() => Promise.resolve({ ok: true, origin }), {
      fetch: () => Promise.reject(new TypeError('connect ECONNREFUSED 10.0.0.9:7001')),
    });
    const response = await call(application);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain('tool_upstream_failed');
    expect(text).not.toContain('10.0.0.9');
  });

  it('answers 504 when the sandbox does not answer in time', async () => {
    const { application } = gateway(() => Promise.resolve({ ok: true, origin }), {
      fetch: () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
    });
    const response = await call(application);
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'tool_upstream_timeout' },
    });
  });

  it('is an unknown route when no sandbox resolver is configured', async () => {
    const application = createGatewayApplication({
      tokenSecret: SECRET,
      resolver: { resolve: () => Promise.resolve({ state: 'missing' }) },
    });
    const response = await call({ ...application });
    expect(response.status).toBe(404);
  });
});

const CLIENT = '44444444-4444-4444-8444-444444444444';
const ENDPOINT_MANAGER_TOKEN = 'runner-manager-fixture-token-more-than-32-characters';

async function callEndpoint(
  application: ReturnType<typeof gateway>['application'],
  options: {
    readonly origin?: string;
    readonly grant?: string;
    readonly body?: string;
    readonly secret?: string;
  } = {},
): Promise<Response> {
  const grant =
    options.grant ??
    (await createEndpointGrantCodec({ secret: options.secret ?? SECRET }).issue({
      workspaceId: WORKSPACE,
      clientId: CLIENT,
      origin: options.origin ?? origin,
    }));
  return application.fetch(
    new Request('http://gateway:4000/v1/tool-sandbox/endpoint/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${grant}`,
        'content-type': 'application/json',
        cookie: 'session=secret',
      },
      body: options.body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
  );
}

describe('POST /v1/tool-sandbox/endpoint/mcp', () => {
  const unusedResolver: ToolSandboxResolver['resolve'] = () => {
    throw new Error('the endpoint route never consults the run resolver');
  };

  it('forwards with the sandbox bearer derived from the client id and no caller credential', async () => {
    const { application, model } = gateway(unusedResolver);
    seen.length = 0;
    const response = await callEndpoint(application);

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/mcp');
    expect(seen[0]?.headers.authorization).toBe(
      `Bearer ${await toolSandboxRunToken(SECRET, `endpoint-${CLIENT}`)}`,
    );
    expect(seen[0]?.headers['x-aw-run-id']).toBe(`endpoint-${CLIENT}`);
    expect(seen[0]?.headers.cookie).toBeUndefined();
    expect(JSON.stringify(seen[0]?.headers)).not.toContain('awg.');
    expect(model.calls).toBe(0);
  });

  it('sends the manager token only to a manager-served origin, with the derived bearer beside it', async () => {
    const bearer = `Bearer ${await toolSandboxRunToken(SECRET, `endpoint-${CLIENT}`)}`;
    const { application } = gateway(unusedResolver, { runnerManagerToken: ENDPOINT_MANAGER_TOKEN });

    seen.length = 0;
    expect(
      (await callEndpoint(application, { origin: `${origin}/tool-sandboxes/sealed-id` })).status,
    ).toBe(200);
    expect(seen[0]?.url).toBe('/tool-sandboxes/sealed-id/mcp');
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${ENDPOINT_MANAGER_TOKEN}`);
    expect(seen[0]?.headers['x-aw-tool-authorization']).toBe(bearer);

    seen.length = 0;
    expect((await callEndpoint(application)).status).toBe(200);
    expect(seen[0]?.headers.authorization).toBe(bearer);
    expect(JSON.stringify(seen[0]?.headers)).not.toContain(ENDPOINT_MANAGER_TOKEN);
  });

  it('refuses an origin that is not http(s) and never dials it', async () => {
    let dialled = 0;
    const { application } = gateway(unusedResolver, {
      fetch: () => {
        dialled += 1;
        return Promise.resolve(new Response('{}'));
      },
    });
    for (const target of ['file:///etc/passwd', 'ftp://sandbox.test', 'not a url']) {
      const response = await callEndpoint(application, { origin: target });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'tool_endpoint_origin_invalid' },
      });
    }
    expect(dialled).toBe(0);
  });

  it.each([
    ['a run token', async () => createRunTokenCodec({ secret: SECRET }).issue(SUBJECT)],
    [
      'a grant signed with another secret',
      async () =>
        createEndpointGrantCodec({ secret: `${SECRET}-other` }).issue({
          workspaceId: WORKSPACE,
          clientId: CLIENT,
          origin,
        }),
    ],
    [
      'an expired grant',
      async () =>
        createEndpointGrantCodec({ secret: SECRET, now: () => 1 }).issue({
          workspaceId: WORKSPACE,
          clientId: CLIENT,
          origin,
        }),
    ],
  ])('refuses %s with 401 and never dials the sandbox', async (_name, grant) => {
    const { application } = gateway(unusedResolver);
    seen.length = 0;
    const token = await grant();
    const response = await callEndpoint(application, { grant: token });
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).toContain('tool_endpoint_grant_invalid');
    expect(text).not.toContain(token);
    expect(seen).toHaveLength(0);
  });

  it('refuses a request without a credential with 401', async () => {
    const { application } = gateway(unusedResolver);
    seen.length = 0;
    const response = await application.fetch(
      new Request('http://gateway:4000/v1/tool-sandbox/endpoint/mcp', {
        method: 'POST',
        body: '{}',
      }),
    );
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('refuses a body over 4 MiB with 413 and answers 405 to GET', async () => {
    const { application } = gateway(unusedResolver);
    seen.length = 0;
    const response = await callEndpoint(application, { body: 'x'.repeat(4 * 1024 * 1024 + 1) });
    expect(response.status).toBe(413);
    expect(seen).toHaveLength(0);

    const get = await application.fetch(
      new Request('http://gateway:4000/v1/tool-sandbox/endpoint/mcp', { method: 'GET' }),
    );
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });

  it('answers 502 without naming the sandbox when it cannot be reached', async () => {
    const { application } = gateway(unusedResolver, {
      fetch: () => Promise.reject(new TypeError('connect ECONNREFUSED 10.0.0.9:7001')),
    });
    const response = await callEndpoint(application);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('10.0.0.9');
  });

  it('is an unknown route when no sandbox resolver is configured', async () => {
    const application = createGatewayApplication({
      tokenSecret: SECRET,
      resolver: { resolve: () => Promise.resolve({ state: 'missing' }) },
    });
    expect((await callEndpoint(application)).status).toBe(404);
  });
});

function fakeDatabase(options: {
  readonly active?: boolean;
  readonly run?: Pick<RunRecord, 'status' | 'toolSandboxOrigin'> | null;
}): { readonly database: DatabaseRoot; readonly calls: string[] } {
  const calls: string[] = [];
  const database = {
    scopes: { forWorkspaceId: () => Promise.resolve({ workspaceId: WORKSPACE }) },
    runTokens: {
      forScope: () => ({
        isActive: () => {
          calls.push('runTokens.isActive');
          return Promise.resolve(options.active ?? true);
        },
      }),
    },
    runs: {
      forScope: () => ({
        get: () => {
          calls.push('runs.get');
          return Promise.resolve(options.run ?? null);
        },
      }),
    },
  } as unknown as DatabaseRoot;
  return { database, calls };
}

const CLAIMS = {
  version: 1,
  tokenId: 'token-1',
  ...SUBJECT,
  issuedAt: 1,
  expiresAt: 2,
} as const;

describe('createDatabaseToolSandboxResolver', () => {
  it("returns the origin recorded on the token's own live run", async () => {
    const fake = fakeDatabase({ run: { status: 'running', toolSandboxOrigin: 'http://sbx:7001' } });
    await expect(
      createDatabaseToolSandboxResolver(fake.database).resolve(CLAIMS, 'hash'),
    ).resolves.toEqual({ ok: true, origin: 'http://sbx:7001' });
    expect(fake.calls).toEqual(['runTokens.isActive', 'runs.get']);
  });

  it.each([
    ['a revoked token', { active: false }],
    ['a missing run', { run: null }],
    ['a finished run', { run: { status: 'completed', toolSandboxOrigin: 'http://sbx:7001' } }],
  ] as const)('refuses %s with 401 tool_run_not_active', async (_name, options) => {
    const fake = fakeDatabase(options);
    await expect(
      createDatabaseToolSandboxResolver(fake.database).resolve(CLAIMS, 'hash'),
    ).resolves.toEqual({ ok: false, status: 401, code: 'tool_run_not_active' });
  });

  it('refuses a run with no recorded sandbox with 403 tool_not_in_run', async () => {
    const fake = fakeDatabase({ run: { status: 'running', toolSandboxOrigin: null } });
    await expect(
      createDatabaseToolSandboxResolver(fake.database).resolve(CLAIMS, 'hash'),
    ).resolves.toEqual({ ok: false, status: 403, code: 'tool_not_in_run' });
  });
});
