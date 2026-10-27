import { describe, expect, it } from 'vitest';

import { classifyRunOutcome } from '../server/runs/api';
import { readResumeCursor } from '../server/runs/cursor';
import {
  classifyRunnerResponse,
  relayRunnerStream,
  SseLineSplitter,
  SseMessageAssembler,
} from '../server/runs/relay';
import {
  classifyEventName,
  classifyPlatformEventName,
  classifyStoredEventName,
  CONTROL_FRAME_NAMES,
  RESERVED_EVENT_NAMES,
  SSE_HEADERS,
  sseComment,
  sseControlFrame,
  sseFrame,
  sseRetryFrame,
  sseStreamResponse,
} from '../server/runs/sse';
import { InMemoryRunStore } from '../server/runs/memory-store';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';

const FAMILY = 'events-sse';

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`${label}: expected an array of strings`);
  }
  return value;
}

function verdict(value: { readonly kind: string; readonly name?: string }): Record<string, string> {
  return value.kind === 'ok' || value.kind === 'reserved'
    ? { kind: value.kind, name: value.name ?? '' }
    : { kind: value.kind };
}

describe('Lean server SSE vectors', () => {
  it('pins the server vocabulary and headers', () => {
    const vectors = loadVectors(FAMILY, 'vocabulary.json');
    const server = vectors.find((v) => v.id === 'server-names');
    const headers = vectors.find((v) => v.id === 'headers');
    if (server === undefined || headers === undefined) throw new Error('missing server vectors');
    const expected = asRecord(server.expected, server.id);
    expect(CONTROL_FRAME_NAMES).toEqual(expected['control']);
    expect(RESERVED_EVENT_NAMES).toEqual(expected['reserved']);
    expect(SSE_HEADERS).toEqual(headers.expected);
  });

  it.each(loadVectors(FAMILY, 'names.json').map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const name = asString(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    expect(verdict(classifyEventName(name))).toEqual(expected['relay']);
    expect(verdict(classifyPlatformEventName(name))).toEqual(expected['platform']);
    expect(verdict(classifyStoredEventName(name))).toEqual(expected['stored']);
  });

  it.each(loadVectors(FAMILY, 'cursor.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, vector) => {
      const input = asRecord(vector.input, vector.id);
      const cursor = readResumeCursor(
        input['header'] === null ? null : asString(input['header'], 'header'),
        input['query'] === null ? null : asString(input['query'], 'query'),
      );
      const actual =
        cursor.kind === 'after'
          ? { kind: 'after', id: String(cursor.id), source: cursor.source }
          : cursor.kind === 'invalid'
            ? { kind: 'invalid', source: cursor.source }
            : { kind: 'absent' };
      expect(actual).toEqual(vector.expected);
    },
  );

  it.each(loadVectors(FAMILY, 'frames.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, vector) => {
      const input = asRecord(vector.input, vector.id);
      const expected = asRecord(vector.expected, vector.id);
      expect(
        sseFrame({
          id: BigInt(asString(String(input['id']), 'id')),
          type: asString(input['name'], 'name'),
          data: input['data'],
        }),
      ).toBe(expected['frame']);
    },
  );

  it.each(loadVectors(FAMILY, 'control.json').map((v) => [v.id, v] as const))(
    'renders %s',
    (_id, vector) => {
      const input = asRecord(vector.input, vector.id);
      const kind = input['kind'];
      let actual: string;
      if (kind === 'control') {
        const name = input['name'];
        if (name !== 'done' && name !== 'run-failed') throw new Error('unexpected control name');
        actual = sseControlFrame({ name, data: input['data'] });
      } else if (kind === 'retry') {
        const ms = input['ms'];
        if (typeof ms !== 'number') throw new Error('expected retry number');
        actual = sseRetryFrame(ms);
      } else if (kind === 'comment') {
        actual = sseComment(asString(input['text'], 'text'));
      } else throw new Error('unexpected frame kind');
      expect(actual).toBe(vector.expected);
    },
  );

  it.each(loadVectors(FAMILY, 'relay-lines.json').map((v) => [v.id, v] as const))(
    'splits relay lines: %s',
    (_id, vector) => {
      const splitter = new SseLineSplitter();
      const lines: string[] = [];
      for (const chunk of stringArray(vector.input, vector.id)) lines.push(...splitter.push(chunk));
      expect({ lines, rest: splitter.rest() }).toEqual(vector.expected);
    },
  );

  it.each(loadVectors(FAMILY, 'relay-messages.json').map((v) => [v.id, v] as const))(
    'assembles relay messages: %s',
    (_id, vector) => {
      const assembler = new SseMessageAssembler();
      const messages = [];
      let lastEventId = '';
      for (const line of stringArray(vector.input, vector.id)) {
        const message = assembler.line(line);
        if (message !== null) {
          messages.push(message);
          lastEventId = message.lastEventId;
        }
      }
      const expected = asRecord(vector.expected, vector.id);
      expect(messages).toEqual(expected['messages']);
      expect(lastEventId).toBe(expected['lastEventId']);
    },
  );
});

describe('the real in-memory run event stream', () => {
  it.each(loadVectors(FAMILY, 'log.json').map((v) => [v.id, v] as const))(
    'replays log vector %s',
    async (_id, vector) => {
      const input = asRecord(vector.input, vector.id);
      const expected = asRecord(vector.expected, vector.id);
      const limit = input['limit'];
      if (typeof limit !== 'number') throw new Error('expected retention limit');
      const names = stringArray(input['names'], vector.id);
      const store = new InMemoryRunStore({ maxEventsPerRun: limit });
      const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      await store.create({
        engine: 'claude-agent-sdk',
        id: runId,
        workspaceId: '22222222-2222-4222-8222-222222222222',
        agentId: '33333333-3333-4333-8333-333333333333',
        sessionId: '44444444-4444-4444-8444-444444444444',
      });
      const ids: number[] = [];
      for (const name of names) {
        const appended = await store.append(runId, { type: name, data: null });
        if (appended.kind !== 'appended') throw new Error(`append failed: ${appended.reason}`);
        ids.push(Number(appended.event.id));
      }
      expect(ids).toEqual(expected['ids']);
      await store.finish(runId, 'completed', null);
      const afterValue = input['after'];
      if (afterValue !== null && typeof afterValue !== 'number') throw new Error('bad cursor');
      const stream = await store.openStream(runId, afterValue === null ? null : BigInt(afterValue));
      if (stream === null) throw new Error('run stream was not opened');
      const resumedAfter = stream.reset?.resumedAfter ?? null;
      const resetExpected = expected['reset'];
      if (resetExpected === null) expect(stream.reset).toBeNull();
      else expect(resumedAfter).toBe(asRecord(resetExpected, vector.id)['resumedAfter']);
      const retained: number[] = [];
      for await (const event of stream.events) retained.push(Number(event.id));
      expect(retained).toEqual(expected['retained']);
      const late = await store.append(runId, { type: 'system', data: null });
      expect(late.kind === 'rejected').toBe(expected['closedAppendRefused']);
    },
  );

  it('allocates contiguous ids, resets behind retention, and drains before ending', async () => {
    const store = new InMemoryRunStore({ maxEventsPerRun: 2 });
    const runId = '11111111-1111-4111-8111-111111111111';
    await store.create({
      engine: 'claude-agent-sdk',
      id: runId,
      workspaceId: '22222222-2222-4222-8222-222222222222',
      agentId: '33333333-3333-4333-8333-333333333333',
      sessionId: '44444444-4444-4444-8444-444444444444',
    });
    for (let i = 1; i <= 3; i += 1) {
      const result = await store.append(runId, { type: 'system', data: { kind: String(i) } });
      expect(result.kind).toBe('appended');
      if (result.kind === 'appended') expect(result.event.id).toBe(BigInt(i));
    }
    await store.finish(runId, 'completed', null);
    const stream = await store.openStream(runId, 0n);
    if (stream === null) throw new Error('run stream was not opened');
    expect(stream.reset?.resumedAfter).toBe('1');
    const ids: bigint[] = [];
    for await (const event of stream.events) ids.push(event.id);
    expect(ids).toEqual([2n, 3n]);
    const late = await store.append(runId, { type: 'system', data: { kind: 'late' } });
    expect(late.kind).toBe('rejected');
  });

  it('first connection to a truncated log announces a reset', async () => {
    const store = new InMemoryRunStore({ maxEventsPerRun: 1 });
    const runId = '55555555-5555-4555-8555-555555555555';
    await store.create({
      engine: 'claude-agent-sdk',
      id: runId,
      workspaceId: '22222222-2222-4222-8222-222222222222',
      agentId: '33333333-3333-4333-8333-333333333333',
      sessionId: '44444444-4444-4444-8444-444444444444',
    });
    await store.append(runId, { type: 'system', data: { kind: 'one' } });
    await store.append(runId, { type: 'system', data: { kind: 'two' } });
    await store.finish(runId, 'completed', null);
    const stream = await store.openStream(runId, null);
    if (stream === null) throw new Error('run stream was not opened');
    expect(stream.reset?.resumedAfter).toBe('1');
    const ids: bigint[] = [];
    for await (const event of stream.events) ids.push(event.id);
    expect(ids).toEqual([2n]);
  });
});

describe('the real inbound runner relay', () => {
  const runId = '99999999-9999-4999-8999-999999999999';
  const sse = (body: string): Response =>
    new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    });

  async function storeForRelay(): Promise<InMemoryRunStore> {
    const store = new InMemoryRunStore();
    await store.create({
      engine: 'claude-agent-sdk',
      id: runId,
      workspaceId: '22222222-2222-4222-8222-222222222222',
      agentId: '33333333-3333-4333-8333-333333333333',
      sessionId: '44444444-4444-4444-8444-444444444444',
    });
    return store;
  }

  it('requires a 200 SSE response with a body', () => {
    expect(classifyRunnerResponse(new Response('bad', { status: 500 })).kind).toBe('rejected');
    expect(classifyRunnerResponse(new Response('bad', { status: 200 })).kind).toBe('rejected');
    expect(
      classifyRunnerResponse(
        new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ).kind,
    ).toBe('rejected');
    expect(classifyRunnerResponse(sse('event: run-done\ndata: {}\n\n')).kind).toBe('ok');
  });

  it('stores SDK events, consumes a terminal frame, and reports its session', async () => {
    const store = await storeForRelay();
    const sessions: string[] = [];
    const outcome = await relayRunnerStream(
      runId,
      sse(
        'event: system\ndata: {"kind":"start"}\n\n' +
          'event: run-done\ndata: {"sessionId":"session-new"}\n\n',
      ),
      store,
      (id) => {
        sessions.push(id);
        return Promise.resolve();
      },
    );
    expect(outcome).toEqual({ kind: 'completed', events: 1, output: null });
    expect(sessions).toEqual(['session-new']);
    await store.finish(runId, 'completed', null);
    const stream = await store.openStream(runId, null);
    if (stream === null) throw new Error('run stream was not opened');
    const types: string[] = [];
    const kinds: unknown[] = [];
    for await (const event of stream.events) {
      types.push(event.type);
      kinds.push(event.data);
    }
    expect(types).toEqual(['system']);
    expect(kinds).toEqual([{ kind: 'start' }]);
  });

  it.each([
    ['bad JSON', 'event: system\ndata: {bad}\n\n', 0],
    ['unnamed', 'data: {"kind":"x"}\n\n', 0],
    ['reserved name', 'event: done\ndata: {}\n\n', 0],
    ['missing terminal', 'event: system\ndata: {"kind":"x"}\n\n', 1],
  ] as const)('rejects %s', async (_name, body, count) => {
    const store = await storeForRelay();
    const outcome = await relayRunnerStream(runId, sse(body), store);
    expect(outcome.kind).toBe('failed');
    expect(outcome.events).toBe(count);
  });

  it.each([
    ['run-error', 'failed', 'bad run'],
    ['run-interrupted', 'cancelled', 'stopped'],
  ] as const)('consumes %s as %s', async (name, kind, reason) => {
    const store = await storeForRelay();
    const outcome = await relayRunnerStream(
      runId,
      sse(`event: ${name}\ndata: {"message":"${reason}"}\n\n`),
      store,
    );
    expect(outcome).toEqual({ kind, reason, events: 0 });
  });
});

describe('the real outbound SSE response', () => {
  it.each(loadVectors(FAMILY, 'outcome-frames.json').map((v) => [v.id, v] as const))(
    'renders terminal frames for %s',
    async (_id, vector) => {
      const kind = asString(vector.input, vector.id);
      const outcomes = {
        succeeded: { kind: 'succeeded' as const },
        paused: { kind: 'paused' as const },
        failed: { kind: 'failed' as const, status: 'failed', message: 'safe' },
      };
      const outcome = Object.hasOwn(outcomes, kind)
        ? outcomes[kind as keyof typeof outcomes]
        : { kind: 'indeterminate' as const, reason: 'lost' };
      const response = sseStreamResponse({
        source: {
          [Symbol.asyncIterator]() {
            return { next: () => Promise.resolve({ done: true as const, value: undefined }) };
          },
        },
        outcome: () => Promise.resolve(outcome),
        signal: new AbortController().signal,
      });
      expect(await response.text()).toBe(
        'retry: 3000\n\n' + stringArray(vector.expected, vector.id).join(''),
      );
    },
  );

  it.each(loadVectors(FAMILY, 'outcomes.json').map((v) => [v.id, v] as const))(
    'classifies run outcome %s',
    async (_id, vector) => {
      const input = asRecord(vector.input, vector.id);
      const runId = '99999999-9999-4999-8999-999999999999';
      const store = new InMemoryRunStore();
      let run: Awaited<ReturnType<InMemoryRunStore['get']>> = null;
      if (input['status'] !== null) {
        await store.create({
          engine: 'claude-agent-sdk',
          id: runId,
          workspaceId: '22222222-2222-4222-8222-222222222222',
          agentId: '33333333-3333-4333-8333-333333333333',
          sessionId: '44444444-4444-4444-8444-444444444444',
        });
        const status = input['status'];
        if (status === 'running' || status === 'awaiting_approval') await store.markRunning(runId);
        if (status === 'awaiting_approval') {
          await store.awaitApproval(runId, { toolName: 'Bash', canonicalCall: 'Bash(ls)' });
        } else if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          const error = input['error'];
          if (error !== null && typeof error !== 'string') throw new Error('bad error');
          await store.finish(runId, status, error);
        } else if (status !== 'queued' && status !== 'running') throw new Error('bad run status');
        run = await store.get(runId);
      }
      expect(classifyRunOutcome(run, runId)).toEqual(vector.expected);
    },
  );

  it('puts a durable event before failure and done, with one teardown', async () => {
    let teardowns = 0;
    const response = sseStreamResponse({
      source: (async function* () {
        await Promise.resolve();
        yield { id: 7n, type: 'system', data: { kind: 'text' } };
      })(),
      outcome: () => Promise.resolve({ kind: 'failed', status: 'failed', message: 'safe' }),
      signal: new AbortController().signal,
      onTeardown: () => {
        teardowns += 1;
      },
    });
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      'cache-control': 'no-cache, no-transform',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    const body = await response.text();
    expect(body).toBe(
      'retry: 3000\n\n' +
        'event: system\nid: 7\ndata: {"kind":"text"}\n\n' +
        'event: run-failed\ndata: {"status":"failed","message":"safe"}\n\n' +
        'event: done\ndata: {}\n\n',
    );
    expect(teardowns).toBe(1);
  });

  it('reports a producer throw without a done frame', async () => {
    const response = sseStreamResponse({
      source: (async function* () {
        await Promise.resolve();
        yield { id: 7n, type: 'system', data: { kind: 'text' } };
        throw new Error('private cause');
      })(),
      outcome: () => Promise.resolve({ kind: 'succeeded' as const }),
      signal: new AbortController().signal,
    });
    const body = await response.text();
    expect(body).toContain('event: run-failed\n');
    expect(body).not.toContain('event: done\n');
    expect(body).not.toContain('private cause');
  });
});
