import { describe, expect, it, vi } from 'vitest';

import {
  classifyEventName,
  classifyPlatformEventName,
  CONTROL_FRAME_NAMES,
  DEFAULT_KEEPALIVE_MS,
  MAX_EVENT_ID,
  PLATFORM_EVENT_NAMES,
  renderEventData,
  RESERVED_EVENT_NAMES,
  RUN_STATUS_EVENT,
  sseComment,
  sseControlFrame,
  sseFrame,
  sseRetryFrame,
  sseStreamResponse,
  SSE_HEADERS,
  type SseEvent,
  type StreamOutcome,
} from './sse';

const NUL = String.fromCharCode(0);

/** Drain a Response body to text. */
async function drain(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) throw new Error('no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

/** An async source of exactly these events. Not an async generator: the repository lints with
 *  `require-await`, and a generator that only yields has nothing to await. */
function source(...events: readonly SseEvent[]): AsyncIterable<SseEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SseEvent> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<SseEvent>> {
          const event = events[index];
          index += 1;
          return Promise.resolve(
            event === undefined ? { value: undefined, done: true } : { value: event, done: false },
          );
        },
      };
    },
  };
}

/** A source that delivers `events` and then fails, the way a broken runtime relay does. */
function sourceThenThrow(error: Error, ...events: readonly SseEvent[]): AsyncIterable<SseEvent> {
  const inner = source(...events)[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator](): AsyncIterator<SseEvent> {
      return {
        async next(): Promise<IteratorResult<SseEvent>> {
          const result = await inner.next();
          if (result.done === true) throw error;
          return result;
        },
      };
    },
  };
}

/** Deliver `events`, then block forever: the stream is only ever ended from outside. */
function sourceThenNeverEnd(
  onBlock: () => void,
  ...events: readonly SseEvent[]
): AsyncIterable<SseEvent> {
  const inner = source(...events)[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator](): AsyncIterator<SseEvent> {
      return {
        async next(): Promise<IteratorResult<SseEvent>> {
          const result = await inner.next();
          if (result.done !== true) return result;
          onBlock();
          return new Promise<IteratorResult<SseEvent>>(() => undefined);
        },
      };
    },
  };
}

/** A source that never produces anything and never ends: a run that is simply thinking. */
function silentSource(onSubscribe?: () => void): AsyncIterable<SseEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SseEvent> {
      return {
        next(): Promise<IteratorResult<SseEvent>> {
          onSubscribe?.();
          return new Promise<IteratorResult<SseEvent>>(() => undefined);
        },
      };
    },
  };
}

describe('SSE_HEADERS', () => {
  it('is exactly the three headers R-13 ships, and nothing an earlier draft carried', () => {
    expect(Object.keys(SSE_HEADERS).sort()).toEqual([
      'Cache-Control',
      'Content-Type',
      'X-Accel-Buffering',
    ]);
    expect(SSE_HEADERS['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(SSE_HEADERS['Cache-Control']).toBe('no-cache, no-transform');
    expect(SSE_HEADERS['X-Accel-Buffering']).toBe('no');
    // R-13 fact-check round 1 removed all three of these. A regression that adds one back is a
    // silent claim this repository cannot support.
    for (const forbidden of ['Content-Encoding', 'Connection', 'X-Content-Type-Options']) {
      expect(Object.keys(SSE_HEADERS)).not.toContain(forbidden);
    }
  });
});

describe('classifyEventName', () => {
  it('accepts an ordinary SDK event type', () => {
    expect(classifyEventName('assistant')).toEqual({ kind: 'ok', name: 'assistant' });
    expect(classifyEventName('stream_event')).toEqual({ kind: 'ok', name: 'stream_event' });
  });

  it('rejects every reserved name, so a relayed event cannot impersonate a control frame', () => {
    for (const name of RESERVED_EVENT_NAMES) {
      const verdict = classifyEventName(name);
      expect(verdict.kind).toBe('reserved');
    }
  });

  it('reserves the platform lifecycle event names as well as the control frames', () => {
    // The reserved list is exactly the two halves and nothing else, so a name added to either is
    // rejected on the relay path without a second edit here.
    expect([...RESERVED_EVENT_NAMES].toSorted()).toEqual(
      [...CONTROL_FRAME_NAMES, ...PLATFORM_EVENT_NAMES].toSorted(),
    );
    // The specific regression: the platform's own lifecycle event, which a runtime could forge
    // into a run's durable log before this was reserved.
    expect(PLATFORM_EVENT_NAMES).toContain(RUN_STATUS_EVENT);
    expect(classifyEventName(RUN_STATUS_EVENT).kind).toBe('reserved');
  });

  it('admits a platform name only because it is one, and rejects everything else', () => {
    for (const name of PLATFORM_EVENT_NAMES) {
      expect(classifyPlatformEventName(name)).toEqual({ kind: 'ok', name });
    }
    // A control-frame name, an ordinary SDK type and a non-string all fall to the same else.
    for (const name of [...CONTROL_FRAME_NAMES, 'assistant', 'Run.Status', 'run.status ', '']) {
      expect(classifyPlatformEventName(name).kind).toBe('rejected');
    }
    for (const value of [null, undefined, 1, {}, ['run.status']]) {
      expect(classifyPlatformEventName(value).kind).toBe('rejected');
    }
  });

  it('rejects a name that could terminate the field and inject a frame', () => {
    for (const injection of [
      'assistant\ndata: {"stolen":true}\n\nevent: assistant',
      'assistant\rid: 9',
      'assistant\n\n',
    ]) {
      const verdict = classifyEventName(injection);
      expect(verdict.kind).toBe('rejected');
    }
  });

  it('rejects a non-string, an empty string and an over-long name by name', () => {
    expect(classifyEventName(undefined).kind).toBe('rejected');
    expect(classifyEventName(42).kind).toBe('rejected');
    expect(classifyEventName(null).kind).toBe('rejected');
    expect(classifyEventName('').kind).toBe('rejected');
    expect(classifyEventName('a'.repeat(65)).kind).toBe('rejected');
    expect(classifyEventName('a'.repeat(64)).kind).toBe('ok');
  });
});

describe('renderEventData', () => {
  it('rejects a value with no JSON representation instead of writing the text "undefined"', () => {
    expect(renderEventData(undefined).kind).toBe('rejected');
    expect(renderEventData(() => 1).kind).toBe('rejected');
    expect(renderEventData(Symbol('x')).kind).toBe('rejected');
  });

  it('rejects a bigint and a cycle rather than throwing inside the stream', () => {
    expect(renderEventData(1n).kind).toBe('rejected');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(renderEventData(cyclic).kind).toBe('rejected');
  });

  it('produces single-line JSON for a payload containing newlines', () => {
    const verdict = renderEventData({ text: 'a\nb' });
    expect(verdict.kind).toBe('ok');
    if (verdict.kind !== 'ok') return;
    expect(verdict.json).not.toContain('\n');
  });

  it('accepts null explicitly', () => {
    expect(renderEventData(null)).toEqual({ kind: 'ok', json: 'null' });
  });
});

describe('sseFrame', () => {
  it('writes event, id and data, terminated by a blank line', () => {
    expect(sseFrame({ id: 7n, type: 'assistant', data: { text: 'hi' } })).toBe(
      'event: assistant\nid: 7\ndata: {"text":"hi"}\n\n',
    );
  });

  it('writes the recorded time as an ISO-8601 at field between the id and the data', () => {
    const at = new Date('2026-10-13T10:00:12.400Z');
    expect(sseFrame({ id: 7n, type: 'assistant', data: { text: 'hi' }, at })).toBe(
      'event: assistant\nid: 7\nat: 2026-10-13T10:00:12.400Z\ndata: {"text":"hi"}\n\n',
    );
    expect(() =>
      sseFrame({ id: 7n, type: 'assistant', data: 1, at: new Date(Number.NaN) }),
    ).toThrow(RangeError);
  });

  it('carries the maximum event id without loss', () => {
    expect(sseFrame({ id: MAX_EVENT_ID, type: 'assistant', data: 1 })).toContain(
      `id: ${String(MAX_EVENT_ID)}\n`,
    );
  });

  it('throws rather than emitting a malformed frame', () => {
    expect(() => sseFrame({ id: 1n, type: 'bad\nname', data: {} })).toThrow(/refusing/);
    expect(() => sseFrame({ id: 1n, type: 'ok', data: undefined })).toThrow(/refusing/);
  });
});

describe('sseControlFrame, sseRetryFrame, sseComment', () => {
  it('writes a control frame with no id, so it never moves the resume cursor', () => {
    const frame = sseControlFrame({ name: 'done', data: {} });
    expect(frame).toBe('event: done\ndata: {}\n\n');
    expect(frame).not.toContain('id:');
    expect(frame).not.toContain('at:');
  });

  it('falls back to a message rather than throwing on an unserialisable control payload', () => {
    const frame = sseControlFrame({ name: 'run-failed', data: 1n });
    expect(frame.startsWith('event: run-failed\ndata: {')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('clamps retry to ASCII digits, as HTML §9.2 requires', () => {
    expect(sseRetryFrame(1500.7)).toBe('retry: 1500\n\n');
    expect(sseRetryFrame(Number.NaN)).toBe('retry: 3000\n\n');
    expect(sseRetryFrame(-1)).toBe('retry: 3000\n\n');
  });

  it('never lets a comment split into a second frame', () => {
    expect(sseComment('a\nb')).toBe(': a b\n\n');
  });
});

/**
 * The outcome a stream reports when the run behind it completed. Named rather than inlined
 * because `sseStreamResponse` requires it: a caller has to say how the run ended, and these tests
 * are about everything else, so they say "it completed" once and out loud.
 */
const completed = (): Promise<StreamOutcome> => Promise.resolve({ kind: 'succeeded' });

describe('sseStreamResponse', () => {
  it('answers 200 with the three headers', async () => {
    const controller = new AbortController();
    const response = sseStreamResponse({
      source: source({ id: 1n, type: 'assistant', data: { text: 'hi' } }),
      signal: controller.signal,
      outcome: completed,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    await drain(response);
  });

  it('sends retry, the prelude, the events and a final done frame', async () => {
    const controller = new AbortController();
    const response = sseStreamResponse({
      source: source(
        { id: 1n, type: 'assistant', data: 'a' },
        { id: 2n, type: 'assistant', data: 'b' },
      ),
      prelude: [{ name: 'stream-reset', data: { reason: 'r', resumedAfter: null } }],
      retryMs: 3000,
      signal: controller.signal,
      outcome: completed,
    });
    const text = await drain(response);
    expect(text).toBe(
      'retry: 3000\n\n' +
        'event: stream-reset\ndata: {"reason":"r","resumedAfter":null}\n\n' +
        'event: assistant\nid: 1\ndata: "a"\n\n' +
        'event: assistant\nid: 2\ndata: "b"\n\n' +
        'event: done\ndata: {}\n\n',
    );
  });

  it('turns a mid-stream failure into a 200 with a run-failed frame, never a non-200', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = new AbortController();
    const response = sseStreamResponse({
      source: sourceThenThrow(new Error('the runtime vanished SECRET_SENTINEL'), {
        id: 1n,
        type: 'assistant',
        data: 'a',
      }),
      signal: controller.signal,
      outcome: completed,
    });
    expect(response.status).toBe(200);
    const text = await drain(response);
    expect(text).toContain('event: assistant\nid: 1\n');
    // `unknown`, not `failed`: a stream that broke while producing frames knows nothing about
    // the run's own outcome, and must not assert one.
    expect(text).toContain(
      'event: run-failed\ndata: {"status":"unknown","message":"The event stream ended unexpectedly."}',
    );
    expect(text).not.toContain('SECRET_SENTINEL');
    expect((log.mock.calls[0]?.[1] as Error | undefined)?.cause).toEqual(
      new Error('the runtime vanished SECRET_SENTINEL'),
    );
    // No `done` either — telling the client to stop reconnecting would be that same assertion.
    expect(text).not.toContain('event: done');
    // Never `event: error`: HTML §9.2 would dispatch it into EventSource's transport-error path.
    expect(text).not.toContain('event: error');
    log.mockRestore();
  });

  it('emits a run-failed frame when a stored event turns out to be unrenderable', async () => {
    const controller = new AbortController();
    const response = sseStreamResponse({
      source: source({ id: 1n, type: 'done', data: {} }),
      signal: controller.signal,
      outcome: completed,
    });
    const text = await drain(response);
    expect(text).toContain('event: run-failed');
  });

  it('runs teardown exactly once, on normal completion', async () => {
    const controller = new AbortController();
    let teardowns = 0;
    const response = sseStreamResponse({
      source: source({ id: 1n, type: 'assistant', data: 'a' }),
      signal: controller.signal,
      outcome: completed,
      onTeardown: () => {
        teardowns += 1;
      },
    });
    await drain(response);
    controller.abort();
    expect(teardowns).toBe(1);
  });

  it('tears down when the client disconnects mid-stream', async () => {
    const controller = new AbortController();
    let teardowns = 0;
    let released = false;
    const response = sseStreamResponse({
      source: sourceThenNeverEnd(
        () => {
          released = true;
        },
        { id: 1n, type: 'assistant', data: 'a' },
      ),
      signal: controller.signal,
      outcome: completed,
      onTeardown: () => {
        teardowns += 1;
      },
    });
    const body = response.body;
    if (body === null) throw new Error('no body');
    const reader = body.getReader();
    await reader.read(); // retry frame
    await reader.read(); // the event
    // Give the producer a turn to reach the point where it blocks, so the assertion below is
    // about the source having been driven to its end rather than about scheduling luck.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(teardowns).toBe(1);
    expect(released).toBe(true);
    await reader.cancel();
  });

  it('tears down immediately when the request was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let teardowns = 0;
    const response = sseStreamResponse({
      source: source({ id: 1n, type: 'assistant', data: 'a' }),
      signal: controller.signal,
      outcome: completed,
      onTeardown: () => {
        teardowns += 1;
      },
    });
    expect(teardowns).toBe(1);
    await drain(response);
  });

  it('keeps the documented 15 s keep-alive default and emits comments on a silent stream', async () => {
    expect(DEFAULT_KEEPALIVE_MS).toBe(15_000);
    const controller = new AbortController();
    const response = sseStreamResponse({
      source: silentSource(),
      keepAliveMs: 5,
      signal: controller.signal,
      outcome: completed,
    });
    const body = response.body;
    if (body === null) throw new Error('no body');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // retry
    const first = decoder.decode((await reader.read()).value);
    expect(first).toBe(': keepalive\n\n');
    controller.abort();
    await reader.cancel();
  });

  it('rejects a NUL in an event name, which HTML §9.2 would make replay ignore', () => {
    expect(classifyEventName(`assistant${NUL}`).kind).toBe('rejected');
  });
});
