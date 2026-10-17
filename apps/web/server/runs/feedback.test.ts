/**
 * `POST /api/runs/:id/feedback` (issue #539, S2-05c, C19): who may rate which run, what the body
 * may say, and that every accepted call is stored exactly once.
 */
import type { RunFeedbackRequest } from '@indx-workspace/contracts/feedback';
import { afterEach, describe, expect, it } from 'vitest';

import type { Role } from '../rbac/roles';
import {
  admitVisitorWrite,
  resetSurfaceLimits,
  SURFACE_RATE_LIMITS,
} from '../surfaces/public/limits';
import { installRunApi, resetRunApi, type Principal, type RunApiEnvironment } from './environment';
import { submitRunFeedback } from './feedback';
import { InMemoryRunStore, type RunRecord } from './store';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OTHER_WORKSPACE = '55555555-5555-4555-8555-555555555555';
const AGENT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const OTHER_SESSION = '88888888-8888-4888-8888-888888888888';
const OWNER: Principal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: '66666666-6666-4666-8666-666666666666',
  workspaceId: WORKSPACE,
  role: 'owner',
  scope: null,
};

interface Harness {
  readonly store: InMemoryRunStore;
  readonly recorded: { runId: string; feedback: RunFeedbackRequest }[];
}

function install(
  principal: Principal | null,
  {
    owns = true,
    record = true,
    store = new InMemoryRunStore(),
    admit,
  }: {
    owns?: boolean;
    record?: boolean;
    store?: InMemoryRunStore;
    admit?: RunApiEnvironment['admitVisitorWrite'];
  } = {},
): Harness {
  const recorded: Harness['recorded'] = [];
  const environment: RunApiEnvironment = {
    authenticate: () => Promise.resolve(principal),
    findAgent: () => Promise.resolve(null),
    openSession: () => Promise.resolve(null),
    ownsRun: () => Promise.resolve(owns),
    store,
    launch: () => undefined,
    ...(admit === undefined ? {} : { admitVisitorWrite: admit }),
  };
  installRunApi(
    record
      ? {
          ...environment,
          recordRunFeedback: (_principal, run, feedback) => {
            recorded.push({ runId: run.id, feedback });
            return Promise.resolve();
          },
        }
      : environment,
  );
  return { store, recorded };
}

function seedRun(
  store: InMemoryRunStore,
  overrides: { workspaceId?: string; sessionId?: string } = {},
): Promise<RunRecord> {
  return store.create({
    engine: 'claude-agent-sdk',
    id: crypto.randomUUID(),
    workspaceId: overrides.workspaceId ?? WORKSPACE,
    agentId: AGENT,
    sessionId: overrides.sessionId ?? SESSION,
    initiatingUserId: OWNER.userId,
    ownerPrincipalId: OWNER.principalId,
  });
}

function feedback(runId: string, body: unknown): Request {
  return new Request(`http://web/api/runs/${runId}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function codeOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '(none)';
}

const SESSION_TOKEN: Principal = { ...OWNER, scope: { kind: 'session', id: SESSION } };

afterEach(() => {
  resetRunApi();
  resetSurfaceLimits();
});

describe('POST /api/runs/:id/feedback (issue #539)', () => {
  it('a session token rates a run of its own session: 204, stored once per call', async () => {
    const harness = install(SESSION_TOKEN);
    const run = await seedRun(harness.store);
    const first = await submitRunFeedback(feedback(run.id, { rating: 'up' }), run.id);
    expect(first.status).toBe(204);
    expect(await first.text()).toBe('');
    expect(harness.recorded).toEqual([{ runId: run.id, feedback: { rating: 'up' } }]);
    await submitRunFeedback(feedback(run.id, { rating: 'down', comment: 'off' }), run.id);
    expect(harness.recorded).toHaveLength(2);
    expect(harness.recorded[1]?.feedback).toEqual({ rating: 'down', comment: 'off' });
  });

  it('a session token on another session’s run: 403 token_out_of_scope, nothing stored', async () => {
    const harness = install(SESSION_TOKEN);
    const run = await seedRun(harness.store, { sessionId: OTHER_SESSION });
    const response = await submitRunFeedback(feedback(run.id, { rating: 'up' }), run.id);
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('token_out_of_scope');
    expect(harness.recorded).toEqual([]);
  });

  it('a run-scoped token never reaches feedback: 403 token_out_of_scope from decide()', async () => {
    const store = new InMemoryRunStore();
    const run = await seedRun(store);
    const harness = install({ ...OWNER, scope: { kind: 'run', id: run.id } }, { store });
    const response = await submitRunFeedback(feedback(run.id, { rating: 'up' }), run.id);
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('token_out_of_scope');
    expect(harness.recorded).toEqual([]);
  });

  it.each<[Role, boolean, number]>([
    ['builder', false, 403],
    ['viewer', true, 204],
    ['admin', false, 204],
  ])('a %s cookie caller (owns: %s) gets %i through §21', async (role, owns, status) => {
    const harness = install({ ...OWNER, role }, { owns });
    const run = await seedRun(harness.store);
    const response = await submitRunFeedback(feedback(run.id, { rating: 'up' }), run.id);
    expect(response.status).toBe(status);
    if (status === 403) expect(await codeOf(response)).toBe('forbidden');
    expect(harness.recorded).toHaveLength(status === 204 ? 1 : 0);
  });

  it('400 invalid_run_id for a non-UUID, 404 run_not_found for an unknown or foreign run', async () => {
    const harness = install(OWNER);
    const notUuid = await submitRunFeedback(feedback('x', { rating: 'up' }), 'x');
    expect(notUuid.status).toBe(400);
    expect(await codeOf(notUuid)).toBe('invalid_run_id');
    const unknown = crypto.randomUUID();
    const missing = await submitRunFeedback(feedback(unknown, { rating: 'up' }), unknown);
    expect(missing.status).toBe(404);
    expect(await codeOf(missing)).toBe('run_not_found');
    const foreign = await seedRun(harness.store, { workspaceId: OTHER_WORKSPACE });
    const crossed = await submitRunFeedback(feedback(foreign.id, { rating: 'up' }), foreign.id);
    expect(crossed.status).toBe(404);
    expect(await codeOf(crossed)).toBe('run_not_found');
  });

  it.each<[string, unknown]>([
    ['a rating outside the set', { rating: 'meh' }],
    ['an unknown key', { rating: 'up', extra: 1 }],
    ['a 1001-character comment', { rating: 'up', comment: 'c'.repeat(1001) }],
  ])('400 invalid_body for %s, nothing stored', async (_label, body) => {
    const harness = install(OWNER);
    const run = await seedRun(harness.store);
    const response = await submitRunFeedback(feedback(run.id, body), run.id);
    expect(response.status).toBe(400);
    expect(await codeOf(response)).toBe('invalid_body');
    expect(harness.recorded).toEqual([]);
  });

  it('400 invalid_body for malformed JSON, nothing stored', async () => {
    const harness = install(OWNER);
    const run = await seedRun(harness.store);
    const response = await submitRunFeedback(
      new Request(`http://web/api/runs/${run.id}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
      run.id,
    );
    expect(response.status).toBe(400);
    expect(await codeOf(response)).toBe('invalid_body');
    expect(harness.recorded).toEqual([]);
  });

  it.each<[string, string, Principal, { owns?: boolean; sessionId?: string }]>([
    ['a builder on another’s run', 'forbidden', { ...OWNER, role: 'builder' }, { owns: false }],
    [
      'a session token on another session’s run',
      'token_out_of_scope',
      SESSION_TOKEN,
      { sessionId: OTHER_SESSION },
    ],
  ])(
    'parses the body only after authorisation: %s with an invalid body gets 403 %s',
    async (_label, code, principal, { owns, sessionId }) => {
      const harness = install(principal, owns === undefined ? {} : { owns });
      const run = await seedRun(harness.store, sessionId === undefined ? {} : { sessionId });
      const response = await submitRunFeedback(feedback(run.id, { rating: 'meh' }), run.id);
      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe(code);
      expect(harness.recorded).toEqual([]);
    },
  );

  it('accepts a 1000-character comment', async () => {
    const harness = install(OWNER);
    const run = await seedRun(harness.store);
    const comment = 'c'.repeat(1000);
    const response = await submitRunFeedback(feedback(run.id, { rating: 'up', comment }), run.id);
    expect(response.status).toBe(204);
    expect(harness.recorded).toEqual([{ runId: run.id, feedback: { rating: 'up', comment } }]);
  });

  it('401 unauthenticated without a caller', async () => {
    install(null);
    const id = crypto.randomUUID();
    const response = await submitRunFeedback(feedback(id, { rating: 'up' }), id);
    expect(response.status).toBe(401);
  });

  it('503 run_api_not_configured with no run API or no recordRunFeedback', async () => {
    const id = crypto.randomUUID();
    const none = await submitRunFeedback(feedback(id, { rating: 'up' }), id);
    expect(none.status).toBe(503);
    expect(await codeOf(none)).toBe('run_api_not_configured');
    install(OWNER, { record: false });
    const absent = await submitRunFeedback(feedback(id, { rating: 'up' }), id);
    expect(absent.status).toBe(503);
  });
});

/** Issue #606, folded into #622: a surface visitor's ratings are rate-limited. */
describe('POST /api/runs/:id/feedback by a surface visitor (issues #606, #622)', () => {
  const visitorLimit: RunApiEnvironment['admitVisitorWrite'] = (_w, sessionId, kind, headers) =>
    Promise.resolve(
      admitVisitorWrite({ name: 'main', agent: 'support' }, sessionId, kind, headers),
    );

  it('answers the rating past the per-session limit 429 surface_rate_limited, storing nothing', async () => {
    const harness = install(SESSION_TOKEN, { admit: visitorLimit });
    const run = await seedRun(harness.store);
    for (let sent = 0; sent < SURFACE_RATE_LIMITS.feedbackPerSession; sent += 1) {
      expect((await submitRunFeedback(feedback(run.id, { rating: 'up' }), run.id)).status).toBe(
        204,
      );
    }
    const refused = await submitRunFeedback(feedback(run.id, { rating: 'up' }), run.id);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await codeOf(refused)).toBe('surface_rate_limited');
    expect(harness.recorded).toHaveLength(SURFACE_RATE_LIMITS.feedbackPerSession);
  });

  it('is not limited for a session the hook does not know, nor for a console caller', async () => {
    const asked: string[] = [];
    const notVisitor: RunApiEnvironment['admitVisitorWrite'] = (_w, sessionId) => {
      asked.push(sessionId);
      return Promise.resolve(null);
    };
    const tokenHarness = install(SESSION_TOKEN, { admit: notVisitor });
    const run = await seedRun(tokenHarness.store);
    expect((await submitRunFeedback(feedback(run.id, { rating: 'up' }), run.id)).status).toBe(204);
    expect(asked).toEqual([SESSION]);

    const consoleHarness = install(OWNER, { admit: notVisitor });
    const owned = await seedRun(consoleHarness.store);
    expect((await submitRunFeedback(feedback(owned.id, { rating: 'up' }), owned.id)).status).toBe(
      204,
    );
    expect(asked).toEqual([SESSION]);
  });
});
