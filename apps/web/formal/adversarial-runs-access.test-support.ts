import { afterEach, expect, vi } from 'vitest';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';
import { installTestRunApi, resetTestRunApi } from '../server/application-context-fixtures';
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

export const vectors = loadVectors('adversarial-runs-access', 'access.json');

export const A = '11111111-1111-4111-8111-111111111111';

export const B = '22222222-2222-4222-8222-222222222222';

export const AGENT_A = '33333333-3333-4333-8333-333333333333';

export const AGENT_B = '44444444-4444-4444-8444-444444444444';

export const SESSION_A = '55555555-5555-4555-8555-555555555555';

export const SESSION_B = '66666666-6666-4666-8666-666666666666';

export const RUN_A = '77777777-7777-4777-8777-777777777777';

export const RUN_B = '88888888-8888-4888-8888-888888888888';

export const CASE_RUN_B = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

export const OWNER_A = '99999999-9999-4999-8999-999999999999';

export const OTHER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const principal = (
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

export const req = (path: string, method = 'GET', body?: object): Request =>
  new Request(`http://web${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

export async function problemCode(response: Response): Promise<unknown> {
  return asRecord(asRecord(await response.json(), 'problem')['error'], 'error')['code'];
}

afterEach(() => {
  resetTestRunApi();
  vi.restoreAllMocks();
});

export async function prepareScenario(scenario: Record<string, unknown>) {
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
  return { route, target, condition, scopeName, role, store, list };
}

export async function callScenario({
  route,
  target,
  condition,
  scopeName,
}: Awaited<ReturnType<typeof prepareScenario>>) {
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
  return response;
}

export async function assertScenarioResponse({
  fixture,
  response,
  outcome,
  id,
}: {
  readonly fixture: Awaited<ReturnType<typeof prepareScenario>>;
  readonly response: Response;
  readonly outcome: Record<string, unknown>;
  readonly id: string;
}): Promise<void> {
  const { route } = fixture;
  expect(response.status, id).toBe(outcome['status']);
  if (outcome['code'] !== null) {
    expect(await problemCode(response), id).toBe(outcome['code']);
    return;
  }
  if (route === 'list') await assertListedRunAccess(fixture, response, outcome, id);
}

async function assertListedRunAccess(
  { condition, role, list }: Awaited<ReturnType<typeof prepareScenario>>,
  response: Response,
  outcome: Record<string, unknown>,
  id: string,
) {
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
