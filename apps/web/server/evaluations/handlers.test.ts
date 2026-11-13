import { EvaluationResourceSchema } from '@indx-workspace/contracts/evaluations';
import { describe, expect, it } from 'vitest';

import { createModelJudge, evaluateAgentVersion } from './handlers';
import {
  AGENT,
  DRAFT_CASE,
  DRAFT_SCHEMA,
  EVALUATION_ID,
  failuresOf,
  judgeSays,
  ORDER_CASE,
  ORDER_CASE_AGAIN,
  PRINCIPAL,
  REFUND_CASE,
  setUp,
  VERSION_ID,
  WORKSPACE,
} from './handlers.test-support';

// The approval pause, deadlines, the judge and SPD-05 run in `handlers.{approval,deadline,judge,stop-runs}.test.ts`.
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
    expect(failuresOf(result)).toEqual([['model_credential_rejected'], ['run_failed']]);
  });

  describe('in-process run limits', () => {
    it('starts every case run under the limits its caller passes', async () => {
      const { evaluate, limitsSeen } = setUp({ limits: { maxBudgetUsd: 0.3 } });
      await evaluate({ version: 7, cases: [ORDER_CASE, ORDER_CASE_AGAIN] });
      expect(limitsSeen).toEqual([{ maxBudgetUsd: 0.3 }, { maxBudgetUsd: 0.3 }]);
    });

    it('starts no limits when its caller passes none', async () => {
      const { evaluate, limitsSeen } = setUp();
      await evaluate({ version: 7, cases: [ORDER_CASE] });
      expect(limitsSeen).toEqual([undefined]);
    });

    it('refuses a limits key in the body: it is not part of the request', async () => {
      const { evaluate, limitsSeen } = setUp();
      const result = await evaluate({
        version: 7,
        cases: [ORDER_CASE],
        limits: { maxBudgetUsd: 100 },
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: 'invalid_body' } });
      expect(limitsSeen).toEqual([]);
    });
  });

  it('runs every case, scores it, stores the row and answers 201', async () => {
    const { evaluate, recorded } = setUp({
      judge: () => judgeSays('{"pass": true, "reason": "Polite, no promise."}'),
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
      judge: () => judgeSays('Verdict: {"pass": false, "reason": "Too curt."}'),
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
    expect(failuresOf(result)).toEqual([
      ['notContains: "shipped" is in the answer'],
      ['judge: Too curt.'],
      ['run_failed'],
      [],
    ]);
    const evaluation = EvaluationResourceSchema.parse(result.body);
    expect(evaluation).toMatchObject({ score: 0.25, passed: 1, total: 4 });
    expect(recorded).toHaveLength(1);
  });

  it('scores the whole turn, and a refused tool call is not a call (EVL-01, EVL-02)', async () => {
    const { evaluate } = setUp();
    const result = await evaluate({
      version: 7,
      cases: [
        {
          name: 'asks first',
          input: 'Ask, then try the tool',
          expect: { contains: ['Which order do you mean?', 'was refused'] },
        },
        { name: 'refused', input: 'Ask, then try the tool', expect: { tool: 'orders_refund' } },
      ],
    });
    expect(failuresOf(result)).toEqual([[], ['tool: orders_refund was not called']]);
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

  it('starts a case with its outputSchema and passes it on the structured output', async () => {
    const { evaluate, schemas } = setUp();
    const result = await evaluate({ version: 7, cases: [DRAFT_CASE, ORDER_CASE] });
    expect(failuresOf(result)).toEqual([[], []]);
    expect(schemas).toEqual([DRAFT_SCHEMA, undefined]);
  });

  it('fails a case whose structured output lacks the expected value', async () => {
    const { evaluate } = setUp();
    const wrong = { ...DRAFT_CASE, expect: { output: { width: 141 } } };
    const result = await evaluate({ version: 7, cases: [wrong] });
    expect(failuresOf(result)[0]).toEqual([
      'output: the structured output did not have {"width":141}',
    ]);
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
});
