import { StartRunRequestSchema } from '@indx-workspace/contracts/runs';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { asRecord, asString } from '../../../tests/formal/vectors';
import { POST as routeStart } from '../app/api/agents/[id]/runs/route';
import { GET as routeStream } from '../app/api/runs/[id]/events/route';
import { POST as routeInterrupt } from '../app/api/runs/[id]/interrupt/route';
import { POST as routeRevoke } from '../app/api/runs/[id]/revoke-tokens/route';
import { GET as routeRead, POST as routeRevokeAlias } from '../app/api/runs/[id]/route';
import { GET as routeList } from '../app/api/runs/route';
import { installTestRunApi } from '../server/application-context-fixtures';
import { decide } from '../server/rbac/decide';
import { listRuns, parseStartRunBody, revokeRunTokens, startRun } from '../server/runs/api';
import { InMemoryRunStore } from '../server/runs/memory-store';
import { log as webLogger } from '../server/telemetry/logger';
import { assertScenarioResponse } from './behaviour-runs.assertions.test-support';
import {
  AGENT,
  call,
  OTHER_RUN,
  OWNER,
  prepareScenario,
  requestFor,
  RUN,
  scenarios,
  SESSION,
  WORKSPACE,
} from './behaviour-runs.test-support';

describe('behaviour-runs: real run HTTP handlers', () => {
  it.each(scenarios)('$id', async ({ id, input, expected }) => {
    const scenario = asRecord(input, id);
    const result = asRecord(expected, id);
    const fixture = await prepareScenario(scenario);
    const { route, fault, scope } = fixture;

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
    await assertScenarioResponse({ fixture, response, result, id });
  });

  it(
    'rejects an empty model through the real start handler as the contract requires',
    rejectsEmptyModelRealStartHandlerContract,
  );

  it(
    'keeps the Admin revocation handler and decision aligned',
    keepsAdminRevocationHandlerDecisionAligned,
  );

  it(
    'round-trips a list cursor without duplicating a run',
    roundTripsListCursorWithoutDuplicatingRun,
  );

  it(
    'maps thrown handler failures to safe internal_error on every App Router export',
    mapsThrownHandlerFailuresSafeInternalError,
  );
});

async function rejectsEmptyModelRealStartHandlerContract() {
  const body = {
    prompt: 'go',
    modelConnectionId: AGENT,
    model: '',
  };
  expect(parseStartRunBody(body).kind).toBe('rejected');
  expect(StartRunRequestSchema.safeParse(body).success).toBe(false);
  const store = new InMemoryRunStore();
  installTestRunApi({
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
}

async function keepsAdminRevocationHandlerDecisionAligned() {
  const store = new InMemoryRunStore();
  await store.create({
    engine: 'claude-agent-sdk',
    id: RUN,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    sessionId: SESSION,
  });
  installTestRunApi({
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
}

async function roundTripsListCursorWithoutDuplicatingRun() {
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
  installTestRunApi({
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
}

async function mapsThrownHandlerFailuresSafeInternalError() {
  const store = new InMemoryRunStore();
  installTestRunApi({
    authenticate: () => Promise.reject(new Error('secret infrastructure detail')),
    findAgent: () => Promise.resolve(null),
    openSession: () => Promise.resolve(null),
    ownsRun: () => Promise.resolve(true),
    store,
    launch: () => undefined,
    revokeRunTokens: () => Promise.resolve({ revoked: 0, outcome: 'not-found' }),
    interruptRun: () => Promise.resolve(),
  });
  const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
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
}
