/**
 * `memoryChannelHub`: the in-memory twin of an app's channel events and its `LISTEN` connection
 * (issue #1518), so `channel()` publishes, streams, resumes and resets in a test, or in a fixture
 * on in-memory stores, without PostgreSQL. `setAppRuntimeForTests` installs one.
 *
 * Its semantics are the PostgreSQL log's: one id sequence across every key, each key pruned to its
 * newest `retain` events on publish, and a subscriber woken by each publish of its topic. It has no
 * transactions: the `tx` a publish is given is not used, and an event is delivered at once.
 */
import type { ChannelEphemeralPayload } from '../channel-wire.js';
import {
  channelTopic,
  ephemeralPayload,
  type ChannelEventLog,
  type ChannelEventRecord,
  type ChannelScope,
} from '../db/channel-events.js';
import { channelTopics, type ChannelListener } from '../server/channel-listener.js';

/** The twin's log and listener, and what a test reads back. */
export interface MemoryChannelHub extends ChannelEventLog, ChannelListener {
  /** The stored events of a key, oldest first. */
  stored(scope: ChannelScope): readonly ChannelEventRecord[];
  /** Every ephemeral event published, oldest first. */
  readonly ephemeral: readonly (ChannelEphemeralPayload & Omit<ChannelScope, 'key'>)[];
}

/** What {@link memoryChannelHub} may be told. */
export interface MemoryChannelHubOptions {
  /** `app` when not given: the topic's app, as the runtime's `appName`. */
  readonly appName?: string;
  /** The time an event is stamped with; the host's clock when not given. */
  readonly now?: () => Date;
}

const scopeKey = (scope: ChannelScope): string =>
  JSON.stringify([scope.workspaceId.toLowerCase(), scope.channel, scope.key]);

/** An empty in-memory channel hub. */
export function memoryChannelHub(options: MemoryChannelHubOptions = {}): MemoryChannelHub {
  const appName = options.appName ?? 'app';
  const now = options.now ?? (() => new Date());
  const topics = channelTopics();
  const events = new Map<string, ChannelEventRecord[]>();
  const ephemeral: (ChannelEphemeralPayload & Omit<ChannelScope, 'key'>)[] = [];
  let sequence = 0n;
  let closed = false;
  const topicOf = (scope: Omit<ChannelScope, 'key'>): string =>
    channelTopic(scope.workspaceId, appName, scope.channel);

  return {
    append(_tx, event, retain) {
      sequence += 1n;
      const record: ChannelEventRecord = Object.freeze({
        id: String(sequence),
        key: event.key,
        type: event.type,
        data: structuredClone(event.data ?? null),
        at: now().toISOString(),
      });
      const list = events.get(scopeKey(event)) ?? [];
      list.push(record);
      if (list.length > retain) list.splice(0, list.length - retain);
      events.set(scopeKey(event), list);
      if (!closed) topics.wake(topicOf(event));
      return Promise.resolve(record);
    },
    notifyEphemeral: (event) =>
      Promise.resolve().then(() => {
        const payload = {
          key: event.key,
          type: event.type,
          data: structuredClone(event.data ?? null),
        };
        // The PostgreSQL limit, kept here too: a payload of 8000 bytes or more is refused.
        ephemeralPayload(topicOf(event), payload);
        ephemeral.push({ ...payload, workspaceId: event.workspaceId, channel: event.channel });
        if (!closed) topics.ephemeral(topicOf(event), payload);
      }),
    bounds(scope) {
      const list = events.get(scopeKey(scope)) ?? [];
      const first = list[0];
      const last = list.at(-1);
      return Promise.resolve(
        first === undefined || last === undefined
          ? null
          : { oldest: BigInt(first.id), latest: BigInt(last.id) },
      );
    },
    after(scope, after, limit) {
      const list = events.get(scopeKey(scope)) ?? [];
      return Promise.resolve(list.filter((event) => BigInt(event.id) > after).slice(0, limit));
    },
    subscribe: (topic, subscriber) => topics.subscribe(topic, subscriber),
    close() {
      closed = true;
      return Promise.resolve();
    },
    stored: (scope) => [...(events.get(scopeKey(scope)) ?? [])],
    ephemeral,
  };
}
