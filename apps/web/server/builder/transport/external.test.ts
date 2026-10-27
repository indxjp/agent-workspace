/**
 * [US-BLD-04][api][run] `POST /mcp/builder` (issue #1846 slice 5b): an outside MCP client holding a
 * `builder` OAuth token reads with the three read tools and is refused every write or spend tool
 * before any port. The door is served over the e2e harness's production ports with only the
 * `builder` feature input replaced, as `mcp.test.ts`'s sibling e2e suites do.
 */
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import {
  BUILDER_REFUSAL_CODES,
  BUILDER_TOOL_NAMES,
  BUILDER_TOOLS,
} from '@indx-workspace/contracts/builder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { draftBody } from '../adapters/checker/checker.contract';
import { WORKSPACE, builderDoor, type Door } from './e2e/harness';
import { serveExternalBuilderMcp, toExternalCallContext, type ExternalPrincipal } from './external';

const ORIGIN = 'https://aw.example.test';
const READ_TOOLS = BUILDER_TOOL_NAMES.filter((name) => BUILDER_TOOLS[name].kind === 'read');

const builderPrincipal = (over: Partial<ExternalPrincipal> = {}): ExternalPrincipal => ({
  via: 'oauth-token',
  oauth: { clientId: 'client-1', audience: `${ORIGIN}/mcp/builder` },
  scope: { kind: 'builder', id: 'client-1' },
  workspaceId: WORKSPACE,
  principalId: 'principal-builder',
  ownerPrincipalId: 'principal-builder',
  userId: 'user-builder',
  role: 'builder',
  apiKeyId: null,
  ...over,
});

function rpc(method: string, params?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/mcp/builder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer awo_live_x', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly result: Record<string, unknown> | null;
}

describe('[US-BLD-04][api][run] POST /mcp/builder', () => {
  let door: Door;
  const serve = async (
    request: Request,
    principal: ExternalPrincipal | null = builderPrincipal(),
    ports: Door['ports'] | null = door.ports,
  ): Promise<Answer> => {
    const response = await serveExternalBuilderMcp(request, {
      identify: () => Promise.resolve(principal),
      ports,
    });
    const body = (await response.json()) as Record<string, unknown>;
    const [content] =
      (body['result'] as { content?: { text: string }[] } | undefined)?.content ?? [];
    return {
      status: response.status,
      body,
      result: content === undefined ? null : (JSON.parse(content.text) as Record<string, unknown>),
    };
  };
  const callTool = (name: string, args: unknown = {}, headers: Record<string, string> = {}) =>
    serve(rpc('tools/call', { name, arguments: args }, headers));

  beforeEach(() => {
    vi.stubEnv('AW_PUBLIC_URL', ORIGIN);
    door = builderDoor({
      featureOn: true,
      scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("an outside client's tools/list returns exactly the three read tools, and draft_save gets read_only_client", async () => {
    const listed = await serve(rpc('tools/list'));
    const names = (listed.body['result'] as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(['catalog_list', 'examples_get', 'draft_check']);
    expect(names).toEqual(READ_TOOLS);

    const saved = await callTool('draft_save', { body: draftBody('Order desk', ['crm']) });
    expect(saved.result).toMatchObject({
      ok: false,
      code: 'read_only_client',
      fix: BUILDER_REFUSAL_CODES.read_only_client.fix,
    });
    expect(door.portCalls).toEqual([]);
    expect(door.journal).toEqual([]);
  });
  it.each([
    'Draft_Save',
    'draft_save ',
    'mcp__aw-control__draft_save',
    ' draft_save',
    'DRAFT_SAVE',
  ])('matches tool names exactly: %j is unknown_tool and reaches no port', async (name) => {
    const answer = await callTool(name, { body: draftBody('Order desk', ['crm']) });
    expect(answer.result).toMatchObject({ ok: false, code: 'unknown_tool' });
    expect(door.portCalls).toEqual([]);
    expect(door.journal).toEqual([]);
  });

  it.each(['draft_save', 'evals_run', 'trial_run'])(
    '%s is read_only_client before any port, even with the feature on and no arguments',
    async (name) => {
      const answer = await callTool(name);
      expect(answer.result).toMatchObject({ ok: false, code: 'read_only_client' });
      expect(door.portCalls).toEqual([]);
      expect(door.journal).toEqual([]);
    },
  );

  it('runs a read tool through the core: RBAC, the journal row and the external run id', async () => {
    const answer = await callTool(
      'catalog_list',
      { kinds: ['engines'] },
      { 'mcp-session-id': 'sess-1' },
    );
    expect(answer.result).toMatchObject({ ok: true });
    expect(door.portCalls).toContain('authorization.access');
    const [row, ...rest] = door.journal;
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      runId: 'ext:client-1:sess-1',
      tool: 'catalog_list',
    });
    expect(row?.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("applies the member's role: a role the RBAC does not know fails closed", async () => {
    const odd = builderPrincipal({ role: 'superuser' as ExternalPrincipal['role'] });
    const answer = await serve(rpc('tools/call', { name: 'catalog_list', arguments: {} }), odd);
    expect(answer.result).toMatchObject({ ok: false, code: 'not_permitted' });
  });

  it('is builder_disabled for a read while the production feature input is off', async () => {
    door = builderDoor({
      featureOn: false,
      scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
    });
    const answer = await callTool('catalog_list');
    expect(answer.result).toMatchObject({ ok: false, code: 'builder_disabled' });
    const none = await serve(rpc('tools/call', { name: 'catalog_list' }), builderPrincipal(), null);
    expect(none.result).toMatchObject({ ok: false, code: 'builder_disabled' });
  });

  describe('the call context', () => {
    const ctxOf = (headers: Record<string, string>) =>
      toExternalCallContext(builderPrincipal(), new Headers(headers));

    it('takes workspace and caller from the principal, and fixes model and prompt version', () => {
      const ctx = ctxOf({ traceparent: '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01' });
      expect(ctx).toMatchObject({
        workspaceId: WORKSPACE,
        modelId: 'external',
        promptVersion: 'external',
        caller: {
          kind: 'person',
          principal: { principalId: 'principal-builder', role: 'builder' },
        },
      });
      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx.traceId).not.toContain('a'.repeat(32));
    });

    it('binds a valid session id to the client: the run id is ext:<client>:<session>, else a fresh uuid', () => {
      expect(ctxOf({ 'mcp-session-id': 'abc_DEF-1.2~3' }).runId).toBe('ext:client-1:abc_DEF-1.2~3');
      const uuid = /^ext:[0-9a-f-]{36}$/;
      for (const bad of ['', 'a b', 'x'.repeat(65), 'a/b', "a'b"]) {
        expect(ctxOf({ 'mcp-session-id': bad }).runId).toMatch(uuid);
      }
      expect(ctxOf({}).runId).toMatch(uuid);
      expect(ctxOf({}).runId).not.toBe(ctxOf({}).runId);
    });
  });

  it('gives two clients that send the same session id different run ids, journal rows and run counts', async () => {
    const other = builderPrincipal({
      oauth: { clientId: 'client-2', audience: `${ORIGIN}/mcp/builder` },
      scope: { kind: 'builder', id: 'client-2' },
    });
    const headers = { 'mcp-session-id': 'shared' };
    const call = rpc('tools/call', { name: 'catalog_list', arguments: {} }, headers);
    await serve(call.clone());
    await serve(call.clone(), other);
    expect(door.journal.map((row) => row.runId)).toEqual([
      'ext:client-1:shared',
      'ext:client-2:shared',
    ]);
    for (const principal of [builderPrincipal(), other]) {
      const ctx = toExternalCallContext(principal, new Headers(headers));
      expect((await door.ports.audit.runCounts(ctx)).toolCalls).toBe(1);
    }
  });

  describe('credentials', () => {
    const refused = async (
      request: Request,
      principal: ExternalPrincipal | null,
      status: number,
    ) => {
      const answer = await serve(request, principal);
      expect(answer.status).toBe(status);
      expect(door.portCalls).toEqual([]);
      expect(door.journal).toEqual([]);
      return answer;
    };

    it('answers 401 with the resource challenge when nothing or nobody authenticates', async () => {
      const bare = new Request(`${ORIGIN}/mcp/builder`, { method: 'POST', body: '{}' });
      for (const request of [bare, rpc('tools/list')]) {
        const response = await serveExternalBuilderMcp(request, {
          identify: () => Promise.resolve(null),
          ports: door.ports,
        });
        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toContain(
          `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/builder"`,
        );
      }
    });

    it('refuses a builder-scoped token whose audience is another URL', async () => {
      await refused(
        rpc('tools/list'),
        builderPrincipal({ oauth: { clientId: 'client-1', audience: `${ORIGIN}/mcp/builder/` } }),
        401,
      );
    });

    it('refuses an endpoint-scoped token of the right audience but another kind', async () => {
      await refused(
        rpc('tools/list'),
        builderPrincipal({ scope: { kind: 'mcp-project', id: 'client-1' } }),
        403,
      );
    });

    it('refuses a browser Origin', async () => {
      await refused(
        rpc('tools/list', undefined, { origin: 'https://evil.example' }),
        builderPrincipal(),
        403,
      );
    });

    it('answers 405 to anything but POST', async () => {
      const response = await serveExternalBuilderMcp(new Request(`${ORIGIN}/mcp/builder`), null);
      expect(response.status).toBe(405);
    });
  });
});
