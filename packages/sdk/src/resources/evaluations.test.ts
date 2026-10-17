import { describe, expect, it } from 'vitest';

import type {
  EvaluationResource,
  EvaluationRunResource,
} from '@indx-workspace/contracts/evaluations';

import { ApiProblemError, ContractViolationError } from '../errors.js';
import { createClient } from '../index.js';
import { fetchDouble, jsonResponse, type RecordedRequest } from '../testing.js';

/** Issue #618: `agents.evaluations.create`. */

const AGENT = '33333333-3333-4333-8333-333333333333';
const request = {
  version: 7,
  cases: [{ name: 'order status', input: 'Where is order 1042?', expect: { contains: ['1042'] } }],
};
const evaluation: EvaluationResource = {
  id: '55555555-5555-4555-8555-555555555555',
  agentId: AGENT,
  version: 7,
  score: 1,
  passed: 1,
  total: 1,
  results: [
    {
      name: 'order status',
      passed: true,
      runId: '66666666-6666-4666-8666-666666666666',
      failures: [],
    },
  ],
  createdAt: '2026-10-04T00:00:00.000Z',
};

function client(route: (request: RecordedRequest) => Response) {
  const api = fetchDouble(route);
  const aw = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { aw, calls: api.calls };
}

describe('EvaluationsClient.create', () => {
  it('posts the version and cases and reads the 201 evaluation', async () => {
    const { aw, calls } = client(() => jsonResponse(201, evaluation));
    expect(await aw.agents.evaluations.create(AGENT, request)).toEqual(evaluation);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${AGENT}/evaluations`);
    expect(calls[0]?.json).toEqual(request);
  });

  it('raises the refusal as an ApiProblemError with its code', async () => {
    const { aw } = client(() =>
      jsonResponse(404, {
        error: {
          code: 'agent_version_not_found',
          message: 'No such version.',
          details: ['version:7'],
        },
      }),
    );
    await expect(aw.agents.evaluations.create(AGENT, request)).rejects.toMatchObject({
      constructor: ApiProblemError,
      code: 'agent_version_not_found',
      status: 404,
    });
  });

  it('refuses a 201 that is not an evaluation', async () => {
    const { aw } = client(() => jsonResponse(201, { ...evaluation, score: 2 }));
    await expect(aw.agents.evaluations.create(AGENT, request)).rejects.toBeInstanceOf(
      ContractViolationError,
    );
  });
});

describe('EvaluationsClient runs (issue #799)', () => {
  const run: EvaluationRunResource = { ...evaluation, status: 'running', results: [], passed: 0 };

  it('createRun posts the cases and reads the 202 run', async () => {
    const { aw, calls } = client(() => jsonResponse(202, run));
    expect(await aw.agents.evaluations.createRun(AGENT, request)).toEqual(run);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${AGENT}/evaluation-runs`);
    expect(calls[0]?.json).toEqual(request);
  });

  it('advanceRun posts the run id and reads the 200 run', async () => {
    const { aw, calls } = client(() => jsonResponse(200, { ...evaluation, status: 'completed' }));
    expect(await aw.agents.evaluations.advanceRun(AGENT, evaluation.id)).toMatchObject({
      status: 'completed',
    });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${AGENT}/evaluation-advance`);
    expect(calls[0]?.json).toEqual({ evaluationId: evaluation.id });
  });

  it('getRun reads the run named in the query', async () => {
    const { aw, calls } = client(() => jsonResponse(200, run));
    expect(await aw.agents.evaluations.getRun(AGENT, evaluation.id)).toEqual(run);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${AGENT}/evaluation-runs`);
    expect(calls[0]?.url.searchParams.get('evaluation')).toBe(evaluation.id);
  });

  it('raises a refusal with its code and refuses a run with an unknown status', async () => {
    const busy = client(() =>
      jsonResponse(409, { error: { code: 'evaluation_run_busy', message: 'Busy.' } }),
    );
    await expect(busy.aw.agents.evaluations.advanceRun(AGENT, evaluation.id)).rejects.toMatchObject(
      {
        constructor: ApiProblemError,
        code: 'evaluation_run_busy',
        status: 409,
      },
    );
    const odd = client(() => jsonResponse(200, { ...run, status: 'queued' }));
    await expect(odd.aw.agents.evaluations.getRun(AGENT, evaluation.id)).rejects.toBeInstanceOf(
      ContractViolationError,
    );
  });
});
