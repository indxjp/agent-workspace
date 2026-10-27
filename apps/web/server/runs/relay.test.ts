import { log as webLogger } from '../telemetry/logger';
import { describe, expect, it, vi } from 'vitest';

import {
  classifyRunnerResponse,
  parseSseStream,
  relayRunnerStream,
  SseLineSplitter,
  SseMessageAssembler,
  type SseMessage,
} from './relay';
import { InMemoryRunStore } from './memory-store';

const RUN = '11111111-1111-4111-8111-111111111111';
const NUL = String.fromCharCode(0);
/** One frame whose data is not JSON. Built here so no test body needs a multi-line literal. */
const BAD_FRAME = ['event: assistant', 'data: not json', '', ''].join('\n');

function bodyOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sseResponse(chunks: readonly string[]): Response {
  return new Response(bodyOf(chunks), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

async function collect(chunks: readonly string[]): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const message of parseSseStream(bodyOf(chunks))) out.push(message);
  return out;
}

async function newRun(store: InMemoryRunStore): Promise<void> {
  await store.create({
    engine: 'claude-agent-sdk',
    id: RUN,
    workspaceId: '22222222-2222-4222-8222-222222222222',
    agentId: '33333333-3333-4333-8333-333333333333',
    sessionId: '44444444-4444-4444-8444-444444444444',
  });
}

describe('SseLineSplitter', () => {
  it('splits on LF, CR and CRLF', () => {
    expect(new SseLineSplitter().push('a\nb\rc\r\nd\n')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('holds an unterminated final line back', () => {
    const splitter = new SseLineSplitter();
    expect(splitter.push('a\nb')).toEqual(['a']);
    expect(splitter.rest()).toBe('b');
    expect(splitter.push('c\n')).toEqual(['bc']);
  });

  it('does not turn a CRLF straddling two chunks into two line breaks', () => {
    const splitter = new SseLineSplitter();
    expect(splitter.push('a\r')).toEqual(['a']);
    expect(splitter.push('\nb\n')).toEqual(['b']);
  });

  it('treats a CR followed by a real line as one break each', () => {
    const splitter = new SseLineSplitter();
    expect(splitter.push('a\r')).toEqual(['a']);
    expect(splitter.push('b\n')).toEqual(['b']);
  });
});

describe('SseMessageAssembler', () => {
  it('strips exactly one space after the colon', () => {
    const a = new SseMessageAssembler();
    a.line('data:  two spaces');
    expect(a.line('')?.data).toBe(' two spaces');
  });

  it('joins multiple data lines with a newline', () => {
    const a = new SseMessageAssembler();
    a.line('data: one');
    a.line('data: two');
    expect(a.line('')?.data).toBe('one\ntwo');
  });

  it('dispatches nothing for a frame with no data, and ignores comments', () => {
    const a = new SseMessageAssembler();
    a.line(': keepalive');
    expect(a.line('')).toBeNull();
    a.line('event: assistant');
    expect(a.line('')).toBeNull();
  });

  it('carries the last id forward across frames and ignores one containing NUL', () => {
    const a = new SseMessageAssembler();
    a.line('id: 7');
    a.line('data: x');
    expect(a.line('')?.lastEventId).toBe('7');
    a.line(`id: 8${NUL}`);
    a.line('data: y');
    expect(a.line('')?.lastEventId).toBe('7');
  });

  it('treats a line with no colon as a field with an empty value', () => {
    const a = new SseMessageAssembler();
    a.line('data');
    expect(a.line('')?.data).toBe('');
  });

  it('ignores an unknown field and a retry field rather than treating them as data', () => {
    const a = new SseMessageAssembler();
    a.line('retry: 1000');
    a.line('nonsense: 4');
    a.line('data: x');
    const message = a.line('');
    expect(message?.data).toBe('x');
    expect(message?.event).toBeNull();
  });

  it('resets the event name after each dispatch', () => {
    const a = new SseMessageAssembler();
    a.line('event: assistant');
    a.line('data: 1');
    expect(a.line('')?.event).toBe('assistant');
    a.line('data: 2');
    expect(a.line('')?.event).toBeNull();
  });
});

describe('parseSseStream', () => {
  it('reassembles frames split arbitrarily across chunks', async () => {
    const messages = await collect(['event: assi', 'stant\nda', 'ta: {"a":1}\n', '\n']);
    expect(messages).toEqual([{ event: 'assistant', data: '{"a":1}', lastEventId: '' }]);
  });

  it('reassembles a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('event: a\ndata: "é"\n\n');
    const encoder = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split inside the two-byte é.
        controller.enqueue(bytes.slice(0, 17));
        controller.enqueue(bytes.slice(17));
        controller.close();
      },
    });
    const out: SseMessage[] = [];
    for await (const message of parseSseStream(encoder)) out.push(message);
    expect(out[0]?.data).toBe('"é"');
  });

  it('discards a final frame that end-of-stream cut short, as HTML §9.2 requires', async () => {
    expect(await collect(['event: a\ndata: 1\n\nevent: b\ndata: 2\n'])).toHaveLength(1);
  });
});

describe('classifyRunnerResponse', () => {
  it('accepts a 200 text/event-stream with a body', () => {
    expect(classifyRunnerResponse(sseResponse(['\n'])).kind).toBe('ok');
  });

  it('rejects a non-200 by name rather than opening a stream over an error page', () => {
    const verdict = classifyRunnerResponse(new Response('nope', { status: 502 }));
    expect(verdict.kind).toBe('rejected');
    if (verdict.kind !== 'rejected') return;
    expect(verdict.reason).toContain('502');
  });

  it('rejects a missing Content-Type and a wrong one', () => {
    const bare = new Response(bodyOf(['x']), { status: 200 });
    bare.headers.delete('content-type');
    expect(classifyRunnerResponse(bare).kind).toBe('rejected');
    const html = new Response(bodyOf(['x']), {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    expect(classifyRunnerResponse(html).kind).toBe('rejected');
  });

  it('accepts the MIME type regardless of case and parameters', () => {
    const response = new Response(bodyOf(['x']), {
      status: 200,
      headers: { 'Content-Type': 'Text/Event-Stream; charset=UTF-8' },
    });
    expect(classifyRunnerResponse(response).kind).toBe('ok');
  });
});

describe('relayRunnerStream', () => {
  it('records a session identity only when the runner terminal frame reports one', async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    const seen: string[] = [];

    const outcome = await relayRunnerStream(
      RUN,
      sseResponse([
        'event: system\ndata: {"subtype":"init","session_id":"sdk-session"}\n\n',
        'event: run-done\ndata: {"sessionId":"sdk-session"}\n\n',
      ]),
      store,
      (sessionId) => {
        seen.push(sessionId);
        return Promise.resolve();
      },
    );

    expect(outcome).toEqual({ kind: 'completed', events: 1, output: null });
    expect(seen).toEqual(['sdk-session']);
  });

  it('writes every named frame into the store and reports how many', async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    const outcome = await relayRunnerStream(
      RUN,
      sseResponse([
        'event: system\ndata: {"subtype":"init"}\n\n',
        ': keepalive\n\n',
        'event: assistant\ndata: {"text":"hi"}\n\n',
        'event: run-done\ndata: {}\n\n',
      ]),
      store,
    );
    expect(outcome).toEqual({ kind: 'completed', events: 2, output: null });
    const handle = await store.openStream(RUN, null);
    if (handle === null) throw new Error('no handle');
    await store.finish(RUN, 'completed', null);
    const seen: string[] = [];
    for await (const event of handle.events) seen.push(event.type);
    expect(seen).toEqual(['system', 'assistant']);
  });

  describe('the run output (ADR-0143)', () => {
    const message = (text: string): string =>
      `event: agent.message\ndata: ${JSON.stringify({ role: 'assistant', blocks: [{ type: 'text', text }] })}\n\n`;
    const result = (output: unknown): string =>
      `event: agent.result\ndata: ${JSON.stringify({ stopReason: 'end_turn', output })}\n\n`;
    const relay = async (frames: readonly string[]): Promise<unknown> => {
      const store = new InMemoryRunStore();
      await newRun(store);
      return relayRunnerStream(
        RUN,
        sseResponse([...frames, 'event: run-done\ndata: {}\n\n']),
        store,
      );
    };

    it('returns the output the engine put on its agent.result frame', async () => {
      const output = { text: '{"a":1}', structured: { a: 1 } };
      expect(await relay([message('thinking'), result(output)])).toEqual({
        kind: 'completed',
        events: 2,
        output,
      });
    });

    it('falls back to the last assistant message text, with no structured value', async () => {
      expect(await relay([message('first'), message('final answer')])).toEqual({
        kind: 'completed',
        events: 2,
        output: { text: 'final answer', structured: null },
      });
    });

    it('ignores user messages and an agent.result with no usable output', async () => {
      const user = `event: agent.message\ndata: ${JSON.stringify({ role: 'user', blocks: [{ type: 'text', text: 'hi' }] })}\n\n`;
      expect(await relay([user, result('not an output')])).toEqual({
        kind: 'completed',
        events: 2,
        output: null,
      });
    });
  });

  it('fails when the connection closes cleanly without an explicit terminal frame', async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    const outcome = await relayRunnerStream(
      RUN,
      sseResponse(['event: assistant\ndata: {"text":"truncated"}\n\n']),
      store,
    );

    expect(outcome).toEqual({
      kind: 'failed',
      reason:
        'the runtime SSE stream ended without a terminal run-done, run-error, or run-interrupted frame',
      events: 1,
    });
  });

  it('fails the run rather than skipping a frame whose data is not JSON', async () => {
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    await newRun(store);
    const outcome = await relayRunnerStream(
      RUN,
      sseResponse(['event: assistant\ndata: not json\n\n']),
      store,
    );
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toContain('invalid event');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('fails the run rather than inventing a name for an unnamed frame', async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    const outcome = await relayRunnerStream(RUN, sseResponse(['data: {"a":1}\n\n']), store);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toContain('no `event:` name');
  });

  it('fails the run when the runtime tries to forge a reserved control frame', async () => {
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    await newRun(store);
    const outcome = await relayRunnerStream(RUN, sseResponse(['event: done\ndata: {}\n\n']), store);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toBe('Run output could not be saved.');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('reports a rejected response without touching the store', async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    const outcome = await relayRunnerStream(RUN, new Response('', { status: 500 }), store);
    expect(outcome.kind).toBe('failed');
    expect(outcome.events).toBe(0);
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toContain('500');
  });

  it('cancels the runtime connection when it stops early, instead of leaving it open', async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // A malformed frame, then more that will never be read.
        controller.enqueue(encoder.encode(BAD_FRAME));
      },
      cancel() {
        cancelled = true;
      },
    });
    const outcome = await relayRunnerStream(
      RUN,
      new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      store,
    );
    expect(outcome.kind).toBe('failed');
    expect(cancelled).toBe(true);
  });

  it("reads the runner's own terminal frame as the outcome, and does not relay it", async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    const outcome = await relayRunnerStream(
      RUN,
      sseResponse([
        'event: system\ndata: {"subtype":"init"}\n\n',
        'event: run-done\ndata: {"runId":"' + RUN + '","events":1}\n\n',
      ]),
      store,
    );
    expect(outcome).toEqual({ kind: 'completed', events: 1, output: null });
    const handle = await store.openStream(RUN, null);
    if (handle === null) throw new Error('no handle');
    await store.finish(RUN, 'completed', null);
    const seen: string[] = [];
    for await (const event of handle.events) seen.push(event.type);
    // `run-done` is not among them: it is the runner's own connection metadata, read here and
    // consumed, not a second opinion appended to the transcript beside the platform's own
    // `run.status`.
    expect(seen).toEqual(['system']);
  });

  it("fails the run with the runner's own message on `run-error`", async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    const outcome = await relayRunnerStream(
      RUN,
      sseResponse(['event: run-error\ndata: {"message":"Not logged in · Please run /login"}\n\n']),
      store,
    );
    expect(outcome).toEqual({
      kind: 'failed',
      reason: 'Not logged in · Please run /login',
      events: 0,
    });
  });

  it('reports a run-error that stopped for approval as awaiting_approval, with the call (ADR-0145)', async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    const data = {
      code: 'awaiting_approval',
      outcome: 'awaiting_approval',
      message: 'stopped for approval',
      approvalRequest: { toolName: 'send_email', toolUseId: 'toolu_1', canonicalCall: '{}' },
    };
    const outcome = await relayRunnerStream(
      RUN,
      sseResponse([`event: run-error\ndata: ${JSON.stringify(data)}\n\n`]),
      store,
    );
    expect(outcome).toEqual({
      kind: 'awaiting_approval',
      call: { toolName: 'send_email', canonicalCall: '{}' },
      toolCallId: 'toolu_1',
      events: 0,
    });
  });

  it('fails a run that claims to await approval without a usable request', async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    const data = { code: 'awaiting_approval', approvalRequest: { toolName: 'send_email' } };
    const outcome = await relayRunnerStream(
      RUN,
      sseResponse([`event: run-error\ndata: ${JSON.stringify(data)}\n\n`]),
      store,
    );
    expect(outcome.kind).toBe('failed');
  });

  it('falls back to a named reason when `run-error` carries no message', async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    const outcome = await relayRunnerStream(
      RUN,
      sseResponse(['event: run-error\ndata: {"runId":"' + RUN + '"}\n\n']),
      store,
    );
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toContain('no message');
  });

  it('cancels the run on `run-interrupted`, distinctly from `run-error` (issue #235)', async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    const outcome = await relayRunnerStream(
      RUN,
      sseResponse(['event: run-interrupted\ndata: {"interrupted":true}\n\n']),
      store,
    );
    // Not `failed`: a run-interrupted frame means a user or the platform stopped the run on
    // purpose, which `packages/core/src/db/schema/runs.ts`'s own comment on `cancelled` says is
    // not an error.
    expect(outcome.kind).toBe('cancelled');
    if (outcome.kind !== 'cancelled') return;
    expect(outcome.reason).toContain('interrupted');
  });

  it('reports the runner’s own message on `run-interrupted` when it sent one', async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    const outcome = await relayRunnerStream(
      RUN,
      sseResponse(['event: run-interrupted\ndata: {"message":"stopped by operator"}\n\n']),
      store,
    );
    expect(outcome).toEqual({ kind: 'cancelled', reason: 'stopped by operator', events: 0 });
  });

  it("still refuses a forged `done` or `run-failed` — the runner's own names moved, the reservation did not", async () => {
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    await newRun(store);
    for (const forged of ['done', 'run-failed']) {
      const outcome = await relayRunnerStream(
        RUN,
        sseResponse([`event: ${forged}\ndata: {}\n\n`]),
        store,
      );
      expect(outcome.kind).toBe('failed');
      if (outcome.kind !== 'failed') continue;
      expect(outcome.reason).toBe('Run output could not be saved.');
    }
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('reports how many events survived when the stream breaks mid-run', async () => {
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    await newRun(store);
    const encoder = new TextEncoder();
    let pulls = 0;
    // Pull-based, so the first frame is genuinely delivered before the connection breaks. An
    // `error()` issued in the same tick as `enqueue()` discards the queued chunk instead.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(encoder.encode('event: assistant\ndata: 1\n\n'));
        else controller.error(new Error('connection reset by peer SECRET_SENTINEL'));
      },
    });
    const outcome = await relayRunnerStream(
      RUN,
      new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      store,
    );
    expect(outcome).toEqual({
      kind: 'failed',
      reason: 'The runtime stream ended unexpectedly.',
      events: 1,
    });
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).not.toContain('SECRET_SENTINEL');
    const loggedFailure = log.mock.calls[0]?.[1] as { error: Error } | undefined;
    expect(loggedFailure?.error.cause).toEqual(
      new Error('connection reset by peer SECRET_SENTINEL'),
    );
    log.mockRestore();
  });
});

describe('the platform lifecycle event name is not forgeable by a runtime', () => {
  it('refuses a relayed frame named run.status', async () => {
    const store = new InMemoryRunStore();
    await newRun(store);
    const outcome = await relayRunnerStream(
      RUN,
      sseResponse(['event: run.status\ndata: {"status":"completed"}\n\n']),
      store,
    );
    expect(outcome.kind).toBe('failed');
    const handle = await store.openStream(RUN, null);
    handle?.close();
    expect(handle?.reset).toBeNull();
    expect((await store.get(RUN))?.status).toBe('queued');
  });
});
