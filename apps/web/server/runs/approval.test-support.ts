import { decideRunApproval } from './approval';
import {
  type AgentRef,
  type LaunchContext,
  type RunApiEnvironment,
  type RunPrincipal,
  type SessionRef,
} from './environment';
import { InMemoryRunStore } from './memory-store';
import { type ApprovalCall, type RunRecord } from './store';
import { installTestRunApi } from '../application-context-fixtures';

export const WORKSPACE = '22222222-2222-4222-8222-222222222222';
export const OTHER_WORKSPACE = '55555555-5555-4555-8555-555555555555';
export const AGENT = '33333333-3333-4333-8333-333333333333';
export const SESSION = '44444444-4444-4444-8444-444444444444';
export const CALL: ApprovalCall = { toolName: 'send_email', canonicalCall: '{"to":"a@b.c"}' };
export const PRINCIPAL: RunPrincipal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: '66666666-6666-4666-8666-666666666666',
  workspaceId: WORKSPACE,
  role: 'owner',
  scope: null,
};

export interface Harness {
  readonly store: InMemoryRunStore;
  readonly launched: LaunchContext[];
}

/** Installs a run API whose caller is `PRINCIPAL` whenever the request carries `x-test-user`. */
export function install(
  overrides: Partial<RunApiEnvironment> = {},
  store = new InMemoryRunStore(),
): Harness {
  const launched: LaunchContext[] = [];
  installTestRunApi({
    authenticate: (request: Request) =>
      Promise.resolve(request.headers.get('x-test-user') === null ? null : PRINCIPAL),
    findAgent: (principal: RunPrincipal, agentId: string): Promise<AgentRef | null> =>
      Promise.resolve(
        agentId === AGENT
          ? { id: AGENT, workspaceId: principal.workspaceId, engine: 'claude-agent-sdk' }
          : null,
      ),
    openSession: (_p: RunPrincipal, agent: AgentRef): Promise<SessionRef | null> =>
      Promise.resolve({ id: SESSION, agentId: agent.id, engine: null }),
    ownsRun: () => Promise.resolve(true),
    store,
    launch: (context: LaunchContext): void => {
      launched.push(context);
    },
    interruptRun: () => Promise.resolve(),
    ...overrides,
  });
  return { store, launched };
}

/** The fields every run these tests create shares: one agent, one session, one initiator. */
export function newRun(workspaceId = WORKSPACE, id = crypto.randomUUID()) {
  return {
    engine: 'claude-agent-sdk' as const,
    id,
    workspaceId,
    agentId: AGENT,
    sessionId: SESSION,
    initiatingUserId: PRINCIPAL.userId,
    ownerPrincipalId: PRINCIPAL.principalId,
  };
}

/** Optional extras of a paused run; each one is carried onto its continuation. */
export interface PausedRunOptions {
  readonly workspaceId?: string;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly subject?: string;
  readonly limitsOverride?: NonNullable<RunRecord['limitsOverride']>;
}

/** A run in `SESSION` that the engine stopped before `CALL`. */
export async function pausedRun(
  store: InMemoryRunStore,
  options: PausedRunOptions = {},
): Promise<RunRecord> {
  const { workspaceId, outputSchema, subject, limitsOverride } = options;
  const id = crypto.randomUUID();
  await store.create({
    ...newRun(workspaceId, id),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(subject === undefined ? {} : { subject }),
    ...(limitsOverride === undefined ? {} : { limitsOverride }),
  });
  await store.markRunning(id);
  await store.awaitApproval(id, CALL);
  const run = await store.get(id);
  if (run === null) throw new Error('the paused run vanished');
  return run;
}

/** Makes `store.get(runId)` answer with `patch` merged over the stored run. */
export function patchRunOnRead(
  store: InMemoryRunStore,
  runId: string,
  patch: Partial<RunRecord>,
): void {
  const get = store.get.bind(store);
  store.get = async (id) => {
    const run = await get(id);
    return run?.id === runId ? { ...run, ...patch } : run;
  };
}

export function decision(runId: string, body: unknown, authenticated = true): Request {
  return new Request(`http://web/api/runs/${runId}/approval`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { 'x-test-user': '1' } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** POSTs `{ decision }` (plus any `extra` body fields) as the signed-in caller. */
export function decide(
  runId: string,
  verdict: 'approve' | 'reject',
  extra: Readonly<Record<string, unknown>> = {},
): Promise<Response> {
  return decideRunApproval(decision(runId, { decision: verdict, ...extra }), runId);
}

export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '(none)';
}
