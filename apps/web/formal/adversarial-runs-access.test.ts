const RESTRICTED_ROLES = ['builder', 'viewer'] as const;
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { asRecord } from '../../../tests/formal/vectors';
import { POST as mintTokenRoute } from '../app/api/tokens/route';
import { proxy } from '../proxy';
import { clearApplicationContext } from '../server/application-context';
import { installTestDomains, installTestRunApi } from '../server/application-context-fixtures';
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
import { InMemoryRunStore } from '../server/runs/memory-store';
import {
  A,
  AGENT_A,
  AGENT_B,
  assertScenarioResponse,
  B,
  callScenario,
  CASE_RUN_B,
  OTHER_A,
  OWNER_A,
  prepareScenario,
  principal,
  problemCode,
  req,
  RUN_A,
  RUN_B,
  SESSION_A,
  SESSION_B,
  vectors,
} from './adversarial-runs-access.test-support';

describe('adversarial-runs-access: real run handlers', () => {
  it.each(vectors)('generated $id', async ({ id, input, expected }) => {
    const scenario = asRecord(input, id);
    const outcome = asRecord(expected, id);
    const fixture = await prepareScenario(scenario);
    const response = await callScenario(fixture);

    await assertScenarioResponse({ fixture, response, outcome, id });
  });

  it(
    'accepts bearer scheme case variants at the proxy boundary',
    acceptsBearerSchemeCaseVariantsAtProxy,
  );

  it(
    'conceals a foreign run from every named route and leaves it unchanged',
    concealsForeignRunEveryNamedRouteLeaves,
  );

  it(
    'cannot start through a foreign agent or continue a foreign session',
    cannotStartForeignAgentContinueForeignSession,
  );

  it(
    'keeps the tenant guard when an adapter resolves UUID case variants',
    keepsTenantGuardWhenAdapterResolvesUUID,
  );

  it.each(RESTRICTED_ROLES)(
    "%s cannot read or list another member's run",
    cannotReadOrListAnotherMemberRun,
  );

  it(
    'confines run and session browser scopes despite the minter owner role',
    confinesRunSessionBrowserScopesDespiteMinter,
  );

  it(
    'refuses browser-token minting through the real token route',
    refusesBrowserTokenMintingRealTokenRoute,
  );
});

async function acceptsBearerSchemeCaseVariantsAtProxy() {
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
}

async function concealsForeignRunEveryNamedRouteLeaves() {
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
}

async function cannotStartForeignAgentContinueForeignSession() {
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
}

async function keepsTenantGuardWhenAdapterResolvesUUID() {
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
  expect((await interruptRun(req(`/api/runs/${variant}/interrupt`, 'POST'), variant)).status).toBe(
    404,
  );
  expect(
    (await revokeRunTokens(req(`/api/runs/${variant}/revoke-tokens`, 'POST', {}), variant)).status,
  ).toBe(404);
  expect((await store.get(CASE_RUN_B))?.status).toBe('queued');
}

async function confinesRunSessionBrowserScopesDespiteMinter() {
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
}

async function refusesBrowserTokenMintingRealTokenRoute() {
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
}

async function cannotReadOrListAnotherMemberRun(role: (typeof RESTRICTED_ROLES)[number]) {
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
}
