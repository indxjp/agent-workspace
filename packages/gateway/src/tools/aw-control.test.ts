import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { DatabaseRoot, RunRecord } from '@agent-workspace/core/db';
import { canonicalCall } from '@indx-workspace/contracts/agents';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { GatewayRunResolver } from '../auth.js';
import { createGatewayApplication, type GatewayApplicationDependencies } from '../index.js';
import { createRunTokenCodec } from '../tokens/run-token.js';
import type { ToolApproval } from './authorize.js';
import {
  createDatabaseAwControlResolver,
  parseControlPlaneOrigin,
  type AwControlResolver,
} from './aw-control.js';

const SECRET = 'fixture-signing-secret-that-is-longer-than-32-bytes';
const SUBJECT = {
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: 'session-1',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  agentId: 'agent-1',
  modelConnectionId: 'connection-1',
} as const;
const PATH = '/v1/tools/aw-control/mcp';
const CALL = JSON.stringify({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: 'catalog_list', arguments: { kinds: ['skills'] } },
});

type Seen = { readonly headers: IncomingHttpHeaders; readonly body: string; readonly url: string };

let web: Server;
let origin = '';
const seen: Seen[] = [];

beforeAll(async () => {
  web = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        url: request.url ?? '',
      });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 7, result: { content: [] } }));
    });
  });
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((web.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => web.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

const MODEL: GatewayRunResolver = { resolve: () => Promise.resolve({ state: 'missing' }) };

// The origin is boxed: a bare `undefined` argument would take the parameter's default instead.
function gateway(
  dependencies: Partial<GatewayApplicationDependencies> = {},
  { controlPlaneOrigin }: { readonly controlPlaneOrigin: string | undefined } = {
    controlPlaneOrigin: origin,
  },
) {
  return createGatewayApplication({
    tokenSecret: SECRET,
    resolver: MODEL,
    ...(controlPlaneOrigin === undefined ? {} : { controlPlaneOrigin }),
    awControl: {
      resolve: () =>
        Promise.resolve({
          ok: true,
          approval: {
            serverKey: 'aw-control',
            approvedToolCalls: [],
            consume: () => Promise.resolve('not-approved'),
          },
        }),
    },
    ...dependencies,
  });
}

const token = () => createRunTokenCodec({ secret: SECRET }).issue(SUBJECT);

function post(bearer: string, headers: Record<string, string> = {}, body = CALL): Request {
  return new Request(`http://gateway:4000${PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
  });
}

describe('the aw-control forwarder', () => {
  it('the gateway forwards an aw-control MCP call to the control-plane origin with exactly the run token', async () => {
    const bearer = await token();

    const response = await gateway().fetch(
      post(bearer, {
        cookie: 'aw_session=stolen',
        'x-api-key': 'aw_live_not_forwarded',
        'x-aw-agent': 'agent-1',
        'mcp-session-id': 'session-from-the-sandbox',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 7, result: { content: [] } });
    expect(seen).toHaveLength(1);
    const [forwarded] = seen;
    expect(forwarded?.url).toBe('/api/builder/mcp');
    expect(forwarded?.body).toBe(CALL);
    expect(forwarded?.headers.authorization).toBe(`Bearer ${bearer}`);
    // Only the run token, the fixed MCP framing and what fetch itself adds; nothing else the sandbox sent.
    const framing = ['host', 'connection', 'content-length', 'content-type', 'accept'];
    const fetchOwn = ['user-agent', 'accept-encoding', 'accept-language', 'sec-fetch-mode'];
    const credentialBearing = Object.keys(forwarded?.headers ?? {}).filter(
      (name) => ![...framing, ...fetchOwn].includes(name),
    );
    expect(credentialBearing).toEqual(['authorization']);
  });
});

describe('the control-plane origin', () => {
  it.each([undefined, '', '  '])(
    'is unset for %j, and every aw-control call is refused',
    async (value) => {
      const unset = parseControlPlaneOrigin(value);
      const response = await gateway({}, { controlPlaneOrigin: unset }).fetch(post(await token()));

      expect(unset).toBeUndefined();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        type: 'error',
        error: {
          type: 'api_error',
          code: 'tool_control_plane_unconfigured',
          message: 'This gateway has no control-plane origin for aw-control.',
        },
      });
      expect(seen).toEqual([]);
    },
  );

  it.each(['http://web:3000', 'https://console.example.com/', 'HTTP://Web:3000'])(
    'accepts the http(s) origin %s',
    (value) => {
      expect(parseControlPlaneOrigin(value)).toBe(new URL(value).origin);
    },
  );

  it.each([
    'ftp://web:3000',
    'http://user:pass@web:3000',
    'http://web:3000/api',
    'http://web:3000/?next=1',
    'http://web:3000/#x',
    'web:3000',
  ])('refuses %s at startup without repeating it', (value) => {
    expect(() => parseControlPlaneOrigin(value)).toThrow(
      'GATEWAY_CONTROL_PLANE_ORIGIN must be an http(s) origin with no credentials, path or query.',
    );
  });
});

const SAVE_ARGS = { draft: { name: 'triage' } };
const SAVE = canonicalCall('mcp__aw-control__draft_save', SAVE_ARGS);
const toolCall = (name: string, args: unknown = {}) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name, arguments: args },
  });

/** A resolver whose run approves `approved`, recording each consume and answering `outcome`. */
function approving(
  approved: readonly string[],
  outcome: 'consumed' | 'already-used' = 'consumed',
): { readonly awControl: AwControlResolver; readonly used: string[] } {
  const used: string[] = [];
  const approval: ToolApproval = {
    serverKey: 'aw-control',
    approvedToolCalls: approved,
    consume: (call) => {
      used.push(call.canonicalCall);
      return Promise.resolve(outcome);
    },
  };
  return { awControl: { resolve: () => Promise.resolve({ ok: true, approval }) }, used };
}

describe('the aw-control refusals', () => {
  it('refuses a revoked token 401 and never dials the control plane', async () => {
    const response = await gateway({
      awControl: {
        resolve: () =>
          Promise.resolve({ ok: false, status: 401, code: 'tool_run_not_active' as const }),
      },
    }).fetch(post(await token()));

    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('refuses an oversize request body 413 and never dials the control plane', async () => {
    const response = await gateway().fetch(
      post(await token(), {}, 'x'.repeat(4 * 1024 * 1024 + 1)),
    );

    expect(response.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it.each(['not json', '[]', JSON.stringify([JSON.parse(CALL)])])(
    'refuses %s with 400: one JSON-RPC message only',
    async (body) => {
      const response = await gateway().fetch(post(await token(), {}, body));

      expect(response.status).toBe(400);
      expect(seen).toEqual([]);
    },
  );

  it('answers an oversize control-plane answer 502 with none of its bytes', async () => {
    const big = 'y'.repeat(4 * 1024 * 1024 + 1);
    const response = await gateway({
      awControlFetch: () =>
        Promise.resolve(new Response(big, { headers: { 'content-type': 'application/json' } })),
    }).fetch(post(await token()));

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain('yyyy');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'tool_upstream_failed' } });
  });

  it.each([
    [new DOMException('timed out', 'TimeoutError'), 504, 'tool_upstream_timeout'],
    [new Error('connect ECONNREFUSED'), 502, 'tool_upstream_failed'],
  ] as const)('answers a failed dial (%s) without the token', async (failure, status, code) => {
    const bearer = await token();
    const response = await gateway({ awControlFetch: () => Promise.reject(failure) }).fetch(
      post(bearer),
    );

    expect(response.status).toBe(status);
    const text = await response.text();
    expect(text).not.toContain(bearer);
    expect(text).not.toContain('127.0.0.1');
    expect(JSON.parse(text)).toMatchObject({ error: { code } });
  });

  it('never hands an aw-control call to a workspace connector, whatever it is named', async () => {
    const asked: string[] = [];
    const response = await gateway({
      tools: {
        resolve: (_claims, _hash, connectorId) => {
          asked.push(connectorId);
          return Promise.resolve({ ok: false, status: 403, code: 'tool_not_in_run' as const });
        },
      },
    }).fetch(post(await token()));

    expect(response.status).toBe(200);
    expect(asked).toEqual([]);
    expect(seen).toHaveLength(1);
  });
});

describe('the aw-control approval backstop', () => {
  it('answers an unapproved draft_save approval_required without dialling or consuming', async () => {
    const { awControl, used } = approving([]);
    const response = await gateway({ awControl }).fetch(
      post(await token(), {}, toolCall('draft_save', SAVE_ARGS)),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'approval_required (403): draft_save runs only after the call is approved',
          },
        ],
        structuredContent: { error: { code: 'approval_required', status: 403 } },
      },
    });
    expect(used).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('consumes an approved draft_save once, then forwards it', async () => {
    const { awControl, used } = approving([SAVE]);
    const body = toolCall('draft_save', SAVE_ARGS);
    const response = await gateway({ awControl }).fetch(post(await token(), {}, body));

    expect(response.status).toBe(200);
    expect(used).toEqual([SAVE]);
    expect(seen.map((request) => request.body)).toEqual([body]);
  });

  it('answers a used approval approval_already_used without dialling', async () => {
    const { awControl } = approving([SAVE], 'already-used');
    const response = await gateway({ awControl }).fetch(
      post(await token(), {}, toolCall('draft_save', SAVE_ARGS)),
    );

    expect(JSON.stringify(await response.json())).toContain('approval_already_used (403)');
    expect(seen).toEqual([]);
  });

  it('forwards a read and other methods without consuming anything', async () => {
    const { awControl, used } = approving([]);
    const app = gateway({ awControl });
    const bearer = await token();
    await app.fetch(post(bearer, {}, toolCall('catalog_list')));
    await app.fetch(
      post(bearer, {}, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })),
    );

    expect(used).toEqual([]);
    expect(seen).toHaveLength(2);
  });
});

function fakeDatabase(
  run: Pick<RunRecord, 'id' | 'status' | 'approvedToolCalls'> | null,
  active = true,
  scoped = true,
) {
  const consumed: unknown[] = [];
  const database = {
    scopes: {
      forWorkspaceId: () => Promise.resolve(scoped ? { workspaceId: SUBJECT.workspaceId } : null),
    },
    runTokens: { forScope: () => ({ isActive: () => Promise.resolve(active) }) },
    runs: {
      forScope: () => ({
        get: () => Promise.resolve(run),
        consumeApprovedCall: (runId: string, call: unknown) => {
          consumed.push([runId, call]);
          return Promise.resolve('consumed');
        },
      }),
    },
  } as unknown as DatabaseRoot;
  return { database, consumed };
}

describe('createDatabaseAwControlResolver', () => {
  const claims = { version: 1, tokenId: 'token-1', ...SUBJECT, issuedAt: 1, expiresAt: 2 } as const;
  const approved = { toolName: 'mcp__aw-control__draft_save', canonicalCall: SAVE };

  it("gives a live run's approved calls under the aw-control key, consumed on that run", async () => {
    const fake = fakeDatabase({
      id: SUBJECT.runId,
      status: 'running',
      approvedToolCalls: [approved],
    });
    const resolved = await createDatabaseAwControlResolver(fake.database).resolve(claims, 'hash');

    if (!resolved.ok) throw new Error('expected the run to resolve');
    expect(resolved.approval.serverKey).toBe('aw-control');
    expect(resolved.approval.approvedToolCalls).toEqual([SAVE]);
    await expect(resolved.approval.consume(approved)).resolves.toBe('consumed');
    expect(fake.consumed).toEqual([[SUBJECT.runId, approved]]);
  });

  it.each([
    [
      'a revoked token',
      fakeDatabase({ id: SUBJECT.runId, status: 'running', approvedToolCalls: [] }, false),
    ],
    [
      'a finished run',
      fakeDatabase({ id: SUBJECT.runId, status: 'completed', approvedToolCalls: [] }),
    ],
    ['a missing run', fakeDatabase(null)],
    [
      'a token whose workspace has no scope',
      fakeDatabase({ id: SUBJECT.runId, status: 'running', approvedToolCalls: [] }, true, false),
    ],
  ])('refuses %s as tool_run_not_active', async (_label, fake) => {
    await expect(
      createDatabaseAwControlResolver(fake.database).resolve(claims, 'hash'),
    ).resolves.toEqual({ ok: false, status: 401, code: 'tool_run_not_active' });
  });
});
