/** Fixtures of the `startRunOnSession` suites (`service*.test.ts`). */
import type { AgentRef, RunApiEnvironment, RunPrincipal, SessionRef } from './environment';
import { InMemoryRunStore } from './memory-store';

export const WORKSPACE = '22222222-2222-4222-8222-222222222222';
export const AGENT: AgentRef = {
  id: '33333333-3333-4333-8333-333333333333',
  workspaceId: WORKSPACE,
  engine: 'claude-agent-sdk',
};
export const PRINCIPAL: RunPrincipal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: '66666666-6666-4666-8666-666666666666',
  workspaceId: WORKSPACE,
  role: 'owner',
  scope: null,
};
export const EXISTING_SESSION = '44444444-4444-4444-8444-444444444444';

/** The start every test begins from: a new session, no override. */
export const START = { prompt: 'hello', sessionId: null, modelOverride: null } as const;

/** An environment whose `openSession` records new sessions in `sessions`, as the real one inserts rows. */
export function harness(discard?: RunApiEnvironment['discardSession']) {
  const sessions = new Map<string, SessionRef>([
    [EXISTING_SESSION, { id: EXISTING_SESSION, agentId: AGENT.id, engine: null }],
  ]);
  const store = new InMemoryRunStore();
  const discardSession: NonNullable<RunApiEnvironment['discardSession']> =
    discard ??
    ((_principal, sessionId) => {
      sessions.delete(sessionId);
      return Promise.resolve();
    });
  const env: RunApiEnvironment = {
    authenticate: () => Promise.resolve(PRINCIPAL),
    findAgent: () => Promise.resolve(AGENT),
    openSession: (_principal, agent, requested) => {
      if (requested !== null) return Promise.resolve(sessions.get(requested) ?? null);
      const fresh: SessionRef = { id: crypto.randomUUID(), agentId: agent.id, engine: null };
      sessions.set(fresh.id, fresh);
      return Promise.resolve(fresh);
    },
    discardSession,
    ownsRun: () => Promise.resolve(true),
    store,
    launch: () => undefined,
  };
  return { env, sessions, store };
}

/** `env` with a daily cost cap whose `refusal` is the given function. */
export function withDailyCostCap(
  env: RunApiEnvironment,
  refusal: NonNullable<RunApiEnvironment['dailyCostCap']>['refusal'],
): RunApiEnvironment {
  return { ...env, dailyCostCap: { refusal } };
}

/** The ids of the sessions that exist, in insertion order. */
export function sessionIds(sessions: ReadonlyMap<string, SessionRef>): string[] {
  return [...sessions.keys()];
}
