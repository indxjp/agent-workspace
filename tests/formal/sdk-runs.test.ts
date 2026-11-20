import { describe, expect, it } from 'vitest';

import { ContractViolationError, TransportError } from '@indx-workspace/sdk';

import { json, recordingClient, run, runId, stream } from './sdk-runs.test-support.js';
import { asRecord, asString, loadVectors } from './vectors.js';

const requestVectors = loadVectors('sdk-runs', 'requests.json');
const listVectors = loadVectors('sdk-runs', 'list.json');
const followVectors = loadVectors('sdk-runs', 'follow.json');
const traceVectors = loadVectors('sdk-runs', 'trace.json');
const waitVectors = loadVectors('sdk-runs', 'wait.json');

type Runs = ReturnType<typeof recordingClient>['runs'];
type Fields = Record<string, unknown>;

const optionalString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

function routeRequestVector(method: string): Response {
  switch (method) {
    case 'start':
      return json(202, { run: run('queued'), events: `/api/runs/${runId}/events` });
    case 'events':
      return stream('event: done\n\n');
    case 'revoke':
      return json(200, { revoked: 1, outcome: 'revoked' });
    default:
      return json(200, { run: run('running') });
  }
}

function startOptions(fields: Fields) {
  const { sessionId, modelConnectionId, model } = fields;
  return {
    prompt: asString(fields['prompt'], 'prompt'),
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof modelConnectionId === 'string' && typeof model === 'string'
      ? { modelOverride: { connectionId: modelConnectionId, model } }
      : {}),
  };
}

async function drainEvents(runs: Runs, fields: Fields): Promise<void> {
  const frames = runs.events(asString(fields['runId'], 'runId'), {
    after: optionalString(fields['after']),
  });
  for await (const frame of frames) {
    expect(frame.kind).not.toBe('done');
  }
}

async function callVectorMethod(runs: Runs, method: string, fields: Fields): Promise<void> {
  switch (method) {
    case 'start':
      await runs.start(asString(fields['agentId'], 'agentId'), startOptions(fields));
      return;
    case 'get':
      await runs.get(asString(fields['runId'], 'runId'));
      return;
    case 'interrupt':
      await runs.interrupt(asString(fields['runId'], 'runId'));
      return;
    case 'revoke':
      await runs.revokeTokens(asString(fields['runId'], 'runId'), {
        tokenId: optionalString(fields['tokenId']),
      });
      return;
    case 'events':
      await drainEvents(runs, fields);
      return;
    default:
      throw new Error(`unknown vector method ${method}`);
  }
}

async function consumeFollow(runs: Runs, options: Parameters<Runs['follow']>[1]): Promise<unknown> {
  return (async () => {
    for await (const frame of runs.follow(runId, options)) {
      expect(frame.kind).toBe('runtime');
    }
  })().catch((caught: unknown) => caught);
}

function selectHeaders(init: RequestInit, modeled: Fields) {
  const headers = new Headers(init.headers);
  return Object.fromEntries(
    Object.keys(asRecord(modeled['headers'], 'headers')).map((name) => [name, headers.get(name)]),
  );
}

describe('B-sdk-runs real public client vectors', () => {
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
    const error = await consumeFollow(runs, { maxReconnects, reconnectDelayMs: 0 });
    if (error !== undefined) expect(error).toBeInstanceOf(TransportError);
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
    const error = await consumeFollow(runs, {
      maxReconnects: remaining,
      reconnectDelayMs: 0,
      signal: controller.signal,
    });
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
    const { runs, calls } = recordingClient(() => routeRequestVector(method));
    await callVectorMethod(runs, method, fields);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('missing recorded fetch');
    expect({
      method: call.init.method,
      path: call.url.pathname,
      headers: selectHeaders(call.init, modeled),
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
});
