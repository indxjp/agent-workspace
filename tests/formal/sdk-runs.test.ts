import { describe, expect, it } from 'vitest';

import {
  ApiProblemError,
  ContractViolationError,
  TransportError,
  createClient,
} from '@indx-workspace/sdk';

import { asRecord, asString, loadVectors } from './vectors.js';

const requestVectors = loadVectors('sdk-runs', 'requests.json');
const listVectors = loadVectors('sdk-runs', 'list.json');
const followVectors = loadVectors('sdk-runs', 'follow.json');
const traceVectors = loadVectors('sdk-runs', 'trace.json');
const waitVectors = loadVectors('sdk-runs', 'wait.json');

type Seen = { url: URL; init: RequestInit; body: unknown };

function recordingClient(
  route: (call: Seen) => Response | Promise<Response>,
  options: { timeoutMs?: number } = {},
) {
  const calls: Seen[] = [];
  const fetchDouble: typeof fetch = async (input, init = {}) => {
    const body: unknown = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    const url = input instanceof Request ? new URL(input.url) : new URL(input);
    const call = { url, init, body };
    calls.push(call);
    return route(call);
  };
  const client = createClient({
    baseUrl: 'https://example.test',
    auth: { kind: 'api-key', apiKey: 'key' },
    fetch: fetchDouble,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { runs: client.runs, calls };
}

const runId = '33333333-3333-4333-8333-333333333333';
const agentId = '11111111-1111-4111-8111-111111111111';
const run = (status: string) => ({
  id: runId,
  workspaceId: '44444444-4444-4444-8444-444444444444',
  agentId,
  projectId: null,
  initiatingUserId: null,
  sessionId: '55555555-5555-4555-8555-555555555555',
  agentVersion: null,
  status,
  createdAt: '2026-09-21T10:00:00.000Z',
  startedAt: null,
  endedAt: null,
  durationMs: null,
  model: null,
  provider: null,
  modelConnectionId: null,
  engine: 'claude-agent-sdk',
  engineVersion: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
  },
  cost: { amount: '0.000000', currency: 'USD', priceTableVersion: null },
  error: null,
  output: null,
  pendingApproval: null,
  accountingState: 'pending',
  accountingError: null,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const stream = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

describe('B-sdk-runs real public client', () => {
  it.each(traceVectors)('replays $id cumulative drop trace', async ({ id, input, expected }) => {
    const fields = asRecord(input, id);
    const modeled = asRecord(expected, id);
    const maxReconnects = Number(fields['maxReconnects']);
    const drops = Number(fields['drops']);
    let attempts = 0;
    const { runs, calls } = recordingClient(() => {
      attempts += 1;
      return attempts <= drops
        ? stream('event: sdk-event\nid: 7\ndata: {"kind":"event"}\n\n')
        : stream('event: done\ndata: null\n\n');
    });
    await (async () => {
      for await (const frame of runs.follow(runId, { maxReconnects, reconnectDelayMs: 0 })) {
        expect(frame.kind).toBe('runtime');
      }
    })().catch((error: unknown) => {
      expect(error).toBeInstanceOf(TransportError);
    });
    expect(calls.length - 1).toBe(modeled['reconnects']);
    expect(calls.length).toBeLessThanOrEqual(maxReconnects + 1);
  });

  it.each(listVectors)('replays $id nonempty list query', async ({ id, input, expected }) => {
    const fields = asRecord(input, id);
    if (fields['status'] !== 'completed') throw new Error(`unexpected list status in ${id}`);
    const { runs, calls } = recordingClient(() => json(200, { runs: [], nextCursor: null }));
    await runs.list({
      status: fields['status'],
      agent: asString(fields['agent'], 'agent'),
      limit: Number(fields['limit']),
    });
    expect(calls).toHaveLength(1);
    expect(Array.from(calls[0]?.url.searchParams.entries() ?? [])).toEqual(expected);
  });

  it.each(followVectors)('replays $id follow budget vector', async ({ id, input, expected }) => {
    const fields = asRecord(input, id);
    const modeled = asRecord(expected, id);
    const reconnects = Number(fields['reconnects']);
    const maxReconnects = Number(fields['maxReconnects']);
    const callerAborted = fields['callerAborted'] === true;
    const controller = new AbortController();
    if (callerAborted) controller.abort();
    const { runs, calls } = recordingClient(() =>
      stream('event: sdk-event\nid: 7\ndata: {"kind":"event"}\n\n'),
    );
    const remaining = Math.max(0, maxReconnects - reconnects);
    const error = await (async () => {
      for await (const frame of runs.follow(runId, {
        maxReconnects: remaining,
        reconnectDelayMs: 0,
        signal: controller.signal,
      })) {
        expect(frame.kind).toBe('runtime');
      }
    })().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    const action = asString(modeled['kind'], 'kind');
    expect(calls.length > 1).toBe(action === 'reconnect' && !callerAborted);
    if (action === 'reconnect') {
      expect(new Headers(calls[1]?.init.headers).get('last-event-id')).toBe(modeled['after']);
      expect(modeled['reconnects']).toBe(reconnects + 1);
    }
  });

  it.each(requestVectors)('replays $id request vector', async ({ id, input, expected }) => {
    const fields = asRecord(input, id);
    const modeled = asRecord(expected, id);
    const method = asString(fields['method'], 'method');
    const { runs, calls } = recordingClient(() => {
      if (method === 'start')
        return json(202, { run: run('queued'), events: `/api/runs/${runId}/events` });
      if (method === 'events') return stream('event: done\n\n');
      if (method === 'revoke') return json(200, { revoked: 1, outcome: 'revoked' });
      return json(200, { run: run('running') });
    });
    switch (method) {
      case 'start':
        await runs.start(asString(fields['agentId'], 'agentId'), {
          prompt: asString(fields['prompt'], 'prompt'),
          ...(typeof fields['sessionId'] === 'string' ? { sessionId: fields['sessionId'] } : {}),
          ...(typeof fields['modelConnectionId'] === 'string' && typeof fields['model'] === 'string'
            ? {
                modelOverride: {
                  connectionId: fields['modelConnectionId'],
                  model: fields['model'],
                },
              }
            : {}),
        });
        break;
      case 'get':
        await runs.get(asString(fields['runId'], 'runId'));
        break;
      case 'interrupt':
        await runs.interrupt(asString(fields['runId'], 'runId'));
        break;
      case 'revoke':
        await runs.revokeTokens(asString(fields['runId'], 'runId'), {
          tokenId: typeof fields['tokenId'] === 'string' ? fields['tokenId'] : null,
        });
        break;
      case 'events':
        for await (const frame of runs.events(asString(fields['runId'], 'runId'), {
          after: typeof fields['after'] === 'string' ? fields['after'] : null,
        })) {
          expect(frame.kind).not.toBe('done');
        }
        break;
      default:
        throw new Error(`unknown vector method ${method}`);
    }
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('missing recorded fetch');
    const modeledHeaders = asRecord(modeled['headers'], 'headers');
    const headers = new Headers(call.init.headers);
    const selectedHeaders = Object.fromEntries(
      Object.keys(modeledHeaders).map((name) => [name, headers.get(name)]),
    );
    expect({
      method: call.init.method,
      path: call.url.pathname,
      headers: selectedHeaders,
      body: call.body,
      expect: method === 'start' ? 202 : 200,
    }).toEqual(modeled);
  });

  it.each(waitVectors)('replays $id wait vector', async ({ id, input, expected }) => {
    const fields = asRecord(input, id);
    const modeled = asRecord(expected, id);
    const status = asString(fields['status'], 'status');
    const { runs } = recordingClient(({ url }) =>
      url.pathname.endsWith('/events')
        ? stream('event: done\n\n')
        : json(200, { run: run(status) }),
    );
    const outcome = await runs.waitForOutcome(runId).then(
      () => false,
      (error: unknown) => {
        expect(error).toBeInstanceOf(ContractViolationError);
        return true;
      },
    );
    expect(outcome).toBe(modeled['violation']);
  });

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
