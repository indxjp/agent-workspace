/**
 * `GET /api/agents/:id/feedback` (issue #620): who sees which ratings, what the query may say, and
 * that each item carries its run's prompt and answer.
 */
import { RunFeedbackListResponseSchema } from '@indx-workspace/contracts/feedback';
import { afterEach, describe, expect, it } from 'vitest';

import { ORDER_STATUS_FRAMES } from '../evaluations/fixtures';
import type { AgentFeedbackQuery, AgentFeedbackRow, RunPrincipal } from './environment';
import { listAgentFeedback } from './feedback';
import { InMemoryRunStore } from './memory-store';
import { installTestRunApi, resetTestRunApi } from '../application-context-fixtures';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';
const OWNER: RunPrincipal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: '66666666-6666-4666-8666-666666666666',
  workspaceId: WORKSPACE,
  role: 'owner',
  scope: null,
};

const ROW: AgentFeedbackRow = {
  runId: RUN,
  rating: 'down',
  comment: 'Wrong order.',
  input: 'Where is order 1042?',
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  events: ORDER_STATUS_FRAMES.map((frame, index) => ({
    id: BigInt(index + 1),
    type: frame.frame,
    data: frame,
  })),
};

function install(principal: RunPrincipal | null, rows: readonly AgentFeedbackRow[] | null = [ROW]) {
  const queries: AgentFeedbackQuery[] = [];
  installTestRunApi({
    authenticate: () => Promise.resolve(principal),
    findAgent: () => Promise.resolve(null),
    openSession: () => Promise.resolve(null),
    ownsRun: () => Promise.resolve(true),
    store: new InMemoryRunStore(),
    launch: () => undefined,
    listAgentFeedback: (_principal, query) => {
      queries.push(query);
      return Promise.resolve(rows);
    },
  });
  return queries;
}

const list = (query = '', agentId = AGENT) =>
  listAgentFeedback(new Request(`http://web/api/agents/${agentId}/feedback${query}`), agentId);

async function codeOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '(none)';
}

afterEach(() => resetTestRunApi());

describe('GET /api/agents/:id/feedback (issue #620)', () => {
  it('answers each rating with its run’s prompt and final answer', async () => {
    const queries = install(OWNER);
    const response = await list();
    expect(response.status).toBe(200);
    expect(RunFeedbackListResponseSchema.parse(await response.json())).toEqual({
      items: [
        {
          runId: RUN,
          rating: 'down',
          comment: 'Wrong order.',
          input: 'Where is order 1042?',
          answer: 'Order 1042 has shipped.',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    });
    expect(queries).toEqual([{ agentId: AGENT, limit: 50 }]);
  });

  it('passes the query through', async () => {
    const queries = install(OWNER);
    const since = '2026-09-27T00:00:00.000Z';
    expect((await list(`?rating=down&since=${since}&runId=${RUN}`)).status).toBe(200);
    expect(queries).toEqual([
      { agentId: AGENT, rating: 'down', since: new Date(since), runId: RUN, limit: 50 },
    ]);
  });

  it.each(['builder', 'viewer'] as const)(
    'narrows a %s to the ratings of its own sessions’ runs, as GET /api/runs does',
    async (role) => {
      const queries = install({ ...OWNER, role });
      expect((await list()).status).toBe(200);
      expect(queries).toEqual([
        { agentId: AGENT, ownerPrincipalId: OWNER.ownerPrincipalId, limit: 50 },
      ]);
    },
  );

  it('lets an admin read every rating', async () => {
    const queries = install({ ...OWNER, role: 'admin' });
    expect((await list()).status).toBe(200);
    expect(queries[0]?.ownerPrincipalId).toBeUndefined();
  });

  it.each([
    ['?rating=meh', 'invalid_query'],
    ['?since=7d', 'invalid_query'],
    ['?limit=5', 'invalid_query'],
    ['?rating=up&rating=down', 'invalid_query'],
  ])('refuses %s with 400 %s and reads nothing', async (query, code) => {
    const queries = install(OWNER);
    const response = await list(query);
    expect([response.status, await codeOf(response)]).toEqual([400, code]);
    expect(queries).toEqual([]);
  });

  it('refuses an unauthenticated caller, a bad id and an unknown agent', async () => {
    install(null);
    expect((await list()).status).toBe(401);
    install(OWNER);
    const bad = await list('', 'agent_1');
    expect([bad.status, await codeOf(bad)]).toEqual([400, 'invalid_agent_id']);
    install(OWNER, null);
    const missing = await list();
    expect([missing.status, await codeOf(missing)]).toEqual([404, 'agent_not_found']);
  });

  it('refuses a browser token: its scope reaches no feedback list', async () => {
    const queries = install({ ...OWNER, scope: { kind: 'session', id: RUN } });
    const response = await list();
    expect([response.status, await codeOf(response)]).toEqual([403, 'token_out_of_scope']);
    expect(queries).toEqual([]);
  });

  it('answers 503 when the deployment has no feedback list', async () => {
    installTestRunApi({
      authenticate: () => Promise.resolve(OWNER),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(true),
      store: new InMemoryRunStore(),
      launch: () => undefined,
    });
    expect(await codeOf(await list())).toBe('run_api_not_configured');
  });
});
