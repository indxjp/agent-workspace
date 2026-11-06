import { ApiProblemSchema } from '@indx-workspace/contracts';
import {
  IDENTITY_ASSERTION_HEADER,
  signIdentity,
  type IdentityAssertionPayload,
} from '@indx-workspace/contracts/identity-assertion';
import type { MembershipRoleName } from '@indx-workspace/contracts/team';
import { fetchDouble, jsonResponse } from '@indx-workspace/sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defineApp } from '../app.js';
import { enumOf, number, person, text } from '../fields/index.js';
import { defineResource, type AccessRule } from '../resource.js';
import { FAKE_WORKSPACE_ID, fakePerson } from '../testing/fake-person.js';
import type { MemoryResourceStore } from '../testing/memory-store.js';
import {
  resetAppRuntimeForTests,
  setAppRuntimeForTests,
  type TestAppRuntime,
} from '../testing/runtime.js';
import { AGENT_TOOL_FAILURE_MESSAGE, mcpEndpoint } from './mcp.js';

const CONNECTOR_ID = 'conn_service_desk';
const CURRENT_SECRET = 'current-signing-secret';
const PREVIOUS_SECRET = 'previous-signing-secret';
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002';
const URL_OF_MCP = 'https://app.test/api/mcp';

function ticketsWith(update: AccessRule) {
  return defineResource({
    name: 'ticket',
    fields: {
      title: text({ max: 200 }),
      status: enumOf(['open', 'closed'], { default: 'open' }),
      priority: number({ optional: true }),
      owner: person({ optional: true }),
    },
    access: { read: ['member', 'owner'], create: 'member', update, delete: 'role:admin' },
    agents: { read: true, write: ['status'] },
    search: ['title'],
  });
}

const tickets = ticketsWith('role:admin');
const secrets = defineResource({
  name: 'secret',
  fields: { title: text() },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
});
const app = defineApp({ name: 'service-desk', resources: [tickets, secrets] });
const endpoint = mcpEndpoint(app);

/** The workspace's members, as `GET /api/memberships` lists them. */
const members = new Map<string, MembershipRoleName>();

const platform = fetchDouble((request) => {
  if (request.url.pathname !== '/api/memberships') {
    return jsonResponse(404, { error: { code: 'not_found', message: 'No route.' } });
  }
  return jsonResponse(200, {
    memberships: [...members].map(([principalId, role]) => ({
      id: crypto.randomUUID(),
      principalId,
      userId: crypto.randomUUID(),
      email: `${principalId}@example.test`,
      name: 'Someone',
      role,
      createdAt: '2026-10-01T00:00:00.000Z',
    })),
  });
});

let runtime: TestAppRuntime;

beforeEach(() => {
  members.clear();
  platform.calls.length = 0;
  runtime = setAppRuntimeForTests({
    appName: 'service-desk',
    fetch: platform.fetch,
    agentTools: {
      connectorId: CONNECTOR_ID,
      workspaceId: FAKE_WORKSPACE_ID,
      identitySecrets: [CURRENT_SECRET, PREVIOUS_SECRET],
      apiKey: 'ak_live_app_machine_key',
    },
  });
});

afterEach(() => {
  resetAppRuntimeForTests();
  vi.restoreAllMocks();
});

function member(role: MembershipRoleName): string {
  const id = crypto.randomUUID();
  members.set(id, role);
  return id;
}

function payloadOf(overrides: Partial<IdentityAssertionPayload> = {}): IdentityAssertionPayload {
  return {
    sub: crypto.randomUUID(),
    principalKind: 'membership',
    workspace: FAKE_WORKSPACE_ID,
    runId: `run_${crypto.randomUUID()}`,
    aud: CONNECTOR_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}

function assertionFor(
  overrides: Partial<IdentityAssertionPayload> = {},
  secret = CURRENT_SECRET,
): Promise<string> {
  return signIdentity(payloadOf(overrides), secret);
}

function rpc(assertion: string | null, body: unknown, method = 'POST'): Request {
  return new Request(URL_OF_MCP, {
    method,
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(assertion === null ? {} : { [IDENTITY_ASSERTION_HEADER]: assertion }),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

const LIST_TOOLS = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

function callOf(name: string, args: unknown): unknown {
  return { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } };
}

interface ToolResult {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
}

async function callTool(assertion: string, name: string, args: unknown): Promise<ToolResult> {
  const response = await endpoint.POST(rpc(assertion, callOf(name, args)));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result?: ToolResult; error?: unknown };
  if (body.result === undefined) throw new Error(`not a result: ${JSON.stringify(body)}`);
  return body.result;
}

function storeCalls(store: MemoryResourceStore): number {
  return Object.values(store.calls).reduce((sum, count) => sum + count, 0);
}

async function seed(fields: Record<string, unknown> = {}, resource = tickets): Promise<string> {
  const admin = fakePerson({ role: 'admin' });
  const record = await runtime.storeOf(resource).create(admin, { title: 'Printer jam', ...fields });
  return record.id;
}

describe('mcpEndpoint refuses before any store call', () => {
  it.each([
    ['a missing header', () => Promise.resolve(null), 'identity_assertion_invalid'],
    [
      'a bad signature',
      () => assertionFor({}, 'not-the-signing-secret'),
      'identity_assertion_invalid',
    ],
    [
      'an expired assertion',
      () => assertionFor({ exp: Math.floor(Date.now() / 1000) - 120 }),
      'identity_assertion_expired',
    ],
    [
      'another connector’s assertion',
      () => assertionFor({ aud: 'conn_other' }),
      'identity_audience_mismatch',
    ],
    [
      'another workspace’s assertion',
      () => assertionFor({ workspace: OTHER_WORKSPACE_ID }),
      'identity_workspace_mismatch',
    ],
  ] as const)('answers %s with 401 %s', async (_name, mint, code) => {
    const id = await seed();
    const store = runtime.storeOf(tickets);
    const before = storeCalls(store);
    const errors = vi.spyOn(console, 'error');
    const assertion = await mint();
    const response = await endpoint.POST(rpc(assertion, callOf('ticket_get', { id })));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const raw = await response.text();
    expect(ApiProblemSchema.parse(JSON.parse(raw)).error.code).toBe(code);
    if (assertion !== null) expect(raw).not.toContain(assertion);
    expect(storeCalls(store)).toBe(before);
    expect(platform.calls).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('accepts an assertion signed with the previous secret during a rotation', async () => {
    const sub = member('viewer');
    const assertion = await assertionFor({ sub }, PREVIOUS_SECRET);
    const result = await callTool(assertion, 'ticket_list', {});
    expect(result.isError).toBeUndefined();
  });

  it.each(['GET', 'DELETE'] as const)('answers %s with 405 and allow: POST', async (method) => {
    const response = await endpoint[method](rpc(null, null, method));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(ApiProblemSchema.parse(await response.json()).error.code).toBe('method_not_allowed');
  });

  it('answers 500 app_misconfigured without the agent tools’ settings', async () => {
    setAppRuntimeForTests({ fetch: platform.fetch });
    const response = await endpoint.POST(rpc(await assertionFor(), LIST_TOOLS));
    expect(response.status).toBe(500);
    expect(ApiProblemSchema.parse(await response.json()).error.code).toBe('app_misconfigured');
  });
});

describe('tools/list', () => {
  it('lists only the tools the resources allow, update with only the agents.write fields', async () => {
    const response = await endpoint.POST(rpc(await assertionFor(), LIST_TOOLS));
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = (await response.json()) as {
      result: { tools: { name: string; inputSchema: { properties: object } }[] };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      'ticket_list',
      'ticket_get',
      'ticket_search',
      'ticket_update',
    ]);
    const update = body.result.tools.find((tool) => tool.name === 'ticket_update');
    expect(Object.keys(update?.inputSchema.properties ?? {})).toEqual(['id', 'status']);
  });
});

describe('an app with no resources', () => {
  // The portal template and `aw generate app` write `resources: []`; `aw dev` waits for GET 405.
  const pagesOnly = mcpEndpoint(defineApp({ name: 'portal', resources: [] }));

  it('answers GET with 405, as aw dev waits for', async () => {
    const response = await pagesOnly.GET(rpc(null, null, 'GET'));
    expect(response.status).toBe(405);
  });

  it('lists no tools', async () => {
    const response = await pagesOnly.POST(rpc(await assertionFor(), LIST_TOOLS));
    const body = (await response.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools).toEqual([]);
  });
});

describe('tools/call', () => {
  it('an agent write beyond agents.write is refused', async () => {
    const id = await seed();
    const assertion = await assertionFor({ sub: member('owner') });
    const result = await callTool(assertion, 'ticket_update', { id, priority: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^forbidden: .*fields:priority/u);
    expect(runtime.storeOf(tickets).calls.update).toBe(0);
  });

  it('an agent cannot exceed the person’s access', async () => {
    const id = await seed();
    const assertion = await assertionFor({ sub: member('builder') });
    const result = await callTool(assertion, 'ticket_update', { id, status: 'closed' });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'forbidden' } },
    });
    expect(result.content[0]?.text).toMatch(/^forbidden: /u);
    expect((await runtime.storeOf(tickets).get(fakePerson(), id)).status).toBe('open');
  });

  it('an api-key principal with no person-field match reads nothing', async () => {
    const id = await seed();
    const sub = member('owner');
    const assertion = await assertionFor({ sub, principalKind: 'api-key' });
    expect(await callTool(assertion, 'ticket_list', {})).toMatchObject({
      structuredContent: { items: [], nextCursor: null },
    });
    const got = await callTool(assertion, 'ticket_get', { id });
    expect(got.isError).toBe(true);
    expect(got.content[0]?.text).toMatch(/^resource_not_found: /u);
    expect(platform.calls).toHaveLength(0);
  });

  it('an api-key principal named in a person() field reads that record', async () => {
    const sub = crypto.randomUUID();
    const id = await seed({ owner: sub });
    const assertion = await assertionFor({ sub, principalKind: 'api-key' });
    expect(await callTool(assertion, 'ticket_get', { id })).toMatchObject({
      structuredContent: { id, owner: sub },
    });
  });

  it('an update writes one audit row carrying the run, via agent', async () => {
    const id = await seed();
    const sub = member('admin');
    const runId = `run_${crypto.randomUUID()}`;
    const assertion = await assertionFor({ sub, runId });
    const result = await callTool(assertion, 'ticket_update', { id, status: 'closed' });
    expect(result.structuredContent).toMatchObject({ id, status: 'closed', updated_by: sub });
    const updates = runtime
      .storeOf(tickets)
      .auditEvents()
      .filter((event) => event.action === 'update');
    expect(updates).toEqual([
      expect.objectContaining({
        actor: sub,
        via: 'agent',
        run_id: runId,
        record_id: id,
        fields: ['status'],
      }),
    ]);
    expect(platform.calls[0]?.headers.get('authorization')).toBe('Bearer ak_live_app_machine_key');
  });

  it('looks the members up once for several calls', async () => {
    const assertion = await assertionFor({ sub: member('viewer') });
    await callTool(assertion, 'ticket_list', {});
    await callTool(assertion, 'ticket_search', { q: 'printer' });
    expect(platform.calls).toHaveLength(1);
  });

  it('an internal error returns the fixed text, never the thrown message', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(runtime.storeOf(tickets), 'list').mockRejectedValue(
      new Error('connect ECONNREFUSED db.internal:5432 password=s3cret'),
    );
    const assertion = await assertionFor({ sub: member('viewer') });
    const response = await endpoint.POST(rpc(assertion, callOf('ticket_list', {})));
    const raw = await response.text();
    expect(JSON.parse(raw)).toMatchObject({
      error: { code: -32603, message: `MCP error -32603: ${AGENT_TOOL_FAILURE_MESSAGE}` },
    });
    expect(raw).not.toContain('db.internal');
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/db\.internal|s3cret/u);
  });

  it('answers an unknown tool as a tool error', async () => {
    const assertion = await assertionFor();
    const result = await callTool(assertion, 'secret_list', {});
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toMatch(/^unknown_tool: /u);
  });
});

/** Who asks, in the access matrix: a membership's role, or an api-key subject. */
interface Asker {
  readonly label: string;
  readonly kind: 'membership' | 'api-key';
  /** The role a membership subject holds; `null` when not a member. */
  readonly role: MembershipRoleName | null;
  /** Whether the record's `owner` person field names the asker. */
  readonly owns: boolean;
}

const ASKERS: readonly Asker[] = [
  { label: 'an owner', kind: 'membership', role: 'owner', owns: false },
  { label: 'an admin', kind: 'membership', role: 'admin', owns: false },
  { label: 'a builder', kind: 'membership', role: 'builder', owns: false },
  { label: 'a viewer', kind: 'membership', role: 'viewer', owns: false },
  { label: 'a viewer named in owner', kind: 'membership', role: 'viewer', owns: true },
  { label: 'a non-member', kind: 'membership', role: null, owns: false },
  { label: 'an api-key subject listed as an admin', kind: 'api-key', role: 'admin', owns: false },
  { label: 'an api-key subject named in owner', kind: 'api-key', role: null, owns: true },
];

const RANK: Readonly<Record<MembershipRoleName, number>> = {
  viewer: 0,
  builder: 1,
  admin: 2,
  owner: 3,
};

const RULES: readonly AccessRule[] = ['member', 'role:admin', 'owner'];
const FIELDS = [
  ['status', 'closed', true],
  ['priority', 2, false],
] as const;

/** What the matrix expects, worked out apart from the store's own policy. */
function expected(rule: AccessRule, asker: Asker, writable: boolean): string {
  if (!writable) return 'forbidden';
  const role = asker.kind === 'membership' ? asker.role : null;
  if (role === null && !asker.owns) return 'resource_not_found';
  const allowed =
    rule === 'member'
      ? role !== null
      : rule === 'role:admin'
        ? role !== null && RANK[role] >= RANK.admin
        : asker.owns;
  return allowed ? 'ok' : 'forbidden';
}

describe('the access matrix: rule kind × person × agent field', () => {
  const cases = RULES.flatMap((rule) =>
    ASKERS.flatMap((asker) =>
      FIELDS.map(([field, value, writable]) => ({
        rule,
        asker,
        field,
        value,
        outcome: expected(rule, asker, writable),
      })),
    ),
  );

  it.each(cases)(
    'update: $rule, $asker.label, $field → $outcome',
    async ({ rule, asker, field, value, outcome }) => {
      const resource = ticketsWith(rule);
      const endpointOf = mcpEndpoint(defineApp({ name: 'service-desk', resources: [resource] }));
      const sub = crypto.randomUUID();
      if (asker.role !== null) members.set(sub, asker.role);
      const id = await seed(asker.owns ? { owner: sub } : {}, resource);
      const assertion = await assertionFor({ sub, principalKind: asker.kind });
      const response = await endpointOf.POST(
        rpc(assertion, callOf('ticket_update', { id, [field]: value })),
      );
      const { result } = (await response.json()) as { result: ToolResult };
      const code = result.isError === true ? result.content[0]?.text.split(':')[0] : 'ok';
      expect(code).toBe(outcome);
      const stored = await runtime.storeOf(resource).get(fakePerson({ role: 'owner' }), id);
      expect(stored[field]).toBe(outcome === 'ok' ? value : field === 'status' ? 'open' : null);
    },
  );
});
