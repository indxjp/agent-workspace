import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '@indx-workspace/sdk';

import { agentId, json, recordingClient, run, runId, stream } from './sdk-runs.test-support.js';

describe('B-sdk-runs real public client', () => {
  it('normalizes start body and records the method, path, headers and expected 202', async () => {
    const { runs, calls } = recordingClient(() =>
      json(202, { run: run('queued'), events: `/api/runs/${runId}/events` }),
    );
    await runs.start(agentId, { prompt: 'go' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${agentId}/runs`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.body).toEqual({
      prompt: 'go',
      sessionId: null,
      modelConnectionId: null,
      model: null,
    });
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer key');
  });

  it('percent-encodes caller-supplied path segments', async () => {
    const { runs, calls } = recordingClient(() => json(200, { run: run('running') }));
    await runs.get('a/b c');
    expect(calls[0]?.url.pathname).toBe('/api/runs/a%2Fb%20c');
  });

  it('uses distinct get, interrupt, revoke and list requests', async () => {
    const { runs, calls } = recordingClient(({ url }) => {
      if (url.pathname.endsWith('/revoke-tokens'))
        return json(200, { revoked: 1, outcome: 'revoked' });
      if (url.pathname === '/api/runs') return json(200, { runs: [], nextCursor: null });
      return json(200, { run: run('cancelled') });
    });
    await runs.get(runId);
    await runs.interrupt(runId);
    await runs.revokeTokens(runId, { tokenId: 'token' });
    await runs.list({ status: 'completed', limit: 2 });
    expect(calls.map(({ url, init }) => [init.method, `${url.pathname}${url.search}`])).toEqual([
      ['GET', `/api/runs/${runId}`],
      ['POST', `/api/runs/${runId}/interrupt`],
      ['POST', `/api/runs/${runId}/revoke-tokens`],
      ['GET', '/api/runs?status=completed&limit=2'],
    ]);
    expect(calls[2]?.body).toEqual({ tokenId: 'token' });
  });

  it('classifies three error envelopes and malformed success without retry', async () => {
    for (const [body, code] of [
      [{ error: { code: 'standard', message: 'x' } }, 'standard'],
      [{ error: { code: 'detail', detail: 'x' } }, 'detail'],
      [{ error: 'bare', message: 'x' }, 'bare'],
      [{ nope: true }, 'unrecognised_error_body'],
    ] as const) {
      const { runs, calls } = recordingClient(() => json(409, body));
      const error = await runs.get(runId).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiProblemError);
      expect((error as ApiProblemError).code).toBe(code);
      expect(calls).toHaveLength(1);
    }
    const malformed = recordingClient(() => json(200, { run: { status: 'running' } }));
    await expect(malformed.runs.get(runId)).rejects.toBeInstanceOf(ContractViolationError);
    expect(malformed.calls).toHaveLength(1);
    const unexpectedSuccess = recordingClient(() => json(201, { run: run('running') }));
    const error = await unexpectedSuccess.runs.get(runId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiProblemError);
    expect((error as ApiProblemError).status).toBe(201);
    expect((error as ApiProblemError).code).toBe('unrecognised_error_body');
  });

  it('keeps the cursor across a dropped stream and stops at cumulative reconnect budget', async () => {
    const { runs, calls } = recordingClient(() =>
      stream('event: sdk-event\nid: 7\ndata: {"kind":"event"}\n\n'),
    );
    let seen = 0;
    const error = await (async () => {
      for await (const frame of runs.follow(runId, { maxReconnects: 2, reconnectDelayMs: 0 })) {
        expect(frame.kind).toBe('runtime');
        seen += 1;
      }
    })().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect(calls).toHaveLength(3);
    expect(calls.map(({ init }) => new Headers(init.headers).get('last-event-id'))).toEqual([
      null,
      '7',
      '7',
    ]);
    expect(seen).toBe(3);
  });

  it('does not reconnect after a caller abort', async () => {
    const controller = new AbortController();
    const { runs, calls } = recordingClient(() => {
      controller.abort();
      throw new TypeError('connection dropped');
    });
    const error = await runs
      .follow(runId, { signal: controller.signal })
      .next()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect(calls).toHaveLength(1);
  });

  it('does not reconnect after an API refusal or contract drift', async () => {
    for (const [response, errorClass] of [
      [json(404, { error: { code: 'run_not_found', message: 'missing' } }), ApiProblemError],
      [
        new Response('oops', { status: 200, headers: { 'content-type': 'text/plain' } }),
        ContractViolationError,
      ],
    ] as const) {
      const { runs, calls } = recordingClient(() => response);
      const error = await runs
        .follow(runId, { maxReconnects: 5, reconnectDelayMs: 0 })
        .next()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(errorClass);
      expect(calls).toHaveLength(1);
    }
  });

  it('times out while waiting for headers and classifies the abort as transport', async () => {
    const { runs, calls } = recordingClient(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('late', 'AbortError')),
          );
        }),
      { timeoutMs: 10 },
    );
    const error = await runs.get(runId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('finds the indeterminate done/live-record disagreement', async () => {
    const { runs, calls } = recordingClient(({ url }) =>
      url.pathname.endsWith('/events')
        ? stream(
            'event: run-failed\ndata: {"status":"unknown","message":"lost"}\n\nevent: done\ndata: null\n\n',
          )
        : json(200, { run: run('running') }),
    );
    const error = await runs.waitForOutcome(runId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractViolationError);
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      `/api/runs/${runId}/events`,
      `/api/runs/${runId}`,
    ]);
  });

  it('keeps follow error classes when wait cannot reach a done frame', async () => {
    const refused = recordingClient(() =>
      json(404, { error: { code: 'run_not_found', message: 'missing' } }),
    );
    await expect(refused.runs.waitForOutcome(runId)).rejects.toBeInstanceOf(ApiProblemError);
    expect(refused.calls).toHaveLength(1);
    const dropped = recordingClient(() => stream('event: sdk-event\ndata: {"kind":"event"}\n\n'));
    await expect(dropped.runs.waitForOutcome(runId, { maxReconnects: 0 })).rejects.toBeInstanceOf(
      TransportError,
    );
    expect(dropped.calls).toHaveLength(1);
  });
});
