import type { AgentVersionRecord } from '@agent-workspace/core/db';
import { EvaluationResourceSchema } from '@indx-workspace/contracts/evaluations';
import type { AgentFrame } from '@indx-workspace/contracts/run-events';
import { describe, expect, it, vi } from 'vitest';

import type { LaunchContext, Principal, RunApiEnvironment } from '../runs/environment';
import { InMemoryRunStore, type RunStatus } from '../runs/store';
import {
  createModelJudge,
  evaluateAgentVersion,
  type EvaluateAgentVersionDependencies,
} from './handlers';
import { assistantSays, ORDER_STATUS_FRAMES, toolCall } from './fixtures';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';
const EVALUATION_ID = '55555555-5555-4555-8555-555555555555';
const PRINCIPAL: Principal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: null,
  workspaceId: WORKSPACE,
  role: 'builder',
  scope: null,
};

/** What the fake runtime does with a prompt: play frames and end, or never answer. */
type Script =
  | {
      readonly frames: readonly AgentFrame[];
      readonly status: RunStatus;
      readonly error?: string;
    }
  | 'hang';

const SCRIPTS: Readonly<Record<string, Script>> = {
  'Where is order 1042?': { frames: ORDER_STATUS_FRAMES, status: 'completed' },
  'I want my money back now': {
    frames: [assistantSays('I am sorry. I cannot refund it, but I can help.')],
    status: 'completed',
  },
  'Use the tool': { frames: [toolCall('orders_refund'), assistantSays('Done.')], status: 'failed' },
  'Never answers': 'hang',
  'Bad key': {
    frames: [],
    status: 'failed',
    error:
      'model_credential_rejected: the agent model connection "default": The provider rejected the API key (HTTP 401). Replace the key on this connection.',
  },
};

interface Setup {
  readonly judge?: RunApiEnvironment['judgeEvaluationCase'];
  readonly preflight?: RunApiEnvironment['preflight'];
  readonly deadlineMs?: number;
  /** Delay before `openSession` answers, in milliseconds. */
  readonly openSessionDelayMs?: number;
}

function setUp(setup: Setup = {}) {
  const store = new InMemoryRunStore();
  const playing: Promise<void>[] = [];
  const recorded: unknown[] = [];
  const interrupted: string[] = [];
  /** The version each opened session pinned, and each preflight checked. */
  const pins: { session: (string | undefined)[]; preflight: (string | undefined)[] } = {
    session: [],
    preflight: [],
  };
  const play = async ({ run, prompt }: LaunchContext) => {
    const script = SCRIPTS[prompt];
    if (script === undefined || script === 'hang') return;
    for (const frame of script.frames) {
      await store.append(run.id, { type: frame.frame, data: frame });
    }
    await store.finish(run.id, script.status, script.error ?? null, true);
  };
  const runs: RunApiEnvironment = {
    authenticate: () => Promise.resolve(PRINCIPAL),
    findAgent: () =>
      Promise.resolve({ id: AGENT, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' }),
    openSession: async (_principal, agent, _requested, agentVersionId) => {
      pins.session.push(agentVersionId);
      if (setup.openSessionDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, setup.openSessionDelayMs));
      }
      return {
        id: crypto.randomUUID(),
        agentId: agent.id,
        engine: null,
        agentVersionId: agentVersionId ?? null,
      };
    },
    ownsRun: () => Promise.resolve(true),
    interruptRun: async (_principal, run) => {
      interrupted.push(run.id);
      await store.finish(run.id, 'cancelled', null, true);
    },
    store,
    launch: (context) => {
      playing.push(play(context));
    },
    recordEvaluation: (_principal, evaluation) => {
      recorded.push(evaluation);
      return Promise.resolve({ id: EVALUATION_ID, createdAt: new Date('2026-10-04T00:00:00Z') });
    },
    ...(setup.judge === undefined ? {} : { judgeEvaluationCase: setup.judge }),
    preflight: (principal, agent, sessionId, modelOverride, agentVersionId) => {
      pins.preflight.push(agentVersionId);
      return setup.preflight === undefined
        ? Promise.resolve(null)
        : setup.preflight(principal, agent, sessionId, modelOverride, agentVersionId);
    },
  };
  const version: AgentVersionRecord = {
    id: VERSION_ID,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    number: 7,
    summary: 'v7',
    via: 'aw-push',
    body: {},
    createdByPrincipalId: PRINCIPAL.principalId,
    createdAt: new Date(),
  };
  const dependencies: EvaluateAgentVersionDependencies = {
    store: { find: (_agentId, number) => Promise.resolve(number === 7 ? version : null) },
    runs,
    ...(setup.deadlineMs === undefined ? {} : { deadlineMs: setup.deadlineMs }),
  };
  const evaluate = async (body: unknown) => {
    const result = await evaluateAgentVersion(body, AGENT, PRINCIPAL, dependencies);
    await Promise.all(playing);
    return result;
  };
  return { evaluate, recorded, interrupted, pins, store };
}

const ORDER_CASE = {
  name: 'order status uses the tool',
  input: 'Where is order 1042?',
  expect: { tool: 'orders_getOrder', contains: ['shipped'] },
};
const ORDER_CASE_AGAIN = { ...ORDER_CASE, name: 'order status again' };
const REFUND_CASE = {
  name: 'no refund promises',
  input: 'I want my money back now',
  expect: { judge: 'Stays polite and does not promise a refund' },
};

/** `pending`, whose `settled()` fails unless it has already settled: no waiting on real time. */
function settledAfter<T>(pending: Promise<T>) {
  let done = false;
  const mark = () => {
    done = true;
  };
  void pending.then(mark, mark);
  return {
    settled: () => {
      expect(done).toBe(true);
      return pending;
    },
  };
}

describe('evaluateAgentVersion (issue #618)', () => {
  // Issue #661: a run the provider refused reports its code, not `run_failed`.
  it("reports a failed run's own code in place of run_failed", async () => {
    const { evaluate } = setUp();
    const result = await evaluate({
      version: 7,
      cases: [
        { name: 'bad key', input: 'Bad key', expect: { contains: ['x'] } },
        { name: 'uncoded failure', input: 'Use the tool', expect: { tool: 'orders_refund' } },
      ],
    });
    const evaluation = EvaluationResourceSchema.parse(result.body);
    expect(evaluation.results.map((r) => r.failures)).toEqual([
      ['model_credential_rejected'],
      ['run_failed'],
    ]);
  });

  it('runs every case, scores it, stores the row and answers 201', async () => {
    const { evaluate, recorded } = setUp({
      judge: () => Promise.resolve('{"pass": true, "reason": "Polite, no promise."}'),
    });
    const result = await evaluate({ version: 7, cases: [ORDER_CASE, REFUND_CASE] });
    expect(result.status).toBe(201);
    const evaluation = EvaluationResourceSchema.parse(result.body);
    expect(evaluation).toMatchObject({ id: EVALUATION_ID, agentId: AGENT, version: 7, score: 1 });
    expect(evaluation.results.map((r) => [r.name, r.passed, r.failures])).toEqual([
      [ORDER_CASE.name, true, []],
      [REFUND_CASE.name, true, []],
    ]);
    expect(recorded).toEqual([
      {
        versionId: VERSION_ID,
        passed: 2,
        total: 2,
        casesSnapshot: [ORDER_CASE, REFUND_CASE],
        results: evaluation.results,
      },
    ]);
  });

  it('stores a mixed score with each failure named', async () => {
    const { evaluate, recorded } = setUp({
      judge: () => Promise.resolve('Verdict: {"pass": false, "reason": "Too curt."}'),
    });
    const result = await evaluate({
      version: 7,
      cases: [
        { ...ORDER_CASE, expect: { notContains: ['shipped'] } },
        REFUND_CASE,
        { name: 'failed run', input: 'Use the tool', expect: { tool: 'orders_refund' } },
        { name: 'passes', input: 'Where is order 1042?', expect: { contains: ['1042'] } },
      ],
    });
    const evaluation = EvaluationResourceSchema.parse(result.body);
    expect(evaluation.results.map((r) => r.failures)).toEqual([
      ['notContains: "shipped" is in the answer'],
      ['judge: Too curt.'],
      ['run_failed'],
      [],
    ]);
    expect(evaluation).toMatchObject({ score: 0.25, passed: 1, total: 4 });
    expect(recorded).toHaveLength(1);
  });

  it('runs every case on a new session pinned to the requested version, not to local', async () => {
    // The fake store has no pointers at all: only the requested version decides the pin.
    const { evaluate, pins } = setUp();
    const result = await evaluate({ version: 7, cases: [ORDER_CASE, ORDER_CASE_AGAIN] });
    expect(result.status).toBe(201);
    expect(pins).toEqual({
      session: [VERSION_ID, VERSION_ID],
      preflight: [VERSION_ID, VERSION_ID],
    });
  });

  it("judges each case with the evaluated version's model connection, not local's", async () => {
    // `local` points at another version, whose model is on another connection.
    const asked: string[] = [];
    const { evaluate } = setUp({
      judge: createModelJudge({
        resolveModel: ({ agentVersionId }) =>
          Promise.resolve({
            ok: true,
            layer: 'agent',
            connectionId:
              agentVersionId === VERSION_ID ? 'version-7-connection' : 'local-connection',
            model: agentVersionId === VERSION_ID ? 'version-7-model' : 'local-model',
            provider: 'anthropic',
            validated: true,
            connectionName: 'model',
          }),
        connection: (_workspaceId, connectionId) => {
          asked.push(connectionId);
          return Promise.resolve(null);
        },
      }),
    });
    await evaluate({ version: 7, cases: [REFUND_CASE] });
    expect(asked).toEqual(['version-7-connection']);
  });

  it.each([
    ['an invalid body', { version: 7, cases: [] }, 400, 'invalid_body'],
    ['a missing version', { version: 8, cases: [ORDER_CASE] }, 404, 'agent_version_not_found'],
  ] as const)('refuses %s, starting no run and storing nothing', async (_, body, status, code) => {
    const { evaluate, recorded, store } = setUp();
    const result = await evaluate(body);
    expect(result.status).toBe(status);
    expect(result.body).toMatchObject({ error: { code } });
    expect((await store.listRuns(WORKSPACE, { limit: 10 })).items).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('answers a refused first start with its code and stores nothing; a later one fails its case', async () => {
    const refusal = { code: 'model_unavailable', message: 'gone.' } as const;
    const first = setUp({ preflight: () => Promise.resolve(refusal) });
    const refused = await first.evaluate({ version: 7, cases: [ORDER_CASE] });
    expect(refused).toEqual({
      status: 422,
      body: { error: { code: 'model_unavailable', message: 'gone.' } },
    });
    expect(first.recorded).toEqual([]);

    let calls = 0;
    const later = setUp({ preflight: () => Promise.resolve(++calls === 1 ? null : refusal) });
    const result = await later.evaluate({ version: 7, cases: [ORDER_CASE, REFUND_CASE] });
    const evaluation = EvaluationResourceSchema.parse(result.body);
    expect(evaluation.results[1]).toEqual({
      name: REFUND_CASE.name,
      passed: false,
      runId: null,
      failures: ['model_unavailable'],
    });
  });

  it('fails the running case and every later one at the deadline, and still stores the row', async () => {
    // Fake time: the start always lands before the deadline, so case 1 always reaches the wait.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const { evaluate, recorded, interrupted, store } = setUp({ deadlineMs: 50 });
      const pending = settledAfter(
        evaluate({
          version: 7,
          cases: [
            { name: 'slow', input: 'Never answers', expect: { contains: ['x'] } },
            ORDER_CASE,
          ],
        }),
      );
      await vi.advanceTimersByTimeAsync(50);
      const evaluation = EvaluationResourceSchema.parse((await pending.settled()).body);
      expect(evaluation.results.map((r) => [r.failures, r.runId === null])).toEqual([
        [['deadline_exceeded'], false],
        [['deadline_exceeded'], true],
      ]);
      expect(evaluation.score).toBe(0);
      expect(recorded).toHaveLength(1);
      // The abandoned run is stopped rather than left spending.
      await vi.waitFor(() => expect(interrupted).toEqual([evaluation.results[0]?.runId]));
      expect((await store.get(interrupted[0] ?? ''))?.status).toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a slow session open against the deadline and interrupts the run it starts late', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const { evaluate, recorded, interrupted, store } = setUp({
        deadlineMs: 50,
        openSessionDelayMs: 150,
      });
      const pending = settledAfter(
        evaluate({
          version: 7,
          cases: [{ name: 'slow', input: 'Never answers', expect: { contains: ['x'] } }],
        }),
      );
      await vi.advanceTimersByTimeAsync(50);
      expect(
        EvaluationResourceSchema.parse((await pending.settled()).body).results[0],
      ).toMatchObject({ runId: null, failures: ['deadline_exceeded'] });
      expect(recorded).toHaveLength(1);
      // The response came before the session opened: nothing to interrupt yet.
      expect(interrupted).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(interrupted).toHaveLength(1));
      expect((await store.get(interrupted[0] ?? ''))?.status).toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a judge cut off by the deadline with deadline_exceeded and still stores the row', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    // Fake timers do not reach `AbortSignal.timeout`; route it through the faked `setTimeout`.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException('timed out', 'TimeoutError'));
      }, ms);
      return controller.signal;
    });
    try {
      const { evaluate, recorded } = setUp({
        deadlineMs: 50,
        judge: (_principal, _agent, _versionId, _prompt, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            });
          }),
      });
      const pending = settledAfter(evaluate({ version: 7, cases: [REFUND_CASE] }));
      await vi.advanceTimersByTimeAsync(50);
      expect(
        EvaluationResourceSchema.parse((await pending.settled()).body).results[0]?.failures,
      ).toEqual(['deadline_exceeded']);
      expect(recorded).toHaveLength(1);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fails only the case whose run stream cannot be read with run_stream_failed', async () => {
    const { evaluate, recorded, store } = setUp();
    let opened = 0;
    const openStream = store.openStream.bind(store);
    store.openStream = async (runId, after) => {
      if (++opened > 1) return openStream(runId, after);
      return {
        reset: null,
        events: {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('the event store read failed')),
          }),
        },
        close: () => undefined,
      };
    };
    const result = await evaluate({ version: 7, cases: [ORDER_CASE, ORDER_CASE_AGAIN] });
    expect(result.status).toBe(201);
    const evaluation = EvaluationResourceSchema.parse(result.body);
    expect(evaluation.results.map((r) => [r.failures, r.runId === null])).toEqual([
      [['run_stream_failed'], false],
      [[], false],
    ]);
    expect(evaluation).toMatchObject({ score: 0.5, passed: 1, total: 2 });
    expect(recorded).toHaveLength(1);
  });

  it('answers 503 run_api_not_configured without a run API', async () => {
    const result = await evaluateAgentVersion(
      { version: 7, cases: [ORDER_CASE] },
      AGENT,
      PRINCIPAL,
      {
        store: { find: () => Promise.resolve(null) },
        runs: null,
      },
    );
    expect(result).toMatchObject({
      status: 503,
      body: { error: { code: 'run_api_not_configured' } },
    });
  });

  it('fails a judge case with judge_unavailable and never returns the provider text', async () => {
    const { evaluate } = setUp({
      judge: () => Promise.reject(new Error('401 from https://llm.internal key=sk-secret')),
    });
    const result = await evaluate({ version: 7, cases: [REFUND_CASE] });
    expect(JSON.stringify(result.body)).not.toContain('sk-secret');
    expect(EvaluationResourceSchema.parse(result.body).results[0]?.failures).toEqual([
      'judge_unavailable',
    ]);
  });

  it('fails a judge case whose verdict cannot be read with judge_unparseable', async () => {
    const { evaluate } = setUp({ judge: () => Promise.resolve('Looks fine to me.') });
    const result = await evaluate({ version: 7, cases: [REFUND_CASE] });
    expect(EvaluationResourceSchema.parse(result.body).results[0]?.failures).toEqual([
      'judge_unparseable',
    ]);
  });
});
