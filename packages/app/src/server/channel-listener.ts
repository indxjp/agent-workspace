/**
 * The one `LISTEN` connection of a process (issue #1518): it hears every `channel()`
 * notification and wakes the streams subscribed to its topic, in memory.
 *
 * - It owns one dedicated `pg.Client` (never one of the pool's), connected on the first subscribe.
 * - On `error` or `end` it reconnects with a backoff from 250 ms doubling to 5 s, and wakes every
 *   subscriber, both when it drops and when it is back, so each re-reads what it may have missed.
 * - A 1000 ms fallback poll wakes every subscriber too, so a notification lost any other way is
 *   still delivered within a second.
 *
 * A subscriber registers before it reads its backlog, so a notification between the read and the
 * wait is never lost: it wakes a read that is already pending.
 */
// shortcut: one PostgreSQL primary; swap the listener behind channel() when a deployment outgrows it
import pg from 'pg';

import type { ChannelEphemeralPayload } from '../channel-wire.js';
import { CHANNEL_NOTIFY, parseChannelNotification } from '../db/channel-events.js';

/** A stream waiting on a topic. */
export interface ChannelSubscriber {
  /** Something may have been stored: read again. */
  wake(): void;
  /** An ephemeral event of the topic arrived. */
  ephemeral(event: ChannelEphemeralPayload): void;
}

/** What delivers a topic's notifications to the streams that wait on it. */
export interface ChannelListener {
  /** Registers `subscriber` for `topic`; the returned function removes it. */
  subscribe(topic: string, subscriber: ChannelSubscriber): () => void;
  /** Stops listening and polling; nothing is delivered afterwards. */
  close(): Promise<void>;
}

/** The listener's timings; each has the default the module documents. */
export interface ChannelListenerOptions {
  /** 1000 ms. */
  readonly pollMs?: number;
  /** 250 ms. */
  readonly minBackoffMs?: number;
  /** 5000 ms. */
  readonly maxBackoffMs?: number;
}

/** The `application_name` of the listener's connection, as `pg_stat_activity` shows it. */
export const CHANNEL_LISTENER_APPLICATION = 'aw-app-channel-listener';

const unref = (timer: ReturnType<typeof setTimeout>): void => {
  (timer as { unref?: () => void }).unref?.();
};

/** The topic registry the listener and its in-memory twin share. */
export interface ChannelTopics {
  subscribe(topic: string, subscriber: ChannelSubscriber): () => void;
  /** Wakes every subscriber of `topic`. */
  wake(topic: string): void;
  /** Wakes every subscriber of every topic. */
  wakeAll(): void;
  /** Hands `event` to every subscriber of `topic`. */
  ephemeral(topic: string, event: ChannelEphemeralPayload): void;
  readonly size: number;
}

/** An empty topic registry: `Map<topic, Set<subscriber>>`. */
export function channelTopics(): ChannelTopics {
  const topics = new Map<string, Set<ChannelSubscriber>>();
  const each = (topic: string, visit: (subscriber: ChannelSubscriber) => void): void => {
    for (const subscriber of topics.get(topic) ?? []) visit(subscriber);
  };
  return {
    subscribe(topic, subscriber) {
      const set = topics.get(topic) ?? new Set<ChannelSubscriber>();
      set.add(subscriber);
      topics.set(topic, set);
      return () => {
        set.delete(subscriber);
        if (set.size === 0 && topics.get(topic) === set) topics.delete(topic);
      };
    },
    wake: (topic) => each(topic, (subscriber) => subscriber.wake()),
    wakeAll() {
      for (const topic of topics.keys()) each(topic, (subscriber) => subscriber.wake());
    },
    ephemeral: (topic, event) => each(topic, (subscriber) => subscriber.ephemeral(event)),
    get size() {
      return topics.size;
    },
  };
}

/**
 * The listener of the database `pool` connects to. Its connection uses the pool's settings and
 * is not taken from the pool.
 */
export function createChannelListener(
  pool: pg.Pool,
  options: ChannelListenerOptions = {},
): ChannelListener {
  const pollMs = options.pollMs ?? 1_000;
  const minBackoffMs = options.minBackoffMs ?? 250;
  const maxBackoffMs = options.maxBackoffMs ?? 5_000;
  const topics = channelTopics();
  let current: pg.Client | null = null;
  let backoffMs = minBackoffMs;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const onNotification = (message: pg.Notification): void => {
    if (message.channel !== CHANNEL_NOTIFY || message.payload === undefined) return;
    const parsed = parseChannelNotification(message.payload);
    if (parsed === null) return;
    if (parsed.kind === 'durable') topics.wake(parsed.topic);
    else topics.ephemeral(parsed.topic, parsed.event);
  };

  const scheduleReconnect = (): void => {
    if (closed || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, backoffMs);
    unref(retry);
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
  };

  const drop = (client: pg.Client): void => {
    if (current !== client) return;
    current = null;
    client.end().catch(() => undefined);
    // Whatever was notified while the connection was failing is read again.
    topics.wakeAll();
    scheduleReconnect();
  };

  async function connect(): Promise<void> {
    if (closed || current !== null) return;
    const client = new pg.Client({
      ...pool.options,
      application_name: CHANNEL_LISTENER_APPLICATION,
    });
    current = client;
    client.on('notification', onNotification);
    // A failed connection is an `error` event; it must reconnect, never end the process.
    client.on('error', () => drop(client));
    client.on('end', () => drop(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL_NOTIFY}`);
      if (current !== client) return;
      backoffMs = minBackoffMs;
      // Whatever was stored before the `LISTEN` took effect is read again.
      topics.wakeAll();
    } catch {
      drop(client);
    }
  }

  const start = (): void => {
    if (closed) return;
    if (poll === undefined) {
      poll = setInterval(() => topics.wakeAll(), pollMs);
      unref(poll);
    }
    if (current === null && retry === undefined) void connect();
  };

  return {
    subscribe(topic, subscriber) {
      const unsubscribe = topics.subscribe(topic, subscriber);
      start();
      return unsubscribe;
    },
    async close() {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      if (poll !== undefined) clearInterval(poll);
      const client = current;
      current = null;
      await client?.end().catch(() => undefined);
    },
  };
}
