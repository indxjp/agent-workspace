import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartRunRequestSchema } from '@indx-workspace/contracts/runs';
import { NextRequest } from 'next/server';

import { POST as routeStart } from '../app/api/agents/[id]/runs/route';
import { GET as routeList } from '../app/api/runs/route';
import { GET as routeRead, POST as routeRevokeAlias } from '../app/api/runs/[id]/route';
import { POST as routeRevoke } from '../app/api/runs/[id]/revoke-tokens/route';
import { GET as routeStream } from '../app/api/runs/[id]/events/route';
import { POST as routeInterrupt } from '../app/api/runs/[id]/interrupt/route';

import {
  interruptRun,
  listRuns,
  parseStartRunBody,
  readRun,
  revokeRunTokens,
  startRun,
  streamRunEvents,
} from '../server/runs/api';
import {
  installRunApi,
  resetRunApi,
  type Principal,
  type RunApiEnvironment,
} from '../server/runs/environment';
import { InMemoryRunStore } from '../server/runs/store';
import { SSE_HEADERS } from '../server/runs/sse';
import type { TokenScope } from '../server/rbac/token-scope';
import { decide } from '../server/rbac/decide';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';

const FAMILY = 'behaviour-runs';
const scenarios = loadVectors(FAMILY, 'routes.json');
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OTHER_WORKSPACE = '55555555-5555-4555-8555-555555555555';
const AGENT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const RUN = '88888888-8888-4888-8888-888888888888';
const OTHER_RUN = '99999999-9999-4999-8999-999999999999';
const OWNER = '77777777-7777-4777-8777-777777777777';

function roleOf(name: string): Principal['role'] {
  switch (name) {
    case 'owner':
      return 'owner';
    case 'admin':
      return 'admin';
    case 'builder':
      return 'builder';
    case 'viewer':
      return 'viewer';
    default:
      return undefined;
  }
}

function scopeOf(name: string): TokenScope | null {
  switch (name) {
    case 'run':
      return { kind: 'run', id: RUN };
    case 'run-other':
      return { kind: 'run', id: OTHER_RUN };
    case 'session':
      return { kind: 'session', id: SESSION };
    case 'session-other':
      return { kind: 'session', id: OTHER_RUN };
    default:
      return null;
  }
}

function queryFor(fault: string): string {
  switch (fault) {
    case 'invalid-limit':
      return '?limit=0';
    case 'invalid-cursor':
      return '?cursor=garbage';
    case 'invalid-status':
      return '?status=unknown';
    case 'invalid-agent':
      return '?agent=bad';
    case 'invalid-project':
      return '?project=bad';
    case 'invalid-provider':
      return '?provider=unknown';
    case 'invalid-model':
      return '?model=%20';
    case 'invalid-from':
      return '?from=bad';
    case 'invalid-to':
      return '?to=bad';
    case 'invalid-date-range':
      return '?from=2026-02-01T00%3A00%3A00.000Z&to=2026-01-01T00%3A00%3A00.000Z';
    case 'user-filter':
      return `?user=${OWNER}`;
    case 'invalid-user':
      return '?user=bad';
    default:
      return '';
  }
}

function requestFor(route: string, fault: string, scope: string, authenticated: boolean): Request {
  const id = fault === 'bad-path' ? 'bad' : fault === 'missing' ? OTHER_RUN : RUN;
  const headers: Record<string, string> = authenticated ? { 'x-test-user': '1' } : {};
  if (route === 'start') {
    const body =
      fault === 'bad-body'
        ? { prompt: '' }
        : scope === 'session'
          ? { prompt: 'go', sessionId: SESSION }
          : { prompt: 'go' };
    return new Request(`http://web/api/agents/${fault === 'bad-path' ? 'bad' : AGENT}/runs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  if (route === 'list') return new Request(`http://web/api/runs${queryFor(fault)}`, { headers });
  if (route === 'read') return new Request(`http://web/api/runs/${id}`, { headers });
  if (route === 'stream') {
    return new Request(
      `http://web/api/runs/${id}/events${fault === 'bad-cursor' ? '?after=-1' : ''}`,
      { headers },
    );
  }
  if (route === 'interrupt') {
    return new Request(`http://web/api/runs/${id}/interrupt`, { method: 'POST', headers });
  }
  return new Request(`http://web/api/runs/${id}${route === 'revoke' ? '/revoke-tokens' : ''}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(
      fault === 'bad-body' ? { unknown: true } : fault === 'bad-token' ? { tokenId: 'bad' } : {},
    ),
  });
}

async function call(route: string, request: Request, id: string): Promise<Response> {
  switch (route) {
    case 'start':
      return startRun(request, id);
    case 'list':
      return listRuns(request);
    case 'read':
      return readRun(request, id);
    case 'revoke-alias':
    case 'revoke':
      return revokeRunTokens(request, id);
    case 'stream':
      return streamRunEvents(request, id);
    case 'interrupt':
      return interruptRun(request, id);
    default:
      throw new Error(`unknown route ${route}`);
  }
}

afterEach(() => {
  resetRunApi();
  vi.restoreAllMocks();
});

describe('behaviour-runs: real run HTTP handlers', () => {
  it.each(scenarios)('$id', async ({ id, input, expected }) => {
    const scenario = asRecord(input, id);
    const result = asRecord(expected, id);
    const route = asString(scenario['route'], 'route');
    const fault = asString(scenario['fault'], 'fault');
    const role = asString(scenario['role'], 'role');
    const scope = asString(scenario['scope'], 'scope');
    const ownership = asString(scenario['ownership'], 'ownership');
    const store = new InMemoryRunStore();
    const listStore = vi.spyOn(store, 'listRuns');
    if (fault !== 'missing') {
      await store.create({
        engine: 'claude-agent-sdk',
        id: RUN,
        workspaceId: fault === 'foreign' ? OTHER_WORKSPACE : WORKSPACE,
        agentId: AGENT,
        sessionId: SESSION,
        ownerPrincipalId: OWNER,
      });
      if (fault === 'terminal') await store.finish(RUN, 'completed', null);
    }
    if (fault === 'with-foreign') {
      await store.create({
        engine: 'claude-agent-sdk',
        id: OTHER_RUN,
        workspaceId: OTHER_WORKSPACE,
        agentId: AGENT,
        sessionId: SESSION,
        ownerPrincipalId: OTHER_RUN,
      });
    }
    const foreignBefore = fault === 'with-foreign' ? await store.get(OTHER_RUN) : null;
    if (route === 'list' && (role === 'builder' || role === 'viewer')) {
      await store.create({
        engine: 'claude-agent-sdk',
        id: OTHER_RUN,
        workspaceId: WORKSPACE,
        agentId: AGENT,
        sessionId: SESSION,
        ownerPrincipalId: OTHER_RUN,
      });
    }
    const principalRole = roleOf(role);
    const principal: Principal = {
      principalId: OWNER,
      ownerPrincipalId: OWNER,
      userId: OWNER,
      workspaceId: WORKSPACE,
      ...(principalRole === undefined ? {} : { role: principalRole }),
      scope: scopeOf(scope),
    };
    const environment: RunApiEnvironment = {
      authenticate: (request) =>
        Promise.resolve(request.headers.has('x-test-user') ? principal : null),
      findAgent: (_principal, agentId) =>
        Promise.resolve(
          fault === 'missing-agent' || agentId !== AGENT
            ? null
            : { id: AGENT, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' },
        ),
      openSession: (_principal, agent) =>
        Promise.resolve(
          fault === 'unusable-session' ? null : { id: SESSION, agentId: agent.id, engine: null },
        ),
      ownsRun: () => Promise.resolve(ownership === 'own'),
      store,
      launch: () => undefined,
      revokeRunTokens: () =>
        Promise.resolve({
          revoked: fault === 'already-revoked' || fault === 'token-not-found' ? 0 : 1,
          outcome:
            fault === 'already-revoked'
              ? 'already-revoked'
              : fault === 'token-not-found'
                ? 'not-found'
                : 'revoked',
        }),
      interruptRun: async (_principal, run) => {
        await store.finish(run.id, 'cancelled', 'interrupted by request');
      },
    };
    if (fault !== 'unconfigured') installRunApi(environment);
    if (fault === 'stream-missing') vi.spyOn(store, 'openStream').mockResolvedValue(null);
    const request = requestFor(route, fault, scope, fault !== 'unauthenticated');
    const pathId =
      fault === 'bad-path'
        ? 'bad'
        : fault === 'missing'
          ? OTHER_RUN
          : route === 'start'
            ? AGENT
            : RUN;
    const response = await call(route, request, pathId);
    expect(response.status, id).toBe(result['status']);
    const workspaceRuns = await store.listRuns(WORKSPACE, { limit: 200 });
    const foreignRuns = await store.listRuns(OTHER_WORKSPACE, { limit: 200 });
    const extraOwnerFixture = route === 'list' && (role === 'builder' || role === 'viewer') ? 1 : 0;
    expect(workspaceRuns.items.length + foreignRuns.items.length - extraOwnerFixture, id).toBe(
      result['runCount'],
    );
    if (foreignBefore !== null) expect(await store.get(OTHER_RUN)).toEqual(foreignBefore);
    if (result['code'] !== null) {
      const body = asRecord(await response.json(), id);
      expect(asRecord(body['error'], 'error')['code'], id).toBe(result['code']);
      return;
    }
    const kind = asString(result['bodyKind'], 'bodyKind');
    if (kind === 'stream') {
      expect(Object.fromEntries(response.headers.entries())).toEqual(
        Object.fromEntries(
          Object.entries(SSE_HEADERS).map(([key, value]) => [key.toLowerCase(), value]),
        ),
      );
      await response.body?.cancel();
      return;
    }
    const body = asRecord(await response.json(), id);
    expect(JSON.stringify(body)).not.toMatch(/"(?:tokenSecret|tokenHash|secret)"/u);
    if (kind === 'start') {
      const run = asRecord(body['run'], 'run');
      expect(run['status']).toBe('queued');
      expect(response.headers.get('location')).toBe(body['events']);
      const stored = await store.get(asString(run['id'], 'run.id'));
      expect(stored?.workspaceId).toBe(WORKSPACE);
      expect(stored?.ownerPrincipalId).toBe(
        result['createdOwnerId'] === 'owner' ? OWNER : result['createdOwnerId'],
      );
      expect(stored?.sessionId).toBe(
        result['createdSessionId'] === 'se1' ? SESSION : result['createdSessionId'],
      );
    } else if (kind === 'list') {
      expect(Array.isArray(body['runs'])).toBe(true);
      const input = listStore.mock.calls[0]?.[1];
      if (input === undefined) throw new Error('listRuns was not called');
      expect(input.filter?.ownerPrincipalId ?? null).toBe(
        result['ownerFilter'] === null ? null : OWNER,
      );
      if (role === 'builder' || role === 'viewer') {
        const rows = body['runs'];
        if (!Array.isArray(rows)) throw new Error('runs is not an array');
        expect(rows).toHaveLength(1);
        expect(asRecord(rows[0], 'listed run')['id']).toBe(RUN);
      }
    } else if (kind === 'revoke') {
      expect(body['revoked']).toBe(result['revoked']);
      expect(body['outcome']).toBe(result['revokeOutcome']);
    } else {
      const run = asRecord(body['run'], 'run');
      expect(run['id']).toBe(RUN);
      if (route === 'interrupt') {
        expect(run['status']).toBe('cancelled');
        expect((await store.get(RUN))?.status).toBe('cancelled');
      }
    }
  });

  it('rejects an empty model through the real start handler as the contract requires', async () => {
    const body = {
      prompt: 'go',
      modelConnectionId: AGENT,
      model: '',
    };
    expect(parseStartRunBody(body).kind).toBe('rejected');
    expect(StartRunRequestSchema.safeParse(body).success).toBe(false);
    const store = new InMemoryRunStore();
    installRunApi({
      authenticate: () =>
        Promise.resolve({
          principalId: OWNER,
          ownerPrincipalId: OWNER,
          userId: OWNER,
          workspaceId: WORKSPACE,
          role: 'owner',
          scope: null,
        }),
      findAgent: () =>
        Promise.resolve({ id: AGENT, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' }),
      openSession: () => Promise.resolve({ id: SESSION, agentId: AGENT, engine: null }),
      ownsRun: () => Promise.resolve(true),
      store,
      launch: () => undefined,
    });
    const response = await startRun(
      new Request(`http://web/api/agents/${AGENT}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      AGENT,
    );
    expect(response.status).toBe(400);
    expect((await store.listRuns(WORKSPACE, { limit: 200 })).items).toHaveLength(0);
  });

  it('keeps the Admin revocation handler and decision aligned', async () => {
    const store = new InMemoryRunStore();
    await store.create({
      engine: 'claude-agent-sdk',
      id: RUN,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
    });
    installRunApi({
      authenticate: () =>
        Promise.resolve({
          principalId: OWNER,
          ownerPrincipalId: OWNER,
          userId: OWNER,
          workspaceId: WORKSPACE,
          role: 'admin',
          scope: null,
        }),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(true),
      store,
      launch: () => undefined,
      revokeRunTokens: () => Promise.resolve({ revoked: 1, outcome: 'revoked' }),
    });
    const request = requestFor('revoke', 'none', 'none', true);
    expect((await revokeRunTokens(request, RUN)).status).toBe(200);
    expect(
      decide({
        role: 'admin',
        method: 'POST',
        path: '/api/runs/:id/revoke-tokens',
        ownership: 'own',
        scope: null,
      }).effect,
    ).toBe('allow');
  });

  it('round-trips a list cursor without duplicating a run', async () => {
    const store = new InMemoryRunStore();
    for (const id of [RUN, OTHER_RUN]) {
      await store.create({
        engine: 'claude-agent-sdk',
        id,
        workspaceId: WORKSPACE,
        agentId: AGENT,
        sessionId: SESSION,
        ownerPrincipalId: OWNER,
      });
    }
    installRunApi({
      authenticate: () =>
        Promise.resolve({
          principalId: OWNER,
          ownerPrincipalId: OWNER,
          userId: OWNER,
          workspaceId: WORKSPACE,
          role: 'owner',
          scope: null,
        }),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(true),
      store,
      launch: () => undefined,
    });
    const first = asRecord(
      await (await listRuns(new Request('http://web/api/runs?limit=1'))).json(),
      'first',
    );
    const cursor = asString(first['nextCursor'], 'nextCursor');
    const second = asRecord(
      await (
        await listRuns(
          new Request(`http://web/api/runs?limit=1&cursor=${encodeURIComponent(cursor)}`),
        )
      ).json(),
      'second',
    );
    const firstRows = first['runs'];
    const secondRows = second['runs'];
    if (!Array.isArray(firstRows) || !Array.isArray(secondRows))
      throw new Error('runs is not an array');
    expect(firstRows).toHaveLength(1);
    expect(secondRows).toHaveLength(1);
    expect(asRecord(firstRows[0], 'first run')['id']).not.toBe(
      asRecord(secondRows[0], 'second run')['id'],
    );
    expect(second['nextCursor']).toBeNull();
  });

  it('maps thrown handler failures to safe internal_error on every App Router export', async () => {
    const store = new InMemoryRunStore();
    installRunApi({
      authenticate: () => Promise.reject(new Error('secret infrastructure detail')),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(true),
      store,
      launch: () => undefined,
      revokeRunTokens: () => Promise.resolve({ revoked: 0, outcome: 'not-found' }),
      interruptRun: () => Promise.resolve(),
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runContext = { params: Promise.resolve({ id: RUN }) };
    const agentContext = { params: Promise.resolve({ id: AGENT }) };
    const cases: Array<() => Promise<Response>> = [
      () =>
        routeStart(
          new NextRequest(`http://web/api/agents/${AGENT}/runs`, { method: 'POST' }),
          agentContext,
        ),
      () => routeList(new NextRequest('http://web/api/runs')),
      () => routeRead(new NextRequest(`http://web/api/runs/${RUN}`), runContext),
      () =>
        routeRevokeAlias(
          new NextRequest(`http://web/api/runs/${RUN}`, { method: 'POST' }),
          runContext,
        ),
      () =>
        routeRevoke(
          new NextRequest(`http://web/api/runs/${RUN}/revoke-tokens`, { method: 'POST' }),
          runContext,
        ),
      () => routeStream(new NextRequest(`http://web/api/runs/${RUN}/events`), runContext),
      () =>
        routeInterrupt(
          new NextRequest(`http://web/api/runs/${RUN}/interrupt`, { method: 'POST' }),
          runContext,
        ),
    ];
    for (const runCase of cases) {
      const response = await runCase();
      expect(response.status).toBe(500);
      const body = asRecord(await response.json(), 'error response');
      const error = asRecord(body['error'], 'error');
      expect(error['code']).toBe('internal_error');
      expect(JSON.stringify(body)).not.toContain('secret infrastructure detail');
    }
    expect(log).toHaveBeenCalledTimes(cases.length);
  });
});
