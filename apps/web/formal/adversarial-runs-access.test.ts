import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { proxy } from '../proxy';
import { POST as mintTokenRoute } from '../app/api/tokens/route';
import { MIN_SESSION_SECRET_LENGTH } from '../server/auth/session';
import { readBearerBrowserTokenAttempt } from '../server/rbac/browser-token';
import { Principal } from '../server/rbac/principal';
import { installRbacHarness } from '../server/rbac/testing';
import {
  interruptRun,
  listRuns,
  readRun,
  revokeRunTokens,
  startRun,
  streamRunEvents,
} from '../server/runs/api';
import type { RunPrincipal } from '../server/runs/environment';
import { InMemoryRunStore } from '../server/runs/memory-store';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';
import { clearApplicationContext } from '../server/application-context';
import {
  installTestDomains,
  installTestRunApi,
  resetTestRunApi,
} from '../server/application-context-fixtures';

const vectors = loadVectors('adversarial-runs-access', 'access.json');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const AGENT_A = '33333333-3333-4333-8333-333333333333';
const AGENT_B = '44444444-4444-4444-8444-444444444444';
const SESSION_A = '55555555-5555-4555-8555-555555555555';
const SESSION_B = '66666666-6666-4666-8666-666666666666';
const RUN_A = '77777777-7777-4777-8777-777777777777';
const RUN_B = '88888888-8888-4888-8888-888888888888';
const CASE_RUN_B = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const OWNER_A = '99999999-9999-4999-8999-999999999999';
const OTHER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const principal = (
  role: RunPrincipal['role'] = 'owner',
  scope: RunPrincipal['scope'] = null,
): RunPrincipal => ({
  principalId: OWNER_A,
  ownerPrincipalId: OWNER_A,
  userId: OWNER_A,
  workspaceId: A,
  role,
  scope,
});

const req = (path: string, method = 'GET', body?: object): Request =>
  new Request(`http://web${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

async function problemCode(response: Response): Promise<unknown> {
  return asRecord(asRecord(await response.json(), 'problem')['error'], 'error')['code'];
}

afterEach(() => {
  resetTestRunApi();
  vi.restoreAllMocks();
});

describe('adversarial-runs-access: real run handlers', () => {
  it.each(vectors)('generated $id', async ({ id, input, expected }) => {
    const scenario = asRecord(input, id);
    const outcome = asRecord(expected, id);
    const route = asString(scenario['route'], 'route');
    const target = asString(scenario['target'], 'target');
    const condition = asString(scenario['condition'], 'condition');
    const scopeName = asString(scenario['scope'], 'scope');
    const roleName = asString(scenario['role'], 'role');
    const role: RunPrincipal['role'] =
      roleName === 'builder' ? 'builder' : roleName === 'viewer' ? 'viewer' : 'owner';
    const scope: RunPrincipal['scope'] =
      scopeName === 'run'
        ? { kind: 'run', id: RUN_A }
        : scopeName === 'session'
          ? { kind: 'session', id: SESSION_A }
          : null;
    const actor = principal(role, scope);
    const store = new InMemoryRunStore();
    await store.create({
      engine: 'claude-agent-sdk',
      id: RUN_A,
      workspaceId: A,
      agentId: AGENT_A,
      sessionId: SESSION_A,
      ownerPrincipalId: OWNER_A,
    });
    await store.create({
      engine: 'claude-agent-sdk',
      id: RUN_B,
      workspaceId: condition === 'foreign' ? B : A,
      agentId: AGENT_A,
      sessionId: SESSION_B,
      ownerPrincipalId: condition === 'other-owner' ? OTHER_A : OWNER_A,
    });
    const list = vi.spyOn(store, 'listRuns');
    installTestRunApi({
      authenticate: () => Promise.resolve(actor),
      findAgent: (_principal, agentId) =>
        Promise.resolve(
          condition === 'foreign-agent' || agentId !== AGENT_A
            ? null
            : { id: AGENT_A, workspaceId: A, engine: 'claude-agent-sdk' },
        ),
      openSession: (_principal, agent, requested) =>
        Promise.resolve(
          condition === 'foreign-session' || requested === SESSION_B
            ? null
            : { id: SESSION_A, agentId: agent.id, engine: null },
        ),
      ownsRun: (_principal, row) => Promise.resolve(row.ownerPrincipalId === OWNER_A),
      store,
      launch: () => undefined,
      revokeRunTokens: () => Promise.resolve({ revoked: 1, outcome: 'revoked' }),
      interruptRun: () => Promise.resolve(),
    });
    const runId = target === 'run-b' ? RUN_B : RUN_A;
    let response: Response;
    switch (route) {
      case 'read':
        response = await readRun(req(`/api/runs/${runId}`), runId);
        break;
      case 'stream':
        response = await streamRunEvents(req(`/api/runs/${runId}/events`), runId);
        break;
      case 'interrupt':
        response = await interruptRun(req(`/api/runs/${runId}/interrupt`, 'POST'), runId);
        break;
      case 'revoke':
      case 'revoke-alias':
        response = await revokeRunTokens(req(`/api/runs/${runId}`, 'POST', {}), runId);
        break;
      case 'list':
        response = await listRuns(req('/api/runs'));
        break;
      case 'start': {
        const agentId = condition === 'foreign-agent' ? AGENT_B : AGENT_A;
        const body =
          condition === 'foreign-session'
            ? { prompt: 'go', sessionId: SESSION_B }
            : scopeName === 'session'
              ? { prompt: 'go', sessionId: SESSION_A }
              : { prompt: 'go' };
        response = await startRun(req(`/api/agents/${agentId}/runs`, 'POST', body), agentId);
        break;
      }
      default:
        throw new Error(`unknown route ${route}`);
    }
    expect(response.status, id).toBe(outcome['status']);
    if (outcome['code'] !== null) {
      expect(await problemCode(response), id).toBe(outcome['code']);
    } else if (route === 'list') {
      const body = asRecord(await response.json(), 'list');
      const rows = body['runs'];
      if (!Array.isArray(rows)) throw new Error('list response has no runs array');
      for (const row of rows) {
        const item = asRecord(row, 'listed run');
        expect(item['workspaceId'], id).toBe(A);
        if (role === 'builder' || role === 'viewer') expect(item['id'], id).toBe(RUN_A);
      }
      if (condition === 'foreign') expect(rows).toHaveLength(1);
      if (condition === 'other-owner') expect(rows).toHaveLength(1);
      const filter = list.mock.calls[0]?.[1].filter?.ownerPrincipalId ?? null;
      expect(filter, id).toBe(outcome['ownerFilter'] === null ? null : OWNER_A);
    }
  });

  it('accepts bearer scheme case variants at the proxy boundary', async () => {
    const previous = process.env['SESSION_SECRET'];
    process.env['SESSION_SECRET'] = 'k'.repeat(MIN_SESSION_SECRET_LENGTH);
    try {
      const token = `awt_live_${'a'.repeat(22)}_${'b'.repeat(43)}`;
      expect(readBearerBrowserTokenAttempt(`bearer ${token}`).kind).toBe('presented');
      const path = `http://127.0.0.1:3000/api/runs/${RUN_A}`;
      const canonical = await proxy(
        new NextRequest(path, { headers: { authorization: `Bearer ${token}` } }),
      );
      const variant = await proxy(
        new NextRequest(path, { headers: { authorization: `bearer ${token}` } }),
      );
      expect(canonical.headers.get('x-middleware-next')).toBe('1');
      expect(variant.headers.get('x-middleware-next')).toBe('1');
    } finally {
      if (previous === undefined) delete process.env['SESSION_SECRET'];
      else process.env['SESSION_SECRET'] = previous;
    }
  });

  it('conceals a foreign run from every named route and leaves it unchanged', async () => {
    const store = new InMemoryRunStore();
    await store.create({
      engine: 'claude-agent-sdk',
      id: RUN_B,
      workspaceId: B,
      agentId: AGENT_B,
      sessionId: SESSION_B,
      ownerPrincipalId: OTHER_A,
    });
    const before = await store.get(RUN_B);
    const revoke = vi.fn(() => Promise.resolve({ revoked: 1, outcome: 'revoked' as const }));
    const interrupt = vi.fn(() => Promise.resolve());
    installTestRunApi({
      authenticate: () => Promise.resolve(principal()),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(true),
      store,
      launch: () => undefined,
      revokeRunTokens: revoke,
      interruptRun: interrupt,
    });
    const cases: Array<() => Promise<Response>> = [
      () => readRun(req(`/api/runs/${RUN_B}`), RUN_B),
      () => streamRunEvents(req(`/api/runs/${RUN_B}/events`), RUN_B),
      () => interruptRun(req(`/api/runs/${RUN_B}/interrupt`, 'POST'), RUN_B),
      () => revokeRunTokens(req(`/api/runs/${RUN_B}/revoke-tokens`, 'POST', {}), RUN_B),
    ];
    for (const call of cases) {
      const response = await call();
      expect(response.status).toBe(404);
      expect(await problemCode(response)).toBe('run_not_found');
    }
    const foreignRead = await readRun(req(`/api/runs/${RUN_B}`), RUN_B);
    const get = vi.spyOn(store, 'get').mockResolvedValueOnce(null);
    const absent = await readRun(req(`/api/runs/${RUN_B}`), RUN_B);
    get.mockRestore();
    expect(foreignRead.status).toBe(absent.status);
    expect(asRecord(await foreignRead.json(), 'foreign')['error']).toEqual(
      asRecord(await absent.clone().json(), 'absent')['error'],
    );
    expect(absent.status).toBe(404);
    expect(await problemCode(absent)).toBe('run_not_found');
    const listed = await listRuns(req('/api/runs'));
    expect(listed.status).toBe(200);
    expect(asRecord(await listed.json(), 'list')['runs']).toEqual([]);
    expect(await store.get(RUN_B)).toEqual(before);
    expect(revoke).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('cannot start through a foreign agent or continue a foreign session', async () => {
    const store = new InMemoryRunStore();
    const launch = vi.fn();
    installTestRunApi({
      authenticate: () => Promise.resolve(principal()),
      findAgent: (_actor, id) =>
        Promise.resolve(
          id === AGENT_A ? { id: AGENT_A, workspaceId: A, engine: 'claude-agent-sdk' } : null,
        ),
      openSession: (_actor, agent, requested) =>
        Promise.resolve(
          agent.id === AGENT_A && requested !== SESSION_B
            ? { id: SESSION_A, agentId: AGENT_A, engine: null }
            : null,
        ),
      ownsRun: () => Promise.resolve(true),
      store,
      launch,
    });
    const foreignAgent = await startRun(
      req(`/api/agents/${AGENT_B}/runs`, 'POST', { prompt: 'go' }),
      AGENT_B,
    );
    expect(foreignAgent.status).toBe(404);
    expect(await problemCode(foreignAgent)).toBe('agent_not_found');
    const foreignSession = await startRun(
      req(`/api/agents/${AGENT_A}/runs`, 'POST', { prompt: 'go', sessionId: SESSION_B }),
      AGENT_A,
    );
    expect(foreignSession.status).toBe(409);
    expect(await problemCode(foreignSession)).toBe('session_not_usable');
    expect((await store.listRuns(A, { limit: 200 })).items).toHaveLength(0);
    expect(launch).not.toHaveBeenCalled();
  });

  it('keeps the tenant guard when an adapter resolves UUID case variants', async () => {
    const store = new InMemoryRunStore();
    await store.create({
      engine: 'claude-agent-sdk',
      id: CASE_RUN_B,
      workspaceId: B,
      agentId: AGENT_B,
      sessionId: SESSION_B,
      ownerPrincipalId: OTHER_A,
    });
    const get = store.get.bind(store);
    vi.spyOn(store, 'get').mockImplementation((id) => get(id.toLowerCase()));
    installTestRunApi({
      authenticate: () => Promise.resolve(principal()),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(true),
      store,
      launch: () => undefined,
      revokeRunTokens: () => Promise.resolve({ revoked: 1, outcome: 'revoked' }),
      interruptRun: () => Promise.resolve(),
    });
    const variant = CASE_RUN_B.toUpperCase();
    expect((await readRun(req(`/api/runs/${variant}`), variant)).status).toBe(404);
    expect((await streamRunEvents(req(`/api/runs/${variant}/events`), variant)).status).toBe(404);
    expect(
      (await interruptRun(req(`/api/runs/${variant}/interrupt`, 'POST'), variant)).status,
    ).toBe(404);
    expect(
      (await revokeRunTokens(req(`/api/runs/${variant}/revoke-tokens`, 'POST', {}), variant))
        .status,
    ).toBe(404);
    expect((await store.get(CASE_RUN_B))?.status).toBe('queued');
  });

  it.each(['builder', 'viewer'] as const)(
    "%s cannot read or list another member's run",
    async (role) => {
      const store = new InMemoryRunStore();
      await store.create({
        engine: 'claude-agent-sdk',
        id: RUN_A,
        workspaceId: A,
        agentId: AGENT_A,
        sessionId: SESSION_A,
        ownerPrincipalId: OTHER_A,
      });
      installTestRunApi({
        authenticate: () => Promise.resolve(principal(role)),
        findAgent: () => Promise.resolve(null),
        openSession: () => Promise.resolve(null),
        ownsRun: (_actor, run) => Promise.resolve(run.ownerPrincipalId === OWNER_A),
        store,
        launch: () => undefined,
        revokeRunTokens: () => Promise.resolve({ revoked: 1, outcome: 'revoked' }),
        interruptRun: () => Promise.resolve(),
      });
      for (const response of [
        await readRun(req(`/api/runs/${RUN_A}`), RUN_A),
        await streamRunEvents(req(`/api/runs/${RUN_A}/events`), RUN_A),
        await interruptRun(req(`/api/runs/${RUN_A}/interrupt`, 'POST'), RUN_A),
      ]) {
        expect(response.status).toBe(403);
      }
      expect(
        (await revokeRunTokens(req(`/api/runs/${RUN_A}/revoke-tokens`, 'POST', {}), RUN_A)).status,
      ).toBe(403);
      const listed = await listRuns(req('/api/runs'));
      expect(listed.status).toBe(200);
      expect(asRecord(await listed.json(), 'list')['runs']).toEqual([]);
      expect((await store.get(RUN_A))?.status).toBe('queued');
    },
  );

  it('confines run and session browser scopes despite the minter owner role', async () => {
    const store = new InMemoryRunStore();
    await store.create({
      engine: 'claude-agent-sdk',
      id: RUN_A,
      workspaceId: A,
      agentId: AGENT_A,
      sessionId: SESSION_A,
      ownerPrincipalId: OWNER_A,
    });
    await store.create({
      engine: 'claude-agent-sdk',
      id: RUN_B,
      workspaceId: A,
      agentId: AGENT_A,
      sessionId: SESSION_B,
      ownerPrincipalId: OWNER_A,
    });
    let actor = principal('owner', { kind: 'run', id: RUN_A });
    const revoke = vi.fn(() => Promise.resolve({ revoked: 1, outcome: 'revoked' as const }));
    const interrupt = vi.fn(() => Promise.resolve());
    installTestRunApi({
      authenticate: () => Promise.resolve(actor),
      findAgent: () => Promise.resolve({ id: AGENT_A, workspaceId: A, engine: 'claude-agent-sdk' }),
      openSession: () => Promise.resolve({ id: SESSION_A, agentId: AGENT_A, engine: null }),
      ownsRun: () => Promise.resolve(true),
      store,
      launch: () => undefined,
      revokeRunTokens: revoke,
      interruptRun: interrupt,
    });
    expect((await readRun(req(`/api/runs/${RUN_A}`), RUN_A)).status).toBe(200);
    for (const response of [
      await readRun(req(`/api/runs/${RUN_B}`), RUN_B),
      await streamRunEvents(req(`/api/runs/${RUN_B}/events`), RUN_B),
      await interruptRun(req(`/api/runs/${RUN_A}/interrupt`, 'POST'), RUN_A),
      await revokeRunTokens(req(`/api/runs/${RUN_A}/revoke-tokens`, 'POST', {}), RUN_A),
      await listRuns(req('/api/runs')),
      await startRun(req(`/api/agents/${AGENT_A}/runs`, 'POST', { prompt: 'go' }), AGENT_A),
    ]) {
      expect(response.status).toBe(403);
      expect(await problemCode(response)).toBe('token_out_of_scope');
    }
    actor = principal('owner', { kind: 'session', id: SESSION_A });
    expect((await readRun(req(`/api/runs/${RUN_A}`), RUN_A)).status).toBe(200);
    expect((await readRun(req(`/api/runs/${RUN_B}`), RUN_B)).status).toBe(403);
    expect((await streamRunEvents(req(`/api/runs/${RUN_B}/events`), RUN_B)).status).toBe(403);
    expect(
      (
        await startRun(
          req(`/api/agents/${AGENT_A}/runs`, 'POST', { prompt: 'go', sessionId: SESSION_B }),
          AGENT_A,
        )
      ).status,
    ).toBe(403);
    expect((await listRuns(req('/api/runs'))).status).toBe(403);
    expect(revoke).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('refuses browser-token minting through the real token route', async () => {
    const harness = installRbacHarness([]);
    const minter = Principal.fromDirectoryRecord({
      principalId: OWNER_A,
      kind: 'membership',
      workspaceId: A,
      role: 'owner',
      label: 'Owner A',
      userId: OWNER_A,
      apiKeyId: null,
      actsForPrincipalId: null,
    });
    const browser = Principal.fromBrowserToken(minter, { kind: 'run', id: RUN_A });
    installTestDomains({
      rbac: {
        directory: harness.directory,
        identify: () => Promise.resolve(browser),
      },
    });
    const issue = vi.fn(() =>
      Promise.resolve({
        token: `awt_live_${'a'.repeat(22)}_${'b'.repeat(43)}`,
        expiresAt: new Date(),
      }),
    );
    installTestDomains({
      tokens: {
        kind: 'serving',
        runtime: {
          findTarget: () => Promise.resolve({ kind: 'found', ownerPrincipalId: OWNER_A }),
          issue,
        },
      },
    });
    try {
      const response = await mintTokenRoute(
        req('/api/tokens', 'POST', { scope: { kind: 'run', id: RUN_A } }),
      );
      expect(response.status).toBe(403);
      expect(issue).not.toHaveBeenCalled();
    } finally {
      harness.teardown();
      clearApplicationContext();
    }
  });
});
