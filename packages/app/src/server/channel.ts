/**
 * `channel()`: an app's realtime channel (F-11, issue #1518), over PostgreSQL `LISTEN/NOTIFY`
 * and one Server-Sent Events endpoint per channel. No Redis and no new service.
 *
 * - `publish(tx, { key, type, data })` stores a durable event in `app_channel_events` and notifies
 *   it in the same transaction, so a write that rolls back is never delivered; each key keeps its
 *   newest `retain` events (1000 by default).
 * - `publishEphemeral({ key, type, data })` only notifies: presence and typing, with no row and no
 *   cursor.
 * - `subscribe({ workspaceId, key })` follows a key from the server: it checks no access, so a
 *   browser reaches a channel through `routes()` only.
 * - `routes()` is `{ GET }` for `app/api/channels/<name>/events/route.ts`:
 *   `GET /api/channels/<name>/events?key=<recordId>`, as the person asking. The bound resource's
 *   `read` access on the record `key` decides; a refusal is `404` before the stream opens.
 *
 * While a person's stream is open, the channel announces them on its key every 15 seconds with
 * an ephemeral `presence` event, `{ principalId }` (issue #1519), first as the stream opens: a
 * `ChannelView` shows who is here and forgets a person 45 seconds after their last one. The
 * browser sends nothing for it, so presence needs no route of its own.
 *
 * A stream resumes from `Last-Event-ID` or `?after=` (the header wins). A cursor older than the
 * key's oldest retained event, or newer than its latest, is answered with `stream-reset` and the
 * stream goes on from the oldest retained event; a malformed cursor is `400 invalid_cursor`.
 *
 * The channel reaches the database through the runtime: `appRuntime().channelLog` stores and
 * reads, and `appRuntime().channelListener()` is the process's one `LISTEN` connection, created
 * on the first subscribe.
 */
import {
  CHANNEL_EPHEMERAL_FRAME,
  CHANNEL_EVENT_FRAME,
  ChannelEventTypeSchema,
  ChannelKeySchema,
  ChannelNameSchema,
  PRESENCE_EVENT,
  PRESENCE_HEARTBEAT_MS,
  STREAM_RESET_FRAME,
  type ChannelPresence,
  type ChannelEphemeralPayload,
  type StreamResetPayload,
} from '../channel-wire.js';
import {
  channelTopic,
  type ChannelEventLog,
  type ChannelEventRecord,
  type ChannelScope,
} from '../db/channel-events.js';
import { AppStoreError } from '../db/errors.js';
import type { AppSqlRunner } from '../db/store.js';
import type { DefinedResource } from '../resource.js';
import type { ChannelListener } from './channel-listener.js';
import { readResumeCursor } from './cursor.js';
import { currentPerson } from './person.js';
import { problem } from './problem.js';
import { refusalOf, RequestRefusal } from './routes.js';
import { appRuntime } from './runtime.js';
import { sseControlFrame, sseEventFrame, sseResponse } from './sse.js';

/** What {@link channel} takes besides its name. */
export interface ChannelOptions {
  /** The resource whose `read` access on the record `key` admits a subscriber. */
  readonly resource: DefinedResource;
  /**
   * The field of a written record whose value is the channel key it is published under, for a
   * binding that publishes a resource's writes; the record's `id` when not given.
   */
  readonly key?: string;
  /** How many events each key keeps: 1–100000, 1000 when not given. */
  readonly retain?: number;
}

/** A durable or ephemeral event to publish. */
export interface ChannelPublish {
  readonly key: string;
  /** The event's type, in the platform's event-name grammar (`created`, `presence`). */
  readonly type: string;
  /** Any JSON value. */
  readonly data: unknown;
  /** The workspace it belongs to; the runtime's one workspace when not given. */
  readonly workspaceId?: string;
}

/** What a subscriber receives. */
export type ChannelDelivery =
  | ({ readonly kind: 'event' } & ChannelEventRecord)
  | ({ readonly kind: 'ephemeral' } & ChannelEphemeralPayload)
  | ({ readonly kind: 'reset' } & StreamResetPayload);

/** Where a subscription starts and how it ends. */
export interface ChannelSubscribeOptions {
  readonly workspaceId: string;
  readonly key: string;
  /** Resume after this event id; from the oldest retained event when `null` or not given. */
  readonly after?: bigint | null;
  /** Aborting it ends the subscription. */
  readonly signal: AbortSignal;
}

/** `GET /api/channels/<name>/events`. */
export type ChannelHandler = (request: Request) => Promise<Response>;

/** An app's channel. */
export interface Channel {
  readonly name: string;
  readonly resource: DefinedResource;
  /** The field of a written record that names its key; `id` when not given. */
  readonly keyField: string;
  readonly retain: number;
  /** Stores and notifies an event in `tx`; it is delivered when `tx` commits. */
  publish(tx: AppSqlRunner, event: ChannelPublish): Promise<ChannelEventRecord>;
  /** Notifies an event without storing it; it must encode to fewer than 8000 bytes. */
  publishEphemeral(event: ChannelPublish): Promise<void>;
  /** Follows one key, without checking access; the stream ends when `signal` aborts. */
  subscribe(options: ChannelSubscribeOptions): AsyncGenerator<ChannelDelivery, void, void>;
  /** The route handler of the channel's event stream. */
  routes(): { readonly GET: ChannelHandler };
}

const DEFAULT_RETAIN = 1_000;
const MAX_RETAIN = 100_000;
/** How many stored events one read takes. */
const PAGE_SIZE = 100;

const invalid = (what: string): TypeError => new TypeError(`channel(): ${what}`);
const KEY_RULE = 'the key must be 1 to 200 characters, with no ":" or control character';

function isJson(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

/** The dependencies of one subscription: the event log and the process's listener. */
interface ChannelSource {
  readonly log: ChannelEventLog;
  readonly listener: ChannelListener;
  readonly appName: string;
}

/** Where a cursor leaves the stream: after which id, and the reset notice when it was not served. */
function resumePoint(
  scope: ChannelScope,
  after: bigint | null,
  bounds: { readonly oldest: bigint; readonly latest: bigint } | null,
): { readonly after: bigint; readonly reset: StreamResetPayload | null } {
  if (after === null) return { after: 0n, reset: null };
  if (bounds === null) {
    return after === 0n
      ? { after: 0n, reset: null }
      : {
          after: 0n,
          reset: {
            reason: `channel key ${scope.key} has no event after ${String(after)}`,
            resumedAfter: null,
          },
        };
  }
  const restart = bounds.oldest - 1n;
  if (after > bounds.latest) {
    return {
      after: restart,
      reset: {
        reason: `channel key ${scope.key} has no event after ${String(after)}; the stream restarts at the oldest retained event`,
        resumedAfter: String(restart),
      },
    };
  }
  if (after < restart) {
    return {
      after: restart,
      reset: {
        reason: `events after ${String(after)} are no longer retained; the stream resumes at the oldest retained event`,
        resumedAfter: String(restart),
      },
    };
  }
  return { after, reset: null };
}

/**
 * The deliveries of one key: the reset notice when the cursor is not served, the stored events
 * after it, then each event as it is published, until `signal` aborts. `onListening` is called
 * once the key is listened to, before the backlog is read.
 */
async function* channelDeliveries(
  source: ChannelSource,
  scope: ChannelScope,
  after: bigint | null,
  signal: AbortSignal,
  onListening?: () => void,
): AsyncGenerator<ChannelDelivery, void, void> {
  const pending: ChannelDelivery[] = [];
  // Whether something may have been stored since the last read: true until the backlog is read.
  let dirty = true;
  let resume: (() => void) | null = null;
  const nudge = (): void => resume?.();
  const wake = (): void => {
    dirty = true;
    nudge();
  };
  // Registered before the backlog is read, so a publish in between wakes the read that follows.
  const unsubscribe = source.listener.subscribe(
    channelTopic(scope.workspaceId, source.appName, scope.channel),
    {
      wake,
      ephemeral(event) {
        if (event.key !== scope.key) return;
        pending.push({ kind: 'ephemeral', ...event });
        nudge();
      },
    },
  );
  signal.addEventListener('abort', nudge, { once: true });
  onListening?.();
  try {
    const start = resumePoint(scope, after, await source.log.bounds(scope));
    let cursor = start.after;
    if (start.reset !== null) yield { kind: 'reset', ...start.reset };
    while (!signal.aborted) {
      if (dirty) {
        dirty = false;
        const page = await source.log.after(scope, cursor, PAGE_SIZE);
        for (const event of page) {
          cursor = BigInt(event.id);
          yield { kind: 'event', ...event };
        }
        // A full page means more are waiting.
        if (page.length === PAGE_SIZE) dirty = true;
      }
      for (let next = pending.shift(); next !== undefined; next = pending.shift()) yield next;
      if (dirty || signal.aborted) continue;
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      resume = null;
    }
  } finally {
    signal.removeEventListener('abort', nudge);
    unsubscribe();
  }
}

/** One delivery as wire text. */
function frameOf(delivery: ChannelDelivery): string | null {
  switch (delivery.kind) {
    case 'event': {
      const { id, key, type, data, at } = delivery;
      return sseEventFrame(CHANNEL_EVENT_FRAME, id, undefined, { key, type, data, at });
    }
    case 'ephemeral': {
      const { key, type, data } = delivery;
      return sseEventFrame(CHANNEL_EPHEMERAL_FRAME, null, undefined, { key, type, data });
    }
    case 'reset':
      return sseControlFrame(STREAM_RESET_FRAME, {
        reason: delivery.reason,
        resumedAfter: delivery.resumedAfter,
      });
    default: {
      const unhandled: never = delivery;
      void unhandled;
      return null;
    }
  }
}

function sourceOf(): ChannelSource {
  const runtime = appRuntime();
  return {
    log: runtime.channelLog,
    listener: runtime.channelListener(),
    appName: runtime.appName,
  };
}

const invalidCursor = (): RequestRefusal =>
  new RequestRefusal(
    'invalid_cursor',
    400,
    'Last-Event-ID or after must be an event id: 1 to 19 digits.',
  );

/**
 * Announces `principalId` on the key now and every {@link PRESENCE_HEARTBEAT_MS} until `signal`
 * aborts. A heartbeat that fails is dropped: the next one, or the expiry, corrects it.
 */
function announcePresence(
  channel: Channel,
  event: Omit<ChannelPublish, 'type' | 'data'> & { readonly principalId: string },
  signal: AbortSignal,
): void {
  const beat = (): void => {
    channel
      .publishEphemeral({
        key: event.key,
        type: PRESENCE_EVENT,
        data: { principalId: event.principalId } satisfies ChannelPresence,
        ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
      })
      .catch(() => undefined);
  };
  beat();
  const timer = setInterval(beat, PRESENCE_HEARTBEAT_MS);
  (timer as { unref?: () => void }).unref?.();
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}

/** The stream of `channel`'s key for the person asking. */
async function serveEvents(channel: Channel, request: Request): Promise<Response> {
  const runtime = appRuntime();
  const url = new URL(request.url);
  const keys = url.searchParams.getAll('key');
  const person = await currentPerson(request);
  if (person === null) {
    return problem('unauthenticated', 401, 'Sign in to Agent Workspace to use this app.');
  }
  const key = keys.length === 1 ? ChannelKeySchema.safeParse(keys[0]) : undefined;
  if (key === undefined || !key.success) {
    throw new AppStoreError('invalid_query', { details: ['key'] });
  }
  // The bound resource's `read` access on the record decides; a refusal is a 404, before the stream.
  await runtime.storeOf(channel.resource).get(person, key.data);
  const cursor = readResumeCursor(
    request.headers.get('last-event-id'),
    url.searchParams.get('after'),
  );
  if (cursor.kind === 'invalid') throw invalidCursor();
  const source = sourceOf();
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort(), { once: true });
  const scope = {
    workspaceId: person.workspaceId.toLowerCase(),
    channel: channel.name,
    key: key.data,
  };
  // The person is announced once the stream listens, so their own first heartbeat reaches it.
  const deliveries = channelDeliveries(
    source,
    scope,
    cursor.kind === 'after' ? cursor.id : null,
    abort.signal,
    () => {
      announcePresence(
        channel,
        { key: scope.key, workspaceId: scope.workspaceId, principalId: person.principalId },
        abort.signal,
      );
    },
  );
  return sseResponse(
    async (writer) => {
      try {
        for await (const delivery of deliveries) {
          if (writer.closed) return;
          const text = frameOf(delivery);
          if (text !== null) writer.write(text);
        }
      } finally {
        // However the stream ends, its presence heartbeats stop with it.
        abort.abort();
      }
    },
    // A failure closes the stream; the client resumes with `Last-Event-ID`.
    { onCancel: () => abort.abort() },
  );
}

/**
 * Defines the channel `name`, bound to `resource`.
 *
 * @throws {TypeError} when `name` is not a lower-case name of at most 63 characters, or `retain`
 *   is not a whole number from 1 to 100000.
 */
export function channel(name: string, options: ChannelOptions): Channel {
  if (!ChannelNameSchema.safeParse(name).success) {
    throw invalid(
      'the name must be lower-case letters, digits, "-" or "_", starting with a letter',
    );
  }
  const retain = options.retain ?? DEFAULT_RETAIN;
  if (!Number.isInteger(retain) || retain < 1 || retain > MAX_RETAIN) {
    throw invalid('retain must be a whole number from 1 to 100000');
  }
  const scopeOf = (
    event: ChannelPublish,
  ): Omit<ChannelScope, 'channel'> & {
    readonly type: string;
    readonly data: unknown;
  } => {
    const key = ChannelKeySchema.safeParse(event.key);
    if (!key.success) throw invalid(KEY_RULE);
    if (!ChannelEventTypeSchema.safeParse(event.type).success) {
      throw invalid('the type must be a name of letters, digits, ".", "-" or "_"');
    }
    if (!isJson(event.data)) throw invalid('the data must be a JSON value');
    return {
      workspaceId: (event.workspaceId ?? appRuntime().workspaceId).toLowerCase(),
      key: key.data,
      type: event.type,
      data: event.data,
    };
  };
  const defined: Channel = {
    name,
    resource: options.resource,
    keyField: options.key ?? 'id',
    retain,
    publish: async (tx, event) =>
      appRuntime().channelLog.append(tx, { ...scopeOf(event), channel: name }, retain),
    publishEphemeral: async (event) =>
      appRuntime().channelLog.notifyEphemeral({ ...scopeOf(event), channel: name }),
    subscribe: ({ workspaceId, key, after, signal }) => {
      if (!ChannelKeySchema.safeParse(key).success) throw invalid(KEY_RULE);
      return channelDeliveries(
        sourceOf(),
        { workspaceId: workspaceId.toLowerCase(), channel: name, key },
        after ?? null,
        signal,
      );
    },
    routes: () => ({
      GET: (request) => serveEvents(defined, request).catch(refusalOf),
    }),
  };
  return Object.freeze(defined);
}
