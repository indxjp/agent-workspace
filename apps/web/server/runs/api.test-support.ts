import { installTestRunApi } from '../application-context-fixtures';
import { startRun } from './api';
import {
  type AgentRef,
  type LaunchContext,
  type RunApiEnvironment,
  type RunPrincipal,
  type SessionRef,
} from './environment';
import { InMemoryRunStore } from './memory-store';
import { type RunRecord } from './store';

export const WORKSPACE = '22222222-2222-4222-8222-222222222222';
export const OTHER_WORKSPACE = '55555555-5555-4555-8555-555555555555';
export const AGENT = '33333333-3333-4333-8333-333333333333';
export const SESSION = '44444444-4444-4444-8444-444444444444';
const PRINCIPAL_USER_ID = '66666666-6666-4666-8666-666666666666';
export const PRINCIPAL: RunPrincipal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: PRINCIPAL_USER_ID,
  workspaceId: WORKSPACE,
  role: 'owner',
  scope: null,
};

export interface Harness {
  readonly store: InMemoryRunStore;
  readonly launched: LaunchContext[];
}

export function install(
  overrides: Partial<RunApiEnvironment> = {},
  store: InMemoryRunStore = new InMemoryRunStore(),
): Harness {
  const launched: LaunchContext[] = [];
  const environment: RunApiEnvironment = {
    authenticate: (request: Request): Promise<RunPrincipal | null> =>
      Promise.resolve(request.headers.get('x-test-user') === null ? null : PRINCIPAL),
    findAgent: (principal: RunPrincipal, agentId: string): Promise<AgentRef | null> =>
      Promise.resolve(
        agentId === AGENT
          ? { id: AGENT, workspaceId: principal.workspaceId, engine: 'claude-agent-sdk' }
          : null,
      ),
    openSession: (
      _p: RunPrincipal,
      agent: AgentRef,
      requested: string | null,
    ): Promise<SessionRef | null> =>
      Promise.resolve(
        requested === null || requested === SESSION
          ? { id: SESSION, agentId: agent.id, engine: null }
          : null,
      ),
    ownsRun: () => Promise.resolve(true),
    store,
    launch: (context: LaunchContext): void => {
      launched.push(context);
    },
    ...overrides,
  };
  installTestRunApi(environment);
  return { store, launched };
}

export function post(agentId: string, body: unknown, authenticated = true): Request {
  return new Request(`http://web/api/agents/${agentId}/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { 'x-test-user': '1' } : {}),
    },
    body: JSON.stringify(body),
  });
}

export function get(
  url: string,
  headers: Record<string, string> = {},
  authenticated = true,
): Request {
  return new Request(url, {
    headers: { ...(authenticated ? { 'x-test-user': '1' } : {}), ...headers },
  });
}

export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '(none)';
}

export const OTHER_USER = '77777777-7777-4777-8777-777777777777';
export const OTHER_PRINCIPAL = '88888888-8888-4888-8888-888888888888';

/** A fresh, valid run id — every test below needs several of its own. */
export function newRunId(): string {
  return crypto.randomUUID();
}

/** Create a run with attribution, defaulting to `PRINCIPAL`'s own workspace/agent/user. */
export async function seedRun(
  store: InMemoryRunStore,
  overrides: Partial<{
    readonly id: string;
    readonly workspaceId: string;
    readonly agentId: string;
    readonly projectId: string | null;
    readonly initiatingUserId: string | null;
    readonly ownerPrincipalId: string;
  }> = {},
): Promise<RunRecord> {
  const id = overrides.id ?? newRunId();
  return store.create({
    engine: 'claude-agent-sdk',
    id,
    workspaceId: overrides.workspaceId ?? WORKSPACE,
    agentId: overrides.agentId ?? AGENT,
    sessionId: id,
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
    initiatingUserId:
      overrides.initiatingUserId === undefined ? PRINCIPAL_USER_ID : overrides.initiatingUserId,
    ownerPrincipalId:
      overrides.ownerPrincipalId ??
      (overrides.initiatingUserId === OTHER_USER ? OTHER_PRINCIPAL : PRINCIPAL.principalId),
  });
}

export async function listBody(response: Response): Promise<{
  runs: Array<Record<string, unknown>>;
  nextCursor: string | null;
}> {
  return (await response.json()) as {
    runs: Array<Record<string, unknown>>;
    nextCursor: string | null;
  };
}

export function interruptRequest(runId: string, authenticated = true): Request {
  return new Request(`http://web/api/runs/${runId}/interrupt`, {
    method: 'POST',
    headers: authenticated ? { 'x-test-user': '1' } : {},
  });
}

export async function startedRun(): Promise<string> {
  const created = (await (await startRun(post(AGENT, { prompt: 'hi' }), AGENT)).json()) as {
    run: { id: string };
  };
  return created.run.id;
}

export async function readAll(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) throw new Error('no body');
  let text = '';
  const decoder = new TextDecoder();
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

export const TEST_ENGINE = 'test-only-engine';

export function installWithEngines(sessionEngine: string | null, agentEngine: string): Harness {
  return install({
    findAgent: (principal, id) =>
      Promise.resolve(
        id === AGENT
          ? { id: AGENT, workspaceId: principal.workspaceId, engine: agentEngine }
          : null,
      ),
    openSession: (_p, agent) =>
      Promise.resolve({ id: SESSION, agentId: agent.id, engine: sessionEngine }),
  });
}
