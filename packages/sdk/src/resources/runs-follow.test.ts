import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';

import { HttpClient } from '../http.js';
import {
  drain,
  droppedEventStreamResponse as dropped,
  eventStreamResponse as stream,
  fetchDouble,
  jsonResponse as json,
  openEventStreamResponse as open,
} from '../testing.js';
import { RunsClient } from './runs.js';
import { RUN, run, client } from './runs.fixture.test-support.js';

it('does not send an empty event id as a resume cursor after a dropped connection', async () => {
  let attempt = 0;
  const { runs, calls } = client(() => {
    attempt += 1;
    return attempt === 1
      ? stream(
          'event: sdk-event\nid: 5\ndata: {"kind":"event"}\n\nevent: sdk-event\nid:\ndata: {"kind":"event"}\n\n',
        )
      : stream('event: done\n\n');
  });
  const seen: string[] = [];
  for await (const frame of runs.follow(RUN, { reconnectDelayMs: 0 })) seen.push(frame.kind);
  expect(seen).toEqual(['runtime', 'runtime']);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.headers.has('last-event-id')).toBe(false);
});

it('reconnects after a dropped connection with the last durable id, then ends on done', async () => {
  let attempt = 0;
  const { runs, calls } = client(() => {
    attempt += 1;
    return attempt === 1
      ? stream(
          'event: sdk-event\nid: 5\ndata: {"kind":"event"}\n\nevent: run-failed\ndata: {"status":"unknown","message":"x"}\n\n',
        )
      : stream('event: sdk-event\nid: 6\ndata: {"kind":"event"}\n\nevent: done\n\n');
  });
  const seen: string[] = [];
  for await (const frame of runs.follow(RUN, { reconnectDelayMs: 0 })) {
    seen.push(frame.kind === 'runtime' ? `runtime:${frame.id ?? ''}` : frame.kind);
  }
  expect(seen).toEqual(['runtime:5', 'run-failed', 'runtime:6']);
  expect(calls[0]?.headers.has('last-event-id')).toBe(false);
  expect(calls[1]?.headers.get('last-event-id')).toBe('5');
});

it('reconnects with the last durable id after the body errors mid-stream', async () => {
  let attempt = 0;
  const { runs, calls } = client(() => {
    attempt += 1;
    return attempt === 1
      ? dropped('event: sdk-event\nid: 5\ndata: {"kind":"event"}\n\n')
      : stream('event: sdk-event\nid: 6\ndata: {"kind":"event"}\n\nevent: done\n\n');
  });
  const seen: string[] = [];
  for await (const frame of runs.follow(RUN, { reconnectDelayMs: 0 })) {
    seen.push(frame.kind === 'runtime' ? `runtime:${frame.id ?? ''}` : frame.kind);
  }
  expect(seen).toEqual(['runtime:5', 'runtime:6']);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.headers.get('last-event-id')).toBe('5');
});

it('cancels the connection when the consumer breaks out of the loop', async () => {
  const body = open('event: sdk-event\nid: 1\ndata: {}\n\n');
  const { runs, calls } = client(() => body.response);
  for await (const frame of runs.follow(RUN, { reconnectDelayMs: 0 })) {
    expect(frame.kind).toBe('runtime');
    break;
  }
  expect(body.cancelled()).toBe(true);
  expect(calls).toHaveLength(1);
});

it('does not retry a 200 that is not an event stream', async () => {
  const { runs, calls } = client(() => json(200, { run: run('queued') }));
  const failure = await drain(runs.follow(RUN, { reconnectDelayMs: 0 })).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(ContractViolationError);
  expect(calls).toHaveLength(1);
});

it('ends with an aborted transport failure when the signal aborts while the stream is open', async () => {
  const during = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: sdk-event\nid: 1\ndata: {}\n\n'));
    },
    pull() {
      // The consumer gives up while the server still has the connection open.
      during.abort();
    },
  });
  const { runs, calls } = client(
    () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  const seen: string[] = [];
  const failure = await (async () => {
    for await (const frame of runs.follow(RUN, { signal: during.signal })) seen.push(frame.kind);
  })().catch((e: unknown) => e);
  expect(seen).toEqual(['runtime']);
  expect(failure).toBeInstanceOf(TransportError);
  expect((failure as TransportError).aborted).toBe(true);
  expect(calls).toHaveLength(1);
});

it('ends with an aborted transport failure when the signal aborts between connections', async () => {
  const between = new AbortController();
  const { runs, calls } = client(() => dropped('event: sdk-event\nid: 1\ndata: {}\n\n'));
  const failure = await (async () => {
    for await (const frame of runs.follow(RUN, {
      reconnectDelayMs: 10_000,
      signal: between.signal,
    })) {
      expect(frame.kind).toBe('runtime');
      // The drop is observed within the microtask queue; this fires once follow() is waiting.
      setTimeout(() => between.abort(), 0);
    }
  })().catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(TransportError);
  expect((failure as TransportError).aborted).toBe(true);
  expect(calls).toHaveLength(1);
});

it('reconnects again after a headers timeout on a reconnect, which is a drop and not an abort', async () => {
  let attempt = 0;
  const api = fetchDouble((request) => {
    attempt += 1;
    if (attempt === 1) return dropped('event: sdk-event\nid: 1\ndata: {}\n\n');
    if (attempt === 2) {
      // No headers within timeoutMs: the deadline aborts this request, as a real fetch would.
      return new Promise<Response>((_, reject) => {
        request.init.signal?.addEventListener('abort', () => {
          reject(new DOMException('deadline', 'TimeoutError'));
        });
      });
    }
    return stream('event: sdk-event\nid: 2\ndata: {}\n\nevent: done\n\n');
  });
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
    timeoutMs: 5,
  });
  const seen: string[] = [];
  for await (const frame of new RunsClient(http).follow(RUN, { reconnectDelayMs: 0 })) {
    seen.push(frame.kind === 'runtime' ? `runtime:${frame.id ?? ''}` : frame.kind);
  }
  expect(seen).toEqual(['runtime:1', 'runtime:2']);
  expect(api.calls).toHaveLength(3);
  expect(api.calls[2]?.headers.get('last-event-id')).toBe('1');
});

it('gives up after maxReconnects and rethrows the transport failure', async () => {
  const { runs, calls } = client(() => stream('event: sdk-event\nid: 1\ndata: {}\n\n'));
  const failure = await drain(runs.follow(RUN, { maxReconnects: 2, reconnectDelayMs: 0 })).catch(
    (e: unknown) => e,
  );
  expect(failure).toBeInstanceOf(TransportError);
  expect(calls).toHaveLength(3);
});

it('counts only consecutive failed reconnects against maxReconnects', async () => {
  let attempt = 0;
  const { runs, calls } = client(() => {
    attempt += 1;
    // Every connection delivers one new event before the proxy drops it.
    return attempt < 4
      ? dropped(`event: sdk-event\nid: ${String(attempt)}\ndata: {}\n\n`)
      : stream('event: done\n\n');
  });
  const seen: string[] = [];
  for await (const frame of runs.follow(RUN, { maxReconnects: 1, reconnectDelayMs: 0 })) {
    seen.push(frame.kind);
  }
  expect(seen).toEqual(['runtime', 'runtime', 'runtime']);
  expect(calls).toHaveLength(4);
  expect(calls[3]?.headers.get('last-event-id')).toBe('3');
});

it('reconnects after a 5xx or 429 answer, waiting the Retry-After it names', async () => {
  const answers = [503, 429];
  const { runs, calls } = client(() => {
    const status = answers.shift();
    return status === undefined
      ? stream('event: done\n\n')
      : json(status, { error: { code: 'busy', message: 'restarting' } }, { 'retry-after': '0' });
  });
  // A 10 s reconnectDelayMs would time the test out: Retry-After: 0 is what is waited.
  await drain(runs.follow(RUN, { reconnectDelayMs: 10_000 }));
  expect(calls).toHaveLength(3);
});

it('does not reconnect after a problem response', async () => {
  const { runs, calls } = client(() =>
    json(404, { error: { code: 'run_not_found', message: 'no run' } }),
  );
  const failure = await runs
    .follow(RUN, { reconnectDelayMs: 0 })
    .next()
    .catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(ApiProblemError);
  expect(calls).toHaveLength(1);
});

describe('RunsClient.follow backoff (issue #250, K-3)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * A client whose n-th connection is answered by `answers[n]` (the last repeats), recording when
   * each connection was opened on the fake clock.
   */
  function timed(answers: readonly (() => Response)[]): {
    readonly runs: RunsClient;
    readonly opened: number[];
  } {
    const opened: number[] = [];
    const { runs } = client(() => {
      opened.push(Date.now());
      const answer = answers[Math.min(opened.length, answers.length) - 1];
      if (answer === undefined) throw new Error('no answers');
      return answer();
    });
    return { runs, opened };
  }

  const gaps = (opened: readonly number[]): number[] =>
    opened.slice(1).map((at, index) => at - (opened[index] ?? 0));

  /** Follow to the end on the fake clock, failing the test rather than hanging. */
  async function followed(
    runs: RunsClient,
    options: Parameters<RunsClient['follow']>[1] = {},
  ): Promise<void> {
    const result = drain(runs.follow(RUN, options));
    await vi.advanceTimersByTimeAsync(600_000);
    await result;
  }

  const event = (id: number): string => `event: sdk-event\nid: ${String(id)}\ndata: {}\n\n`;
  const done = (): Response => stream('event: done\n\n');

  it('waits for the jittered retry: the stream sent, not the default, before reconnecting', async () => {
    vi.useFakeTimers();
    for (const [random, floor] of [
      [0, 5000],
      [0.999_999, 9999],
    ] as const) {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      const { runs, opened } = timed([() => dropped(`retry: 10000\n\n${event(1)}`), done]);
      const result = drain(runs.follow(RUN));
      // `[d / 2, d]` with d = 10000: never before half of the server's value, always by all of it.
      await vi.advanceTimersByTimeAsync(floor - 1);
      expect(opened, `random ${String(random)}`).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000 - floor + 1);
      expect(opened).toHaveLength(2);
      await result;
    }
  });

  it('doubles the pause while reconnects keep failing, up to maxReconnectDelayMs', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { runs, opened } = timed([
      () => dropped(event(1)),
      () => stream(''),
      () => stream(''),
      () => stream(''),
      done,
    ]);
    await followed(runs, { reconnectDelayMs: 1000, maxReconnectDelayMs: 4000 });
    // d = 1000, 2000, 4000, 4000 (capped); each pause is 3/4 of d at random() = 0.5.
    expect(gaps(opened)).toEqual([750, 1500, 3000, 3000]);
  });

  it('caps a retry: above the ceiling, and the jitter never passes the ceiling', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.999_999);
    const { runs, opened } = timed([() => dropped(`retry: 60000\n\n${event(1)}`), done]);
    await followed(runs);
    const [gap] = gaps(opened);
    expect(gap).toBeGreaterThanOrEqual(15_000);
    expect(gap).toBeLessThanOrEqual(30_000);
  });

  it('waits exactly the Retry-After a 503 names, uncapped and unjittered, over the retry: schedule', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { runs, opened } = timed([
      () => dropped(`retry: 10000\n\n${event(1)}`),
      () => json(503, { error: { code: 'busy', message: 'restarting' } }, { 'retry-after': '60' }),
      done,
    ]);
    await followed(runs);
    expect(gaps(opened)).toEqual([7500, 60_000]);
  });

  it('starts the backoff again after a connection that delivered an event', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { runs, opened } = timed([
      () => dropped(event(1)),
      () => stream(''),
      () => dropped(event(2)),
      done,
    ]);
    await followed(runs, { reconnectDelayMs: 1000 });
    expect(gaps(opened)).toEqual([750, 1500, 750]);
  });

  it('keeps the retry: base across connections that do not repeat it', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { runs, opened } = timed([
      () => dropped(`retry: 2000\n\n${event(1)}`),
      () => stream(''),
      done,
    ]);
    await followed(runs);
    expect(gaps(opened)).toEqual([1500, 3000]);
  });

  it('is still an aborted TransportError when the signal aborts during a backoff wait', async () => {
    vi.useFakeTimers();
    const between = new AbortController();
    const { runs, opened } = timed([() => dropped(`retry: 10000\n\n${event(1)}`)]);
    const failure = drain(runs.follow(RUN, { signal: between.signal })).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    between.abort();
    const caught = await failure;
    expect(caught).toBeInstanceOf(TransportError);
    expect((caught as TransportError).aborted).toBe(true);
    expect(opened).toHaveLength(1);
  });

  it('refuses reconnect bounds that are negative, not finite, or inverted, before any request', async () => {
    const { runs, calls } = client(() => stream('event: done\n\n'));
    for (const options of [
      { reconnectDelayMs: -1 },
      { reconnectDelayMs: Number.NaN },
      { maxReconnectDelayMs: Number.POSITIVE_INFINITY },
      { reconnectDelayMs: 5000, maxReconnectDelayMs: 1000 },
      // The default base, 3000, is above this ceiling.
      { maxReconnectDelayMs: 1000 },
    ]) {
      const failure = await drain(runs.follow(RUN, options)).catch((e: unknown) => e);
      expect(failure, JSON.stringify(options)).toBeInstanceOf(TypeError);
    }
    expect(calls).toHaveLength(0);
    await drain(runs.follow(RUN, { reconnectDelayMs: 0, maxReconnectDelayMs: 0 }));
    expect(calls).toHaveLength(1);
  });
});
