import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';

import { eventStreamResponse as stream, jsonResponse as json } from '../testing.js';

import { AGENT, RUN, run, detail, client } from './runs.fixture.test-support.js';

describe('RunsClient.list', () => {
  it('renders the query and reads the page', async () => {
    const { runs, calls } = client(() =>
      json(200, { runs: [run('completed')], nextCursor: 'abc' }),
    );
    const page = await runs.list({ status: 'completed', limit: 1 });
    expect(page.nextCursor).toBe('abc');
    expect(calls[0]?.url.search).toBe('?status=completed&limit=1');
  });
});

describe('RunsClient.get (ADR-0104 run trees)', () => {
  it('returns parentRunId, the children and the tree cost the read carries', async () => {
    const child = { ...run('completed'), id: AGENT.replace('1111', '7777'), parentRunId: RUN };
    const body = {
      ...run('completed'),
      children: [child],
      treeCost: { amount: '0.000000', currency: 'USD' },
    };
    const { runs } = client(() => json(200, { run: body }));
    const read = await runs.get(RUN);
    expect(read.parentRunId).toBeNull();
    expect(read.children).toEqual([child]);
    expect(read.treeCost).toEqual({ amount: '0.000000', currency: 'USD' });
  });

  it('refuses more than sixteen children as a contract violation', async () => {
    const child = { ...run('completed'), parentRunId: RUN };
    const body = { ...detail(run('completed')), children: Array.from({ length: 17 }, () => child) };
    const { runs } = client(() => json(200, { run: body }));
    await expect(runs.get(RUN)).rejects.toBeInstanceOf(ContractViolationError);
  });
});

describe('RunsClient.waitForOutcome', () => {
  it('follows to done and returns the settled record', async () => {
    const { runs } = client((call) =>
      call.url.pathname.endsWith('/events')
        ? stream('event: done\n\n')
        : json(200, { run: detail(run('completed')) }),
    );
    const settled = await runs.waitForOutcome(RUN);
    expect(settled.status).toBe('completed');
  });

  it('refuses a record that is still live after done', async () => {
    const { runs } = client((call) =>
      call.url.pathname.endsWith('/events')
        ? stream('event: done\n\n')
        : json(200, { run: detail(run('running')) }),
    );
    await expect(runs.waitForOutcome(RUN)).rejects.toBeInstanceOf(ContractViolationError);
  });
});

describe('RunsClient.rate (issue #665)', () => {
  it('posts the rating and comment to the feedback path and resolves on 204', async () => {
    const { runs, calls } = client(() => new Response(null, { status: 204 }));
    await expect(runs.rate(RUN, { rating: 'down', comment: 'wrong' })).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/runs/${RUN}/feedback`);
    expect(calls[0]?.json).toEqual({ rating: 'down', comment: 'wrong' });
  });

  it('surfaces a 404 for an unknown run as an ApiProblemError', async () => {
    const { runs } = client(() =>
      json(404, { error: { code: 'run_not_found', message: 'no such run' } }),
    );
    const failure = await runs.rate(RUN, { rating: 'up' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('run_not_found');
  });
});

describe('RunsClient.interrupt (issue #235, S-14)', () => {
  it('posts to the interrupt path and returns the run at its new status', async () => {
    const { runs, calls } = client(() => json(200, { run: run('cancelled') }));
    const stopped = await runs.interrupt(RUN);
    expect(stopped.status).toBe('cancelled');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/runs/${RUN}/interrupt`);
  });

  it('surfaces a 409 for an already-terminal run as an ApiProblemError', async () => {
    const { runs } = client(() =>
      json(409, { error: { code: 'run_not_interruptible', message: 'already completed' } }),
    );
    const failure = await runs.interrupt(RUN).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('run_not_interruptible');
    expect((failure as ApiProblemError).status).toBe(409);
  });

  it('surfaces a 404 for an unknown or foreign run as an ApiProblemError', async () => {
    const { runs } = client(() =>
      json(404, { error: { code: 'run_not_found', message: 'no such run' } }),
    );
    const failure = await runs.interrupt(RUN).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(404);
  });

  it('refuses a 200 missing the run, as a contract violation', async () => {
    const { runs } = client(() => json(200, {}));
    const failure = await runs.interrupt(RUN).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runs, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const failure = await runs
      .interrupt(RUN, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('RunsClient.approve and reject (ADR-0145, P5-4)', () => {
  const accepted = () => json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` });

  it('posts the decision, and the comment when there is one, and reads the 202', async () => {
    const { runs, calls } = client(accepted);
    const response = await runs.approve(RUN, { comment: 'go ahead' });
    expect(response.run.status).toBe('queued');
    expect(response.events).toBe(`/api/runs/${RUN}/events`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/runs/${RUN}/approval`);
    expect(calls[0]?.json).toEqual({ decision: 'approve', comment: 'go ahead' });
  });

  it('sends reject without a comment key when none is given', async () => {
    const { runs, calls } = client(accepted);
    await runs.reject(RUN);
    expect(calls[0]?.json).toEqual({ decision: 'reject' });
  });

  it('surfaces a second decision as an ApiProblemError', async () => {
    const { runs } = client(() =>
      json(409, { error: { code: 'approval_already_decided', message: 'already decided' } }),
    );
    const failure = await runs.approve(RUN).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('approval_already_decided');
    expect((failure as ApiProblemError).status).toBe(409);
  });

  it('waitForOutcome returns a run paused for approval instead of failing', async () => {
    const { runs } = client((request) =>
      request.url.pathname.endsWith('/events')
        ? stream('event: done\n\n')
        : json(200, { run: detail(run('awaiting_approval')) }),
    );
    const paused = await runs.waitForOutcome(RUN);
    expect(paused.status).toBe('awaiting_approval');
    expect(paused.pendingApproval).toEqual({ toolName: 'send_email', canonicalCall: '{}' });
  });
});

describe('RunsClient.revokeTokens (issue #235, S-15)', () => {
  it('posts to the named path with tokenId null when omitted, and reads the outcome', async () => {
    const { runs, calls } = client(() => json(200, { revoked: 3, outcome: 'revoked' }));
    const result = await runs.revokeTokens(RUN);
    expect(result).toEqual({ revoked: 3, outcome: 'revoked' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/runs/${RUN}/revoke-tokens`);
    expect(calls[0]?.json).toEqual({ tokenId: null });
  });

  it('sends one tokenId when given', async () => {
    const { runs, calls } = client(() => json(200, { revoked: 1, outcome: 'revoked' }));
    await runs.revokeTokens(RUN, { tokenId: '22222222-2222-4222-8222-222222222222' });
    expect(calls[0]?.json).toEqual({ tokenId: '22222222-2222-4222-8222-222222222222' });
  });

  it('surfaces a 403 for a role without the grant, as an ApiProblemError', async () => {
    const { runs } = client(() =>
      json(403, { error: { code: 'run_token_revoke_forbidden', message: 'not allowed' } }),
    );
    const failure = await runs.revokeTokens(RUN).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(403);
  });
});
