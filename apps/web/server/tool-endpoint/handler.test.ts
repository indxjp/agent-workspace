import { captureLog } from '../telemetry/capture-log';
import { log as webLogger } from '../telemetry/logger';
import type { AgentVersionToolBundle } from '@indx-workspace/contracts/agent-versions';
import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '../../app/mcp/projects/[name]/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import type { EndpointClientAuditEvent, EndpointClientsRuntime } from '../endpoint-clients/runtime';
import { DomainError } from '../errors';
import type { Ownership } from '../rbac/decide';
import type { RunPrincipal } from '../runs/environment';
import type { ToolEndpointEnvironment, ToolEndpointIdentity } from './env';
import { TOOL_ENDPOINT_MAX_BODY_BYTES, selectToolBundles, serveToolEndpoint } from './handler';
import { TOOL_ENDPOINT_RATE_LIMITS, resetToolEndpointLimits } from './limits';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OTHER_WORKSPACE = '55555555-5555-4555-8555-555555555555';
const CLIENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_CLIENT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const AGENT = '33333333-3333-4333-8333-333333333333';
const SECOND_AGENT = '44444444-4444-4444-8444-444444444444';
const KEY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECRET = 'ak_live_SECRETSECRETSECRETSECRETSECRET00';
const GRANT = 'awg.grant-payload.grant-signature';
const GATEWAY_URL = 'https://gateway.example/v1/tool-sandbox/endpoint/mcp';
const URL_BASE = 'http://web/mcp/projects';

function principal(overrides: Partial<RunPrincipal> = {}): RunPrincipal {
  return {
    principalId: '77777777-7777-4777-8777-777777777777',
    ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
    userId: null,
    workspaceId: WORKSPACE,
    role: 'builder',
    scope: { kind: 'mcp-project', id: CLIENT },
    ...overrides,
  };
}

type Named = ToolEndpointIdentity;
const identity = (p: RunPrincipal, via: Named['via'] = 'api-key', apiKeyId = KEY_ID): Named => ({
  principal: p,
  via,
  apiKeyId: via === 'api-key' ? apiKeyId : null,
  label: 'ci key',
  oauth: null,
});

const IDENTITIES: Readonly<Record<string, Named>> = {
  key: identity(principal()),
  second: identity(principal(), 'api-key', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  viewer: identity(principal({ role: 'viewer' })),
  member: identity(principal({ scope: null })),
  a2a: identity(principal({ scope: { kind: 'a2a-agent', id: AGENT } })),
  otherClient: identity(principal({ scope: { kind: 'mcp-project', id: OTHER_CLIENT } })),
  otherTenant: identity(principal({ workspaceId: OTHER_WORKSPACE })),
  session: identity(principal({ scope: null }), 'session'),
  browserToken: identity(principal(), 'browser-token'),
  userToken: identity(principal(), 'user-token'),
  oauth: oauthIdentity('https://aw.example/mcp/projects/support'),
  oauthOtherProject: oauthIdentity('https://aw.example/mcp/projects/billing'),
  oauthAgent: oauthIdentity('https://aw.example/api/a2a/agents/support'),
  oauthBuilder: {
    ...oauthIdentity('https://aw.example/mcp/builder'),
    principal: principal({ scope: { kind: 'builder', id: CLIENT } }),
  },
};

function oauthIdentity(audience: string): Named {
  return {
    ...identity(principal(), 'oauth-token'),
    label: 'bot',
    oauth: { clientId: CLIENT, audience },
  };
}

const BUNDLE: AgentVersionToolBundle = {
  tool: 'lookup',
  digest: 'sha256:' + 'a'.repeat(64),
};
const OTHER_BUNDLE: AgentVersionToolBundle = {
  tool: 'other',
  digest: 'sha256:' + 'b'.repeat(64),
};

function client(overrides: Partial<EndpointClientResource> = {}): EndpointClientResource {
  return {
    id: CLIENT,
    name: 'support',
    kind: 'mcp-project',
    agentIds: [AGENT],
    toolNames: null,
    actsForPrincipalId: '77777777-7777-4777-8777-777777777777',
    apiKeyIds: [KEY_ID],
    redirectUris: [],
    hasClientSecret: false,
    revokedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let clients: Map<string, EndpointClientResource>;
let audits: Array<{ workspaceId: string; event: EndpointClientAuditEvent }>;
let events: string[];
let ownership: (agentId: string) => Ownership;
/** The production bundles of each agent. */
let bundles: Readonly<Record<string, readonly AgentVersionToolBundle[]>>;
let routed: Array<{ workspaceId: string; clientId: string; bundles: readonly string[] }>;
let upstreamCalls: Array<{ url: string; init: RequestInit }>;
let upstream: () => Promise<Response>;
/** What `env.route` rejects with, or `null` when it answers. */
let routeFails: Error | null;
/** What `clients.audit` rejects with, or `null` when it writes. */
let auditFails: Error | null;
let clock: number;

function installAll(): void {
  const runtime: Partial<EndpointClientsRuntime> = {
    get: (workspaceId, id) => {
      const found = clients.get(id);
      return Promise.resolve(workspaceId === WORKSPACE ? (found ?? null) : null);
    },
    audit: (who, event) => {
      events.push('audit');
      if (auditFails !== null) return Promise.reject(auditFails);
      audits.push({ workspaceId: who.workspaceId, event });
      return Promise.resolve();
    },
  };
  installTestDomains({ endpointClients: runtime as EndpointClientsRuntime });
  const environment: ToolEndpointEnvironment = {
    identify: (request) =>
      Promise.resolve(IDENTITIES[request.headers.get('x-test-identity') ?? ''] ?? null),
    agentOwnership: (_, agentId) => Promise.resolve(ownership(agentId)),
    productionToolBundles: (_, agentIds) =>
      Promise.resolve(agentIds.flatMap((agentId) => bundles[agentId] ?? [])),
    route: ({ workspaceId, clientId, bundles: chosen }) => {
      events.push('route');
      routed.push({ workspaceId, clientId, bundles: chosen.map((bundle) => bundle.tool) });
      return routeFails !== null
        ? Promise.reject(routeFails)
        : Promise.resolve({ url: GATEWAY_URL, grant: GRANT });
    },
    closeSandbox: () => Promise.resolve(),
    fetch: (url, init) => {
      events.push('forward');
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      upstreamCalls.push({ url: href, init: init ?? {} });
      return upstream();
    },
    now: () => clock,
  };
  installTestDomains({ toolEndpoint: { kind: 'serving', environment } });
}

function call(
  method: string,
  params: unknown = undefined,
  options: {
    identity?: string;
    name?: string;
    headers?: Record<string, string>;
    raw?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SECRET}`,
    'x-test-identity': options.identity ?? 'key',
    ...options.headers,
  };
  return new Request(`${URL_BASE}/${options.name ?? 'support'}`, {
    method: 'POST',
    headers,
    body: options.raw ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

const toolCall = (name = 'lookup', options: Parameters<typeof call>[2] = {}) =>
  call('tools/call', { name, arguments: { q: 'x' } }, options);

async function bodyOf(response: Response): Promise<{
  error?: { code: number; message?: string; data?: unknown };
  result?: unknown;
  id?: unknown;
}> {
  return (await response.json()) as never;
}

async function apiCodeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

beforeEach(() => {
  clients = new Map([[CLIENT, client()]]);
  audits = [];
  events = [];
  ownership = () => 'own';
  bundles = { [AGENT]: [BUNDLE, OTHER_BUNDLE] };
  routed = [];
  upstreamCalls = [];
  routeFails = null;
  auditFails = null;
  clock = 1_000_000;
  upstream = () =>
    Promise.resolve(
      Response.json({ jsonrpc: '2.0', id: 1, result: { content: [] } }, { status: 200 }),
    );
  resetToolEndpointLimits();
  installAll();
});

afterEach(() => {
  clearApplicationContext();
  clearApplicationContext();
  vi.restoreAllMocks();
});

describe('selectToolBundles', () => {
  it('keeps every tool of a client without a tool allow-list', () => {
    expect(selectToolBundles([BUNDLE, OTHER_BUNDLE], null)).toEqual({
      bundles: [BUNDLE, OTHER_BUNDLE],
    });
  });

  it('narrows to the allow-list and joins the same code pinned twice', () => {
    expect(selectToolBundles([BUNDLE, OTHER_BUNDLE, { ...BUNDLE }], ['lookup'])).toEqual({
      bundles: [BUNDLE],
    });
  });

  it('refuses two different codes under one tool name', () => {
    const changed = { ...BUNDLE, digest: 'sha256:' + 'c'.repeat(64) };
    expect(selectToolBundles([BUNDLE, changed], null)).toEqual({ conflict: 'lookup' });
  });
});

describe('POST /mcp/projects/:name credentials', () => {
  it('answers 401 with no credential and does not consume the rate budget', async () => {
    for (let i = 0; i < TOOL_ENDPOINT_RATE_LIMITS.callsPerMinute + 5; i += 1) {
      const response = await serveToolEndpoint(
        new Request(`${URL_BASE}/support`, { method: 'POST', body: '{}' }),
        'support',
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toContain('Bearer');
    }
    expect((await serveToolEndpoint(call('ping'), 'support')).status).toBe(200);
  });

  it('answers 401 for a credential that identifies nobody, and it is free', async () => {
    for (let i = 0; i < TOOL_ENDPOINT_RATE_LIMITS.callsPerMinute + 5; i += 1) {
      const response = await serveToolEndpoint(
        call('ping', undefined, { identity: 'nobody' }),
        'support',
      );
      expect(response.status).toBe(401);
    }
    expect((await serveToolEndpoint(call('ping'), 'support')).status).toBe(200);
  });

  it.each(['session', 'browserToken', 'userToken'])(
    'refuses a %s caller: only an endpoint API key may call',
    async (who) => {
      const response = await serveToolEndpoint(
        call('tools/list', undefined, { identity: who }),
        'support',
      );
      expect(response.status).toBe(403);
      expect(await apiCodeOf(response)).toBe('tool_endpoint_credential_not_accepted');
      expect(routed).toEqual([]);
    },
  );

  it.each(['member', 'a2a'])(
    'refuses a %s key that is not scoped to an mcp-project',
    async (who) => {
      const response = await serveToolEndpoint(
        call('tools/list', undefined, { identity: who }),
        'support',
      );
      expect(response.status).toBe(403);
      expect(await apiCodeOf(response)).toBe('tool_endpoint_scope_required');
      expect(routed).toEqual([]);
    },
  );

  it('refuses a browser origin', async () => {
    const response = await serveToolEndpoint(
      call('tools/list', undefined, { headers: { Origin: 'https://evil.example' } }),
      'support',
    );
    expect(response.status).toBe(403);
    expect(await apiCodeOf(response)).toBe('origin_not_allowed');
    expect(routed).toEqual([]);
  });

  it('answers 503 when the endpoint is not installed', async () => {
    clearApplicationContext();
    const response = await serveToolEndpoint(call('ping'), 'support');
    expect(response.status).toBe(503);
    expect(await apiCodeOf(response)).toBe('tool_endpoint_not_configured');
  });

  it('answers the same 503 while the endpoint is disabled, before identifying the caller', async () => {
    installTestDomains({ toolEndpoint: { kind: 'disabled' } });
    const response = await serveToolEndpoint(call('ping'), 'support');
    expect(response.status).toBe(503);
    expect(await apiCodeOf(response)).toBe('tool_endpoint_not_configured');
    expect(events).toEqual([]);
  });
});

describe('POST /mcp/projects/:name OAuth access tokens (ADR-0134 part 3)', () => {
  beforeEach(() => {
    vi.stubEnv('AW_PUBLIC_URL', 'https://aw.example');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('serves a token issued for this project', async () => {
    const response = await serveToolEndpoint(
      call('ping', undefined, { identity: 'oauth' }),
      'support',
    );
    expect(response.status).toBe(200);
  });

  it.each(['oauthOtherProject', 'oauthAgent', 'oauthBuilder'])(
    'refuses a token issued for another URL (%s) with 401 invalid_token and a challenge',
    async (who) => {
      const response = await serveToolEndpoint(
        call('tools/list', undefined, { identity: who }),
        'support',
      );
      expect(response.status).toBe(401);
      expect(await apiCodeOf(response)).toBe('invalid_token');
      const challenge = response.headers.get('WWW-Authenticate') ?? '';
      expect(challenge).toContain('error="invalid_token"');
      expect(challenge).toContain(
        'resource_metadata="https://aw.example/.well-known/oauth-protected-resource/mcp/projects/support"',
      );
      expect(routed).toEqual([]);
    },
  );

  it('points an unauthenticated caller at the protected-resource metadata', async () => {
    const response = await serveToolEndpoint(
      new Request(`${URL_BASE}/support`, { method: 'POST', body: '{}' }),
      'support',
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(
      'resource_metadata="https://aw.example/.well-known/oauth-protected-resource/mcp/projects/support"',
    );
  });

  it('omits resource_metadata when no issuer is configured', async () => {
    vi.stubEnv('AW_PUBLIC_URL', '');
    const response = await serveToolEndpoint(
      new Request(`${URL_BASE}/support`, { method: 'POST', body: '{}' }),
      'support',
    );
    expect(response.headers.get('WWW-Authenticate')).not.toContain('resource_metadata');
  });

  it('rate-limits a token per client, not per member', async () => {
    for (let i = 0; i < TOOL_ENDPOINT_RATE_LIMITS.callsPerMinute; i += 1) {
      await serveToolEndpoint(call('ping', undefined, { identity: 'oauth' }), 'support');
    }
    const limited = await serveToolEndpoint(
      call('ping', undefined, { identity: 'oauth' }),
      'support',
    );
    expect(limited.status).toBe(429);
    expect((await serveToolEndpoint(call('ping'), 'support')).status).toBe(200);
  });
});

describe('POST /mcp/projects/:name rate limit', () => {
  it('admits the limit, then answers 429 with Retry-After, per key', async () => {
    const limit = TOOL_ENDPOINT_RATE_LIMITS.callsPerMinute;
    for (let i = 0; i < limit; i += 1) {
      expect((await serveToolEndpoint(call('ping'), 'support')).status).toBe(200);
    }
    const limited = await serveToolEndpoint(call('ping'), 'support');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(
      (await serveToolEndpoint(call('ping', undefined, { identity: 'second' }), 'support')).status,
    ).toBe(200);
    clock += 61_000;
    expect((await serveToolEndpoint(call('ping'), 'support')).status).toBe(200);
  });

  it('counts a refused 403 and an unknown 404 against the budget, so probing is bounded', async () => {
    const limit = TOOL_ENDPOINT_RATE_LIMITS.callsPerMinute;
    for (let i = 0; i < limit; i += 1) {
      const response = await serveToolEndpoint(
        call('ping', undefined, { name: 'missing' }),
        'missing',
      );
      expect(response.status).toBe(404);
    }
    expect((await serveToolEndpoint(call('ping'), 'support')).status).toBe(429);
  });

  it('counts a browser-origin 403', async () => {
    const limit = TOOL_ENDPOINT_RATE_LIMITS.callsPerMinute;
    for (let i = 0; i < limit; i += 1) {
      const response = await serveToolEndpoint(
        call('ping', undefined, { headers: { Origin: 'https://evil.example' } }),
        'support',
      );
      expect(response.status).toBe(403);
    }
    expect((await serveToolEndpoint(call('ping'), 'support')).status).toBe(429);
  });
});

describe('POST /mcp/projects/:name tenancy', () => {
  it('answers 404 for a name the key does not own', async () => {
    clients.set(OTHER_CLIENT, client({ id: OTHER_CLIENT, name: 'billing' }));
    const response = await serveToolEndpoint(
      call('tools/list', undefined, { name: 'billing' }),
      'billing',
    );
    expect(response.status).toBe(404);
    expect(routed).toEqual([]);
  });

  it("answers 404 for another workspace's client, the same as one that does not exist", async () => {
    const response = await serveToolEndpoint(
      call('tools/list', undefined, { identity: 'otherTenant' }),
      'support',
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(
      await (
        await serveToolEndpoint(call('tools/list', undefined, { name: 'nope' }), 'nope')
      ).json(),
    );
  });

  it('answers 404 for a key scoped to a client that is gone', async () => {
    const response = await serveToolEndpoint(
      call('tools/list', undefined, { identity: 'otherClient' }),
      'support',
    );
    expect(response.status).toBe(404);
  });

  it('answers 404 for a revoked client and for a client of another kind', async () => {
    clients.set(CLIENT, client({ revokedAt: '2026-02-01T00:00:00.000Z' }));
    expect((await serveToolEndpoint(call('tools/list'), 'support')).status).toBe(404);
    clients.set(CLIENT, client({ kind: 'a2a-agent' }));
    expect((await serveToolEndpoint(call('tools/list'), 'support')).status).toBe(404);
  });

  it('answers 404 for a name that is not a valid project name', async () => {
    const response = await serveToolEndpoint(
      call('tools/list', undefined, { name: 'Not A Name' }),
      'Not A Name',
    );
    expect(response.status).toBe(404);
  });
});

describe('POST /mcp/projects/:name run permission', () => {
  beforeEach(() => {
    clients.set(CLIENT, client({ agentIds: [AGENT, SECOND_AGENT] }));
    bundles = { [AGENT]: [BUNDLE], [SECOND_AGENT]: [OTHER_BUNDLE] };
  });

  it('serves no tool to a key whose member may run no agent of the client', async () => {
    // A Viewer that neither owns nor was granted either agent (a Viewer runs its own since ADR-0152).
    ownership = () => 'other';
    const listed = await serveToolEndpoint(
      call('tools/list', undefined, { identity: 'viewer' }),
      'support',
    );
    expect(listed.status).toBe(200);
    expect((await bodyOf(listed)).result).toEqual({ tools: [] });
    const called = await serveToolEndpoint(toolCall('lookup', { identity: 'viewer' }), 'support');
    expect((await bodyOf(called)).error?.code).toBe(-32602);
    expect(routed).toEqual([]);
  });

  it.each(['other', 'unknown'] as const)(
    "drops an agent whose ownership is %s from the union and serves the other agent's tools",
    async (refused) => {
      ownership = (agentId) => (agentId === SECOND_AGENT ? refused : 'own');
      expect((await serveToolEndpoint(call('tools/list'), 'support')).status).toBe(200);
      expect(routed).toEqual([{ workspaceId: WORKSPACE, clientId: CLIENT, bundles: ['lookup'] }]);
      const dropped = await serveToolEndpoint(toolCall('other'), 'support');
      expect((await bodyOf(dropped)).error?.code).toBe(-32602);
      expect(routed).toHaveLength(1);
    },
  );
});

describe('POST /mcp/projects/:name protocol', () => {
  it('answers ping locally', async () => {
    const response = await serveToolEndpoint(call('ping'), 'support');
    expect(await bodyOf(response)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(upstreamCalls).toEqual([]);
  });

  it('answers initialize itself and never opens a sandbox', async () => {
    ownership = () => 'unknown';
    const asked = await serveToolEndpoint(
      call('initialize', { protocolVersion: '2025-03-26', capabilities: {} }),
      'support',
    );
    expect(await bodyOf(asked)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-workspace-tools', version: '1.0.0' },
      },
    });
    const unknown = await serveToolEndpoint(
      call('initialize', { protocolVersion: '1999-01-01' }),
      'support',
    );
    expect((await bodyOf(unknown)).result).toMatchObject({ protocolVersion: '2025-06-18' });
    expect(events).toEqual([]);
  });

  it('acknowledges a message with no id with 202, whatever its method, and forwards nothing', async () => {
    const raw = (method: string) => JSON.stringify({ jsonrpc: '2.0', method, params: {} });
    const initialized = await serveToolEndpoint(
      call('x', undefined, { raw: raw('notifications/initialized') }),
      'support',
    );
    expect(initialized.status).toBe(202);
    const toolCallNotification = await serveToolEndpoint(
      call('x', undefined, { raw: raw('tools/call') }),
      'support',
    );
    expect(toolCallNotification.status).toBe(202);
    expect(events).toEqual([]);
  });

  it('answers a notifications/ method that carries an id as a request', async () => {
    const response = await serveToolEndpoint(call('notifications/x'), 'support');
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).error?.code).toBe(-32601);
  });

  it.each(['GET', 'DELETE'])('answers %s with 405 and Allow: POST', async (method) => {
    const response = await serveToolEndpoint(
      new Request(`${URL_BASE}/support`, {
        method,
        headers: { Authorization: `Bearer ${SECRET}`, 'x-test-identity': 'key' },
      }),
      'support',
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  it('answers 413 for a body one byte over 1 MiB, counted or declared', async () => {
    const over = 'x'.repeat(TOOL_ENDPOINT_MAX_BODY_BYTES + 1);
    const counted = await serveToolEndpoint(call('x', undefined, { raw: over }), 'support');
    expect(counted.status).toBe(413);
    expect(await apiCodeOf(counted)).toBe('tool_endpoint_body_too_large');
    const declared = await serveToolEndpoint(
      call('ping', undefined, {
        headers: { 'Content-Length': String(TOOL_ENDPOINT_MAX_BODY_BYTES + 1) },
      }),
      'support',
    );
    expect(declared.status).toBe(413);
    expect(events).toEqual([]);
  });

  it('answers 400 for an MCP-Protocol-Version it does not speak', async () => {
    const response = await serveToolEndpoint(
      call('tools/list', undefined, { headers: { 'MCP-Protocol-Version': '2024-11-05' } }),
      'support',
    );
    expect(response.status).toBe(400);
    expect(await apiCodeOf(response)).toBe('mcp_protocol_version_unsupported');
    expect(events).toEqual([]);
  });

  it('answers a method the endpoint does not serve with -32601', async () => {
    const response = await serveToolEndpoint(call('resources/list'), 'support');
    expect((await bodyOf(response)).error?.code).toBe(-32601);
  });

  it('answers a body that is not JSON with -32700 and a batch or non-envelope with 400 invalid_mcp_message', async () => {
    const notJson = await serveToolEndpoint(call('x', undefined, { raw: '{nope' }), 'support');
    expect(notJson.status).toBe(400);
    expect((await bodyOf(notJson)).error?.code).toBe(-32700);
    for (const raw of [
      '[1]',
      JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
      '{"jsonrpc":"1.0","method":"ping","id":1}',
    ]) {
      const refused = await serveToolEndpoint(call('x', undefined, { raw }), 'support');
      expect(refused.status).toBe(400);
      expect(await apiCodeOf(refused)).toBe('invalid_mcp_message');
    }
    expect(events).toEqual([]);
  });

  it.each(['ping', 'initialize', 'tools/list'])(
    'refuses an object, array or boolean id on %s instead of echoing it',
    async (method) => {
      for (const id of [{ nested: 'x' }, [1], true]) {
        const refused = await serveToolEndpoint(
          call('x', undefined, { raw: JSON.stringify({ jsonrpc: '2.0', id, method }) }),
          'support',
        );
        expect(refused.status).toBe(400);
        expect(await apiCodeOf(refused)).toBe('invalid_mcp_message');
      }
      expect(events).toEqual([]);
    },
  );

  it('lists no tools and refuses a call with -32602 when the client publishes no production code tool', async () => {
    bundles = {};
    const listed = await serveToolEndpoint(call('tools/list'), 'support');
    expect(listed.status).toBe(200);
    expect(await bodyOf(listed)).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    const called = await serveToolEndpoint(toolCall('lookup'), 'support');
    expect((await bodyOf(called)).error?.code).toBe(-32602);
    expect(events).toEqual([]);
  });

  it('answers -32603 tool_name_conflict when two agents pin different code under one tool name', async () => {
    bundles = { [AGENT]: [BUNDLE, { ...BUNDLE, digest: 'sha256:' + 'c'.repeat(64) }] };
    const response = await serveToolEndpoint(call('tools/list'), 'support');
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).error).toMatchObject({
      code: -32603,
      data: { code: 'tool_name_conflict', tool: 'lookup' },
    });
    expect(routed).toEqual([]);
  });
});

describe('POST /mcp/projects/:name forwarding', () => {
  it('forwards tools/list to the gateway under the grant, and not under the API key', async () => {
    const response = await serveToolEndpoint(
      call('tools/list', undefined, { headers: { 'MCP-Protocol-Version': '2025-06-18' } }),
      'support',
    );
    expect(response.status).toBe(200);
    expect(routed).toEqual([
      { workspaceId: WORKSPACE, clientId: CLIENT, bundles: ['lookup', 'other'] },
    ]);
    const [forwarded] = upstreamCalls;
    expect(forwarded?.url).toBe(GATEWAY_URL);
    const headers = forwarded?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${GRANT}`);
    expect(headers['x-aw-agent']).toBe('support');
    expect(headers['MCP-Protocol-Version']).toBe('2025-06-18');
    expect(JSON.stringify(forwarded?.init)).not.toContain(SECRET);
    expect(audits).toEqual([]);
  });

  it('narrows the tools a client publishes by its tool allow-list', async () => {
    clients.set(CLIENT, client({ toolNames: ['other'] }));
    await serveToolEndpoint(call('tools/list'), 'support');
    expect(routed[0]?.bundles).toEqual(['other']);
    const refused = await serveToolEndpoint(toolCall('lookup'), 'support');
    expect((await bodyOf(refused)).error?.code).toBe(-32602);
    expect(upstreamCalls).toHaveLength(1);
  });

  it('records an endpoint-tool-called audit row before it forwards a tool call', async () => {
    const response = await serveToolEndpoint(toolCall('lookup'), 'support');
    expect(response.status).toBe(200);
    expect(events).toEqual(['audit', 'route', 'forward']);
    expect(audits).toEqual([
      {
        workspaceId: WORKSPACE,
        event: {
          action: 'endpoint-tool-called',
          subjectId: CLIENT,
          subjectLabel: 'support/lookup',
        },
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    expect(JSON.stringify(audits)).not.toContain(GRANT);
  });

  it('answers 500 and runs no tool when the audit row cannot be written', async () => {
    auditFails = new Error(`audit store down ${SECRET}`);
    const logged = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const request = toolCall('lookup');
    const response = await POST(
      new NextRequest(request.url, {
        method: 'POST',
        headers: request.headers,
        body: await request.text(),
      }),
      { params: Promise.resolve({ name: 'support' }) },
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(SECRET);
    expect(events).toEqual(['audit']);
    expect(routed).toEqual([]);
    expect(upstreamCalls).toEqual([]);
    expect(logged).toHaveBeenCalled();
  });

  it('answers a tool the client does not publish with -32602 and neither audits nor forwards', async () => {
    const response = await serveToolEndpoint(toolCall('missing'), 'support');
    expect((await bodyOf(response)).error?.code).toBe(-32602);
    expect(events).toEqual([]);
  });

  it('passes the gateway answer through, with no-store', async () => {
    upstream = () =>
      Promise.resolve(
        new Response('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'set-cookie': 'a=b' },
        }),
      );
    const response = await serveToolEndpoint(call('tools/list'), 'support');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(await response.text()).toContain('"tools"');
  });

  it('answers 503 without a secret, an address or the grant when the sandbox cannot be reached', async () => {
    routeFails = new Error(`cannot open ${SECRET} at http://10.0.0.7:4000`);
    const logged = captureLog();
    const response = await serveToolEndpoint(toolCall('lookup'), 'support');
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('10.0.0.7');
    expect(logged.text()).not.toContain(SECRET);
    expect(logged.text()).not.toContain('10.0.0.7');
  });

  it.each(['code_tool_unbundled', 'code_tool_bundle_missing'])(
    'answers the sandbox request refusal %s with -32603 and its code, not 503',
    async (code) => {
      routeFails = new DomainError({ category: 'validation', code, publicMessage: code });
      const response = await serveToolEndpoint(toolCall('lookup'), 'support');
      expect(response.status).toBe(200);
      expect((await bodyOf(response)).error).toMatchObject({ code: -32603, data: { code } });
      expect(upstreamCalls).toEqual([]);
    },
  );

  it('answers 503 when the gateway call throws', async () => {
    upstream = () => Promise.reject(new Error(`ECONNREFUSED ${GRANT}`));
    const logged = captureLog();
    const response = await serveToolEndpoint(call('tools/list'), 'support');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(GRANT);
    expect(logged.text()).not.toContain(GRANT);
  });
});
