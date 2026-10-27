import { describe, expect, it } from 'vitest';
import { parseSseFrame, readSseFrames, splitSseFrames } from '@indx-workspace/sdk/events';
import { ContractViolationError, createClient } from '@indx-workspace/sdk';
import {
  classifyEventName,
  classifyPlatformEventName,
  classifyStoredEventName,
} from '../server/runs/sse';
import { sseStreamResponse } from '../server/runs/sse';
import { readResumeCursor } from '../server/runs/cursor';
import { InMemoryRunStore } from '../server/runs/memory-store';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';

const vectors = loadVectors('adversarial-runs-stream', 'attacks.json');

function vector(id: string): { input: Record<string, unknown>; expected: Record<string, unknown> } {
  const found = vectors.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing ${id} vector`);
  return {
    input: asRecord(found.input, `${id} input`),
    expected: asRecord(found.expected, `${id} expected`),
  };
}

function byteStream(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${what} must be an array of strings`);
  }
  return value;
}

const RUN_ID = '33333333-3333-4333-8333-333333333333';

function runningRun(): Record<string, unknown> {
  return {
    id: RUN_ID,
    workspaceId: '44444444-4444-4444-8444-444444444444',
    agentId: '11111111-1111-4111-8111-111111111111',
    projectId: null,
    initiatingUserId: null,
    sessionId: '55555555-5555-4555-8555-555555555555',
    status: 'running',
    createdAt: '2026-09-21T10:00:00.000Z',
    startedAt: null,
    endedAt: null,
    durationMs: null,
    model: null,
    provider: null,
    modelConnectionId: null,
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
    accountingState: 'pending',
    accountingError: null,
  };
}

describe('adversarial run stream candidates', () => {
  it('rejects an injected runtime event name at the real append classifier', () => {
    const { input, expected } = vector('runtime-name-injection');
    expect(classifyEventName(asString(input['name'], 'name')).kind).toBe(expected['kind']);
    expect(classifyEventName('model.result\r\ndata: forged').kind).toBe('rejected');
  });

  it('rejects an invalid resume header without falling back to a valid query', () => {
    const { input, expected } = vector('invalid-header-no-query-fallback');
    const cursor = readResumeCursor(
      asString(input['header'], 'header'),
      asString(input['query'], 'query'),
    );
    expect(cursor.kind).toBe(expected['kind']);
    if (cursor.kind === 'invalid') expect(cursor.source).toBe(expected['source']);
  });

  it('keeps runtime, platform, and stored control names in separate channels', () => {
    const { input, expected } = vector('separate-event-name-channels');
    expect(classifyEventName(asString(input['runtimeControl'], 'runtimeControl')).kind).toBe(
      expected['runtimeControl'],
    );
    expect(classifyEventName('run.status').kind).toBe('reserved');
    expect(
      classifyPlatformEventName(asString(input['platformRuntime'], 'platformRuntime')).kind,
    ).toBe(expected['platformRuntime']);
    expect(classifyPlatformEventName('run.status').kind).toBe('ok');
    expect(classifyStoredEventName(asString(input['storedControl'], 'storedControl')).kind).toBe(
      expected['storedControl'],
    );
    const controls = strings(input['allControls'], 'allControls');
    expect(controls.map((name) => classifyEventName(name).kind)).toEqual(expected['allRuntime']);
    expect(controls.map((name) => classifyStoredEventName(name).kind)).toEqual(
      expected['allStored'],
    );
  });

  it('rejects a resume id above the durable event-id range', () => {
    const { input, expected } = vector('oversized-resume-id');
    const cursor = readResumeCursor(asString(input['header'], 'header'), null);
    expect(cursor.kind).toBe(expected['kind']);
    if (cursor.kind === 'invalid') expect(cursor.source).toBe(expected['source']);
    expect(readResumeCursor(asString(input['zeroPadded'], 'zeroPadded'), null).kind).toBe(
      expected['zeroPaddedKind'],
    );
  });

  it('joins SDK data lines before parsing their JSON payload', () => {
    const { input, expected } = vector('sdk-multiline-data');
    expect(parseSseFrame(asString(input['wire'], 'wire'))).toEqual({
      event: expected['event'],
      id: null,
      data: expected['data'],
    });
    expect(parseSseFrame(asString(input['threeLineWire'], 'threeLineWire'))?.data).toEqual(
      expected['threeLineData'],
    );
  });

  it('clears the real SDK resume cursor for an explicitly empty event id', async () => {
    const { input, expected } = vector('sdk-empty-id-reconnect');
    expect(parseSseFrame(asString(input['wire'], 'wire'))?.id).toBe(expected['id']);
    const seen: Request[] = [];
    const sdk = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_k' },
      fetch: (request, init) => {
        seen.push(new Request(request, init));
        const body =
          seen.length === 1
            ? 'event: run.status\nid:\ndata: {"status":"running","error":null}\n\n'
            : 'event: done\n\n';
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
      },
    });
    const received = [];
    for await (const frame of sdk.runs.follow(RUN_ID, { reconnectDelayMs: 0 })) {
      received.push(frame);
    }
    expect(received[0]?.kind).toBe('run-status');
    expect(seen).toHaveLength(2);
    expect(seen[1]?.headers.has('last-event-id')).toBe(false);
    expect(seen[1]?.headers.get('last-event-id')).toBe(expected['reconnectHeader']);
  });

  it('delivers a lone-CR frame through both the pure splitter and byte reader', async () => {
    const { input, expected } = vector('sdk-lone-cr');
    const wire = asString(input['wire'], 'wire');
    expect(splitSseFrames(wire)).toEqual(expected);
    const frames = [];
    for await (const frame of readSseFrames(byteStream('event: x\r', 'data: {}\r\r'))) {
      frames.push(frame);
    }
    expect(frames).toEqual([{ event: 'x', id: null, data: {} }]);
  });

  it('announces a reset on a first connection after earlier events were evicted', async () => {
    const { expected } = vector('truncated-first-connection-reset');
    const store = new InMemoryRunStore({ maxEventsPerRun: 1 });
    const id = crypto.randomUUID();
    await store.create({
      engine: 'claude-agent-sdk',
      id,
      workspaceId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    });
    for (const value of [1, 2, 3]) {
      await store.append(id, { type: 'assistant', data: { value } });
    }
    const handle = await store.openStream(id, null);
    if (handle === null) throw new Error('created run had no stream');
    expect(handle.reset?.resumedAfter).toBe(expected['resumedAfter']);
    const seen: bigint[] = [];
    for await (const event of handle.events) {
      seen.push(event.id);
      break;
    }
    expect(seen).toEqual([BigInt(Number(expected['oldest']))]);
    handle.close();
  });

  it('commits only the winning terminal status event', async () => {
    const { expected } = vector('interrupt-conclude-one-terminal-event');
    const store = new InMemoryRunStore();
    const id = crypto.randomUUID();
    await store.create({
      engine: 'claude-agent-sdk',
      id,
      workspaceId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    });
    await store.markRunning(id);
    await store.finish(id, 'cancelled', null, true);
    await store.finish(id, 'completed', null, true);
    expect((await store.get(id))?.status).toBe(expected['storedStatus']);
    const handle = await store.openStream(id, null);
    if (handle === null) throw new Error('created run had no stream');
    const statuses: string[] = [];
    for await (const event of handle.events) {
      statuses.push(asString(asRecord(event.data, 'terminal event')['status'], 'status'));
    }
    expect(statuses).toEqual(expected['terminalEvents']);
  });

  it('requests a reset when the cursor is ahead of the event tail', async () => {
    const { input, expected } = vector('ahead-cursor-reset');
    const store = new InMemoryRunStore();
    const id = crypto.randomUUID();
    await store.create({
      engine: 'claude-agent-sdk',
      id,
      workspaceId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    });
    await store.append(id, { type: 'assistant', data: { text: 'one' } });
    const handle = await store.openStream(id, BigInt(Number(input['after'])));
    if (handle === null) throw new Error('created run had no stream');
    expect(handle.reset?.reason).toContain(`no event after ${Number(input['after'])}`);
    expect(expected['reset']).toBe('ahead');
    expect(handle.reset).not.toBeNull();
    expect(handle.reset?.resumedAfter).toBe(expected['resumedAfter']);
    handle.close();

    const emptyId = crypto.randomUUID();
    await store.create({
      engine: 'claude-agent-sdk',
      id: emptyId,
      workspaceId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    });
    const empty = await store.openStream(emptyId, BigInt(Number(input['after'])));
    if (empty === null) throw new Error('created empty run had no stream');
    expect(empty.reset).not.toBeNull();
    expect(empty.reset?.resumedAfter).toBe(expected['emptyResumedAfter']);
    empty.close();
  });

  it('closes a finished run log against later status appends', async () => {
    const { expected } = vector('terminal-finish-closes-log');
    const store = new InMemoryRunStore();
    const id = crypto.randomUUID();
    await store.create({
      engine: 'claude-agent-sdk',
      id,
      workspaceId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    });
    await store.markRunning(id);
    await store.finish(id, 'completed', null);
    expect((await store.get(id))?.status).toBe(expected['status']);
    const appended = await store.appendPlatformEvent(id, {
      type: 'run.status',
      data: { status: 'failed' },
    });
    expect(appended.kind === 'rejected').toBe(expected['appendRejected']);

    const queuedId = crypto.randomUUID();
    await store.create({
      engine: 'claude-agent-sdk',
      id: queuedId,
      workspaceId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    });
    await store.finish(queuedId, 'completed', null);
    expect((await store.get(queuedId))?.status).toBe(expected['queuedStatus']);
    const queuedAppend = await store.appendPlatformEvent(queuedId, {
      type: 'run.status',
      data: { status: 'failed' },
    });
    expect(queuedAppend.kind === 'rejected').toBe(expected['queuedAppendRejected']);
  });

  it('emits unknown failure then done for an indeterminate stream, while SDK wait rejects a live run', async () => {
    const { input, expected } = vector('indeterminate-unknown-then-done');
    const response = (): Response =>
      sseStreamResponse({
        source: (async function* () {})(),
        outcome: () =>
          Promise.resolve({ kind: 'indeterminate', reason: asString(input['reason'], 'reason') }),
        signal: new AbortController().signal,
      });
    const wire = await response().text();
    const frames = splitSseFrames(wire)
      .frames.map((raw) => parseSseFrame(raw))
      .filter((frame) => frame !== null);
    expect(frames.map((frame) => frame.event)).toEqual(expected['frames']);
    expect(asRecord(frames[0]?.data, 'run-failed data')['status']).toBe(expected['failureStatus']);
    const sdk = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_k' },
      fetch: (request, init) => {
        const path = new URL(new Request(request, init).url).pathname;
        return Promise.resolve(
          path.endsWith('/events') ? response() : Response.json({ run: runningRun() }),
        );
      },
    });
    const failure = await sdk.runs.waitForOutcome(RUN_ID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect(expected['waitError']).toBe('contract-violation');
  });
});
