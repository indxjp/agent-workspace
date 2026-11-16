/**
 * Following a `channel()` stream from the browser (issue #1518), as a pure loop over `fetch` and
 * the SDK's SSE parser, so it is tested without React. `useChannel` drives it.
 *
 * The reconnect policy is `client.runs.follow`'s, with its exponential backoff on `retry:`:
 *
 * - a dropped connection reconnects with the last event id as `Last-Event-ID`, so nothing is
 *   missed and nothing is delivered twice;
 * - at most `maxReconnects` (5) reconnects in a row that deliver nothing new; a connection that
 *   moves the cursor starts the count again;
 * - the n-th reconnect in a row waits between half and all of `min(30 s, base × 2^(n−1))`, where
 *   `base` is the last `retry:` the stream sent (else 3 s); a `429` or `5xx` naming `Retry-After`
 *   waits exactly that long;
 * - a `stream-reset` frame means the server could not serve the cursor: the events held so far
 *   are discarded, and the stream goes on after `resumedAfter`.
 *
 * Any other refusal (`401`, `404`, `400 invalid_cursor`) ends following with the route's problem.
 */
import { parseSseFrame, splitSseFrames, type SseFrame } from '@indx-workspace/sdk/events';

import {
  CHANNEL_EPHEMERAL_FRAME,
  CHANNEL_EVENT_FRAME,
  ChannelEphemeralPayloadSchema,
  ChannelEventPayloadSchema,
  STREAM_RESET_FRAME,
  StreamResetPayloadSchema,
  type ChannelEphemeralPayload,
  type ChannelEventPayload,
  type StreamResetPayload,
} from '../channel-wire.js';
import { ResourceProblemError } from './client.js';
import { failureOf } from './recipe-client.js';

/** One durable event of a channel, with its id, the resume cursor. */
export interface ChannelEvent extends ChannelEventPayload {
  readonly id: string;
}

/** An ephemeral event of a channel: presence, typing. */
export type ChannelEphemeral = ChannelEphemeralPayload;

/** Where following stands. */
export type ChannelStatus = 'connecting' | 'open' | 'reconnecting' | 'lost' | 'refused';

/** What {@link followChannel} is told. */
export interface ChannelFollowOptions {
  /** The stream's URL, with its `?key=`. */
  readonly url: string;
  /** The global `fetch` when not given. */
  readonly fetch?: typeof fetch;
  /** Aborting it ends following. */
  readonly signal: AbortSignal;
  /** Resume after this event id; from the oldest retained event when `null` or not given. */
  readonly after?: string | null;
  /** 5 when not given. */
  readonly maxReconnects?: number;
  /** The base pause before a reconnect when the stream sent no `retry:`; 3000 ms when not given. */
  readonly reconnectDelayMs?: number;
  /** The longest pause before a reconnect; 30000 ms when not given. */
  readonly maxReconnectDelayMs?: number;
  /** Where a pause's jitter comes from; `Math.random` when not given. */
  readonly random?: () => number;
  /** How a pause is waited; a timer that `signal` cuts short when not given. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly onEvent: (event: ChannelEvent) => void;
  readonly onEphemeral?: (event: ChannelEphemeral) => void;
  readonly onReset: (notice: StreamResetPayload) => void;
  readonly onStatus?: (status: ChannelStatus) => void;
}

/** How following ended. */
export type ChannelFollowEnd =
  | { readonly kind: 'aborted' }
  | { readonly kind: 'lost' }
  | { readonly kind: 'refused'; readonly problem: ResourceProblemError };

const MAX_RECONNECTS = 5;
const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RETRY_LINE = /^retry: ?(\d+)$/u;
const RETRY_AFTER_SECONDS = /^\d{1,6}$/u;

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The last valid `retry:` of a block, or `null` when it has none (HTML §9.2: digits only). */
function retryOf(raw: string): number | null {
  let retry: number | null = null;
  for (const line of raw.split(/\r\n|\r|\n/u)) {
    const match = RETRY_LINE.exec(line);
    if (match !== null) retry = Number(match[1]);
  }
  return retry;
}

/** `Retry-After` in milliseconds, for a `429` or `5xx` that names it in seconds. */
function retryAfterOf(response: Response): number | null {
  const value = response.headers.get('retry-after')?.trim();
  return value !== undefined && RETRY_AFTER_SECONDS.test(value) ? Number(value) * 1000 : null;
}

/** One connection's outcome. */
type Connection =
  | {
      readonly kind: 'dropped';
      readonly lastEventId: string | null;
      readonly retryAfterMs: number | null;
    }
  | { readonly kind: 'refused'; readonly problem: ResourceProblemError };

const contractViolation = (status: number): ResourceProblemError =>
  new ResourceProblemError({
    code: 'contract_violation',
    status,
    message: 'the channel route did not answer with an event stream',
  });

/** Hands one frame to the callbacks; the cursor it moves to, or `undefined` when it does not. */
function dispatch(frame: SseFrame, options: ChannelFollowOptions): string | null | undefined {
  switch (frame.event) {
    case CHANNEL_EVENT_FRAME: {
      const payload = ChannelEventPayloadSchema.safeParse(frame.data);
      if (frame.id === null || !/^\d{1,19}$/u.test(frame.id) || !payload.success) return undefined;
      options.onEvent({ id: frame.id, ...payload.data });
      return frame.id;
    }
    case CHANNEL_EPHEMERAL_FRAME: {
      const payload = ChannelEphemeralPayloadSchema.safeParse(frame.data);
      if (payload.success) options.onEphemeral?.(payload.data);
      return undefined;
    }
    case STREAM_RESET_FRAME: {
      const notice = StreamResetPayloadSchema.safeParse(frame.data);
      if (!notice.success) return undefined;
      options.onReset(notice.data);
      return notice.data.resumedAfter;
    }
    default:
      return undefined;
  }
}

/** Reads one connection until it ends, breaks or `signal` aborts. */
async function connect(
  after: string | null,
  options: ChannelFollowOptions,
  onRetry: (ms: number) => void,
): Promise<Connection> {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  let lastEventId = after;
  let response: Response;
  try {
    response = await send(options.url, {
      credentials: 'same-origin',
      headers: {
        accept: 'text/event-stream',
        ...(after === null ? {} : { 'last-event-id': after }),
      },
      signal: options.signal,
    });
  } catch {
    return { kind: 'dropped', lastEventId, retryAfterMs: null };
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'dropped', lastEventId, retryAfterMs: retryAfterOf(response) };
  }
  if (response.status !== 200) return { kind: 'refused', problem: await failureOf(response) };
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim();
  if (mediaType !== 'text/event-stream' || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'refused', problem: contractViolation(response.status) };
  }
  options.onStatus?.('open');
  const reader = response.body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  options.signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const split = splitSseFrames(buffer);
      buffer = split.rest;
      for (const raw of split.frames) {
        const retry = retryOf(raw);
        if (retry !== null) onRetry(retry);
        const frame = parseSseFrame(raw);
        const cursor = frame === null ? undefined : dispatch(frame, options);
        if (cursor !== undefined) lastEventId = cursor;
      }
    }
  } catch {
    // A body that broke mid-stream is a drop like a clean end.
  } finally {
    options.signal.removeEventListener('abort', cancel);
  }
  return { kind: 'dropped', lastEventId, retryAfterMs: null };
}

/**
 * The pause before the `attempt`-th reconnect in a row: `d = min(cap, base × 2^(attempt−1))`,
 * then between `d / 2` and `d`, so streams dropped together do not return together.
 */
export function reconnectPause(
  base: number,
  cap: number,
  attempt: number,
  random: () => number,
): number {
  const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
  return ceiling / 2 + random() * (ceiling / 2);
}

/** Follows a channel stream until `signal` aborts, reconnects are spent, or the route refuses. */
export async function followChannel(options: ChannelFollowOptions): Promise<ChannelFollowEnd> {
  const maxReconnects = options.maxReconnects ?? MAX_RECONNECTS;
  const base = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
  const cap = options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? sleepFor;
  let retryHint: number | null = null;
  let after = options.after ?? null;
  let reconnects = 0;
  options.onStatus?.('connecting');
  for (;;) {
    if (options.signal.aborted) return { kind: 'aborted' };
    const connection = await connect(after, options, (ms) => {
      retryHint = ms;
    });
    if (options.signal.aborted) return { kind: 'aborted' };
    if (connection.kind === 'refused') {
      options.onStatus?.('refused');
      return { kind: 'refused', problem: connection.problem };
    }
    // The budget is for consecutive failures: a connection that moved the cursor resets it.
    if (connection.lastEventId !== after) reconnects = 0;
    if (reconnects >= maxReconnects) {
      options.onStatus?.('lost');
      return { kind: 'lost' };
    }
    reconnects += 1;
    after = connection.lastEventId;
    options.onStatus?.('reconnecting');
    // The server's `Retry-After` wins over the schedule: exact, uncapped, unjittered.
    await sleep(
      connection.retryAfterMs ?? reconnectPause(retryHint ?? base, cap, reconnects, random),
      options.signal,
    );
  }
}

/** What `useChannel` shows: the events held, oldest first, and where following stands. */
export interface ChannelState {
  readonly events: readonly ChannelEvent[];
  readonly status: ChannelStatus;
  /** The route's problem once it refused; `null` otherwise. */
  readonly problem: ResourceProblemError | null;
}

/** What changes a {@link ChannelState}. */
export type ChannelAction =
  | { readonly type: 'event'; readonly event: ChannelEvent }
  | { readonly type: 'reset' }
  | { readonly type: 'status'; readonly status: ChannelStatus }
  | { readonly type: 'refused'; readonly problem: ResourceProblemError };

/** The most events a {@link ChannelState} holds: a channel's default `retain`. */
export const MAX_HELD_EVENTS = 1_000;

/** A state with no events, connecting. */
export const INITIAL_CHANNEL_STATE: ChannelState = Object.freeze({
  events: Object.freeze([]),
  status: 'connecting',
  problem: null,
});

/**
 * The next state: an event is added once (an id already held is ignored), keeping the newest
 * {@link MAX_HELD_EVENTS}; a reset discards every event held.
 */
export function channelReducer(state: ChannelState, action: ChannelAction): ChannelState {
  switch (action.type) {
    case 'event': {
      if (state.events.some((event) => event.id === action.event.id)) return state;
      const events = [...state.events, action.event];
      return { ...state, events: events.slice(Math.max(0, events.length - MAX_HELD_EVENTS)) };
    }
    case 'reset':
      return { ...state, events: [] };
    case 'status':
      return state.status === action.status ? state : { ...state, status: action.status };
    case 'refused':
      return { ...state, status: 'refused', problem: action.problem };
    default: {
      const unhandled: never = action;
      void unhandled;
      return state;
    }
  }
}
