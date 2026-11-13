import { afterEach, vi } from 'vitest';
import { asString, loadVectors } from '../../../tests/formal/vectors';
import { installTestRunApi, resetTestRunApi } from '../server/application-context-fixtures';
import type { TokenScope } from '../server/rbac/core/token-scope';
import {
  interruptRun,
  listRuns,
  readRun,
  revokeRunTokens,
  startRun,
  streamRunEvents,
} from '../server/runs/api';
import type { RunApiEnvironment, RunPrincipal } from '../server/runs/environment';
import { InMemoryRunStore } from '../server/runs/memory-store';

const FAMILY = 'behaviour-runs';

export const scenarios = loadVectors(FAMILY, 'routes.json');

export const WORKSPACE = '22222222-2222-4222-8222-222222222222';

export const OTHER_WORKSPACE = '55555555-5555-4555-8555-555555555555';

export const AGENT = '33333333-3333-4333-8333-333333333333';

export const SESSION = '44444444-4444-4444-8444-444444444444';

export const RUN = '88888888-8888-4888-8888-888888888888';

export const OTHER_RUN = '99999999-9999-4999-8999-999999999999';

export const OWNER = '77777777-7777-4777-8777-777777777777';

function roleOf(name: string): RunPrincipal['role'] {
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

export function requestFor(
  route: string,
  fault: string,
  scope: string,
  authenticated: boolean,
): Request {
  const id = fault === 'bad-path' ? 'bad' : fault === 'missing' ? OTHER_RUN : RUN;
  const headers: Record<string, string> = authenticated ? { 'x-test-user': '1' } : {};
  if (route === 'start') {
    return new Request(`http://web/api/agents/${fault === 'bad-path' ? 'bad' : AGENT}/runs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(startBodyFor(fault, scope)),
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
    body: JSON.stringify(revocationBodyFor(fault)),
  });
}

function startBodyFor(fault: string, scope: string) {
  if (fault === 'bad-body') return { prompt: '' };
  return scope === 'session' ? { prompt: 'go', sessionId: SESSION } : { prompt: 'go' };
}

function revocationBodyFor(fault: string) {
  if (fault === 'bad-body') return { unknown: true };
  return fault === 'bad-token' ? { tokenId: 'bad' } : {};
}

export async function call(route: string, request: Request, id: string): Promise<Response> {
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
  resetTestRunApi();
  vi.restoreAllMocks();
});

export async function prepareScenario(scenario: Record<string, unknown>) {
  const route = asString(scenario['route'], 'route');
  const fault = asString(scenario['fault'], 'fault');
  const role = asString(scenario['role'], 'role');
  const scope = asString(scenario['scope'], 'scope');
  const ownership = asString(scenario['ownership'], 'ownership');
  const store = new InMemoryRunStore();
  const listStore = vi.spyOn(store, 'listRuns');
  const foreignBefore = await seedScenarioRuns({ route, fault, role }, store);
  const principalRole = roleOf(role);
  const principal: RunPrincipal = {
    principalId: OWNER,
    ownerPrincipalId: OWNER,
    userId: OWNER,
    workspaceId: WORKSPACE,
    ...(principalRole === undefined ? {} : { role: principalRole }),
    scope: scopeOf(scope),
  };
  const environment = scenarioEnvironment({ store, principal, fault, ownership });
  if (fault !== 'unconfigured') installTestRunApi(environment);
  if (fault === 'stream-missing') vi.spyOn(store, 'openStream').mockResolvedValue(null);
  return { route, fault, role, scope, store, listStore, foreignBefore };
}

async function seedScenarioRuns(
  { route, fault, role }: { route: string; fault: string; role: string },
  store: InMemoryRunStore,
) {
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
  return foreignBefore;
}

function scenarioEnvironment({
  store,
  principal,
  fault,
  ownership,
}: {
  store: InMemoryRunStore;
  principal: RunPrincipal;
  fault: string;
  ownership: string;
}): RunApiEnvironment {
  return {
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
}
