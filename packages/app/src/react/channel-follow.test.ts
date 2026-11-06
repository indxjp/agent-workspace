import {
  droppedEventStreamResponse,
  eventStreamResponse,
  jsonResponse,
  openEventStreamResponse,
} from '@indx-workspace/sdk/testing';
import { describe, expect, it } from 'vitest';

import {
  channelReducer,
  followChannel,
  INITIAL_CHANNEL_STATE,
  MAX_HELD_EVENTS,
  reconnectPause,
  type ChannelEvent,
  type ChannelFollowOptions,
  type ChannelStatus,
} from './channel-follow.js';
import { channelEventsUrl } from './use-channel.js';

const KEY = '11111111-1111-4111-8111-111111111111';
const URL_OF_KEY = channelEventsUrl('chat', KEY, 'https://app.test/');

const event = (id: number, type = 'created'): string =>
  `event: channel-event\nid: ${String(id)}\ndata: ${JSON.stringify({ key: KEY, type, data: { id }, at: '2026-01-01T00:00:00.000Z' })}\n\n`;

/** A scripted follow: each fetch takes the next response; the last open one is cancelled on abort. */
function harness(responses: readonly (() => Response)[]) {
  const abort = new AbortController();
  const sent: (string | null)[] = [];
  const pauses: number[] = [];
  const events: ChannelEvent[] = [];
  const ephemeral: unknown[] = [];
  const resets: unknown[] = [];
  const statuses: ChannelStatus[] = [];
  let next = 0;
  const options: ChannelFollowOptions = {
    url: URL_OF_KEY,
    signal: abort.signal,
    random: () => 1,
    sleep: (ms) => {
      pauses.push(ms);
      return Promise.resolve();
    },
    fetch: (_input, init) => {
      sent.push(new Headers(init?.headers).get('last-event-id'));
      const respond = responses[next];
      next += 1;
      if (respond === undefined) {
        abort.abort();
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      }
      return Promise.resolve(respond());
    },
    onEvent: (received) => events.push(received),
    onEphemeral: (received) => ephemeral.push(received),
    onReset: (notice) => resets.push(notice),
    onStatus: (status) => statuses.push(status),
  };
  return { abort, sent, pauses, events, ephemeral, resets, statuses, options };
}

describe('followChannel', () => {
  it('builds the stream URL with the key', () => {
    expect(URL_OF_KEY).toBe(`https://app.test/api/channels/chat/events?key=${KEY}`);
  });

  it('resumes a dropped connection with Last-Event-ID, with no gap and no duplicate', async () => {
    const open = openEventStreamResponse(event(4));
    const run = harness([
      () => droppedEventStreamResponse(`retry: 3000\n\n${event(1)}${event(2)}`),
      () => droppedEventStreamResponse(event(3)),
      () => open.response,
    ]);
    const done = followChannel(run.options);
    await new Promise((resolve) => setTimeout(resolve, 20));
    run.abort.abort();
    expect(await done).toEqual({ kind: 'aborted' });
    expect(run.sent).toEqual([null, '2', '3']);
    expect(run.events.map((received) => received.id)).toEqual(['1', '2', '3', '4']);
    expect(open.cancelled()).toBe(true);
    expect(run.statuses).toEqual([
      'connecting',
      'open',
      'reconnecting',
      'open',
      'reconnecting',
      'open',
    ]);
  });

  it('gives up after five reconnects in a row that deliver nothing new', async () => {
    const run = harness(Array.from({ length: 10 }, () => () => droppedEventStreamResponse('')));
    expect(await followChannel(run.options)).toEqual({ kind: 'lost' });
    expect(run.sent).toHaveLength(6);
    expect(run.statuses.at(-1)).toBe('lost');
  });

  it('starts the budget again when a connection moves the cursor', async () => {
    const responses = [
      ...Array.from({ length: 4 }, () => () => droppedEventStreamResponse('')),
      () => droppedEventStreamResponse(event(9)),
      ...Array.from({ length: 10 }, () => () => droppedEventStreamResponse('')),
    ];
    const run = harness(responses);
    expect(await followChannel(run.options)).toEqual({ kind: 'lost' });
    // Four empty, the one that moved, then five more reconnects before giving up.
    expect(run.sent).toEqual([null, null, null, null, null, '9', '9', '9', '9', '9']);
  });

  it('honours retry: with exponential backoff capped at 30 s', async () => {
    const run = harness(
      Array.from({ length: 7 }, () => () => droppedEventStreamResponse('retry: 4000\n\n')),
    );
    await followChannel({ ...run.options, maxReconnects: 6 });
    expect(run.pauses).toEqual([4000, 8000, 16_000, 30_000, 30_000, 30_000]);
  });

  it('falls back to 3 s without retry:, and jitters each pause into its upper half', () => {
    expect(reconnectPause(3000, 30_000, 1, () => 0)).toBe(1500);
    expect(reconnectPause(3000, 30_000, 2, () => 1)).toBe(6000);
    expect(reconnectPause(3000, 30_000, 10, () => 0.5)).toBe(22_500);
  });

  it('waits exactly Retry-After on a 503 or a 429', async () => {
    const run = harness([
      () =>
        jsonResponse(503, { error: { code: 'busy', message: 'Busy.' } }, { 'retry-after': '7' }),
      () =>
        jsonResponse(429, { error: { code: 'slow', message: 'Slow.' } }, { 'retry-after': '2' }),
      () => droppedEventStreamResponse(''),
    ]);
    await followChannel({ ...run.options, maxReconnects: 2 });
    expect(run.pauses).toEqual([7000, 2000]);
  });

  it('ends with the route problem on a refusal', async () => {
    const run = harness([
      () => jsonResponse(404, { error: { code: 'resource_not_found', message: 'Gone.' } }),
    ]);
    const end = await followChannel(run.options);
    expect(end.kind).toBe('refused');
    expect(end.kind === 'refused' ? [end.problem.code, end.problem.status] : []).toEqual([
      'resource_not_found',
      404,
    ]);
    expect(run.statuses.at(-1)).toBe('refused');
  });

  it('refuses a 200 that is not an event stream', async () => {
    const run = harness([() => jsonResponse(200, {})]);
    const end = await followChannel(run.options);
    expect(end.kind === 'refused' ? end.problem.code : end.kind).toBe('contract_violation');
  });

  it('hands over stream-reset and ephemeral frames, and resumes after resumedAfter', async () => {
    const reset = `event: stream-reset\ndata: ${JSON.stringify({ reason: 'gone', resumedAfter: '6' })}\n\n`;
    const presence = `event: channel-ephemeral\ndata: ${JSON.stringify({ key: KEY, type: 'presence', data: { on: true } })}\n\n`;
    const run = harness([
      () => droppedEventStreamResponse(`${reset}${presence}`),
      () => eventStreamResponse(event(7)),
    ]);
    const done = followChannel(run.options);
    await new Promise((resolve) => setTimeout(resolve, 20));
    run.abort.abort();
    await done;
    expect(run.resets).toEqual([{ reason: 'gone', resumedAfter: '6' }]);
    expect(run.ephemeral).toEqual([{ key: KEY, type: 'presence', data: { on: true } }]);
    expect(run.sent.slice(0, 2)).toEqual([null, '6']);
    expect(run.events.map((received) => received.id)).toEqual(['7']);
  });

  it('ignores a frame named error, a malformed payload and an event without an id', async () => {
    const run = harness([
      () =>
        eventStreamResponse(
          `event: ${'error'}\ndata: {}\n\nevent: channel-event\ndata: {"key":"${KEY}"}\n\n` +
            `event: channel-event\ndata: ${JSON.stringify({ key: KEY, type: 'x', data: 1, at: 'now' })}\n\n${event(2)}`,
        ),
    ]);
    await followChannel({ ...run.options, maxReconnects: 0 });
    expect(run.events.map((received) => received.id)).toEqual(['2']);
  });
});

describe('channelReducer', () => {
  const held = (id: string): ChannelEvent => ({
    id,
    key: KEY,
    type: 'created',
    data: null,
    at: 'now',
  });

  it('adds an event once, and a stream-reset clears the events held', () => {
    let state = channelReducer(INITIAL_CHANNEL_STATE, { type: 'event', event: held('1') });
    state = channelReducer(state, { type: 'event', event: held('1') });
    state = channelReducer(state, { type: 'event', event: held('2') });
    expect(state.events.map((received) => received.id)).toEqual(['1', '2']);
    state = channelReducer(state, { type: 'reset' });
    expect(state.events).toEqual([]);
  });

  it('keeps the newest events only, and records the status', () => {
    let state = INITIAL_CHANNEL_STATE;
    for (let id = 1; id <= MAX_HELD_EVENTS + 5; id += 1) {
      state = channelReducer(state, { type: 'event', event: held(String(id)) });
    }
    expect(state.events).toHaveLength(MAX_HELD_EVENTS);
    expect(state.events[0]?.id).toBe('6');
    expect(channelReducer(state, { type: 'status', status: 'open' }).status).toBe('open');
  });
});
