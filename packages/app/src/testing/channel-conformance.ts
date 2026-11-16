/**
 * The behaviour every channel backend owes `channel()` (issue #1518): the PostgreSQL log and
 * listener, and their in-memory twin `memoryChannelHub`, both pass these cases. Like the store
 * conformance suite, it is handed the runner's `describe` and `it` and asserts with `node:assert`.
 * For this package's tests only; not exported.
 */
import assert from 'node:assert/strict';

import type { AppSqlRunner } from '../db/store.js';
import { text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import { channel, type Channel, type ChannelDelivery } from '../server/channel.js';
import type { TestRunner } from './conformance.js';

/** The resource the conformance channels are bound to. */
export const CHANNEL_ROOMS = defineResource({
  name: 'room',
  fields: { title: text() },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
});

export const WORKSPACE_A = '00000000-0000-4000-8000-00000000000a';
const WORKSPACE_B = '00000000-0000-4000-8000-00000000000b';

/** What the cases run on: a runtime is installed, and `tx` is what a publish is given. */
export interface ChannelConformanceEnvironment {
  readonly tx: () => AppSqlRunner;
}

/** A subscription read into a buffer, so a case can wait for deliveries with a deadline. */
export interface ChannelReader {
  /** The next `count` deliveries, or a failure once `ms` pass without them. */
  take(count: number, ms?: number): Promise<ChannelDelivery[]>;
  /** Whether nothing more arrives within `ms`. */
  quiet(ms: number): Promise<boolean>;
  stop(): void;
}

/** Subscribes to `key` of `subject` in `workspaceId` and reads it into a buffer. */
export function readChannel(
  subject: Channel,
  workspaceId: string,
  key: string,
  after: bigint | null = null,
): ChannelReader {
  const abort = new AbortController();
  const buffer: ChannelDelivery[] = [];
  const waiting: { notify: (() => void) | null } = { notify: null };
  void (async () => {
    for await (const delivery of subject.subscribe({
      workspaceId,
      key,
      after,
      signal: abort.signal,
    })) {
      buffer.push(delivery);
      waiting.notify?.();
    }
  })();
  const until = (ready: () => boolean, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (ready()) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        waiting.notify = null;
        resolve(false);
      }, ms);
      waiting.notify = () => {
        if (!ready()) return;
        clearTimeout(timer);
        waiting.notify = null;
        resolve(true);
      };
    });
  return {
    async take(count, ms = 2_000) {
      if (!(await until(() => buffer.length >= count, ms))) {
        throw new Error(`expected ${String(count)} deliveries, got ${String(buffer.length)}`);
      }
      return buffer.splice(0, count);
    },
    async quiet(ms) {
      return !(await until(() => buffer.length > 0, ms));
    },
    stop: () => abort.abort(),
  };
}

const typesOf = (deliveries: readonly ChannelDelivery[]): string[] =>
  deliveries.map((delivery) =>
    delivery.kind === 'reset' ? 'reset' : `${delivery.kind}:${delivery.type}`,
  );

/** Registers the conformance cases; `environment` is read inside each case. */
export function describeChannelConformance(
  label: string,
  environment: () => ChannelConformanceEnvironment,
  runner: TestRunner,
): void {
  const key = (): string => crypto.randomUUID();
  const publish = (subject: Channel, workspaceId: string, k: string, type: string) =>
    subject.publish(environment().tx(), { workspaceId, key: k, type, data: { type } });

  runner.describe(`${label}: channel() conformance`, () => {
    runner.it('delivers a publish to two subscribers in under 1000 ms', async () => {
      const subject = channel('chat', { resource: CHANNEL_ROOMS });
      const k = key();
      const first = readChannel(subject, WORKSPACE_A, k);
      const second = readChannel(subject, WORKSPACE_A, k);
      try {
        assert.equal(await first.quiet(100), true);
        assert.equal(await second.quiet(1), true);
        const started = performance.now();
        await publish(subject, WORKSPACE_A, k, 'created');
        const [a, b] = await Promise.all([first.take(1, 1_000), second.take(1, 1_000)]);
        assert.ok(performance.now() - started < 1_000);
        assert.deepEqual(typesOf([...a, ...b]), ['event:created', 'event:created']);
        assert.deepEqual(a[0], b[0]);
      } finally {
        first.stop();
        second.stop();
      }
    });

    runner.it('resumes after a cursor with exactly the events it missed', async () => {
      const subject = channel('chat', { resource: CHANNEL_ROOMS });
      const k = key();
      const records = [];
      for (const type of ['one', 'two', 'three'])
        records.push(await publish(subject, WORKSPACE_A, k, type));
      const seen = records[0]?.id ?? '0';
      for (const type of ['four', 'five']) await publish(subject, WORKSPACE_A, k, type);
      const reader = readChannel(subject, WORKSPACE_A, k, BigInt(seen));
      try {
        assert.deepEqual(typesOf(await reader.take(4)), [
          'event:two',
          'event:three',
          'event:four',
          'event:five',
        ]);
        assert.equal(await reader.quiet(150), true);
        await publish(subject, WORKSPACE_A, k, 'six');
        assert.deepEqual(typesOf(await reader.take(1)), ['event:six']);
      } finally {
        reader.stop();
      }
    });

    runner.it(
      'starts at the oldest retained event without a cursor, and keeps `retain` per key',
      async () => {
        const subject = channel('chat', { resource: CHANNEL_ROOMS, retain: 3 });
        const k = key();
        for (const type of ['a', 'b', 'c', 'd', 'e']) await publish(subject, WORKSPACE_A, k, type);
        const reader = readChannel(subject, WORKSPACE_A, k);
        try {
          assert.deepEqual(typesOf(await reader.take(3)), ['event:c', 'event:d', 'event:e']);
          assert.equal(await reader.quiet(150), true);
        } finally {
          reader.stop();
        }
      },
    );

    runner.it(
      'answers a cursor older than `retain` with stream-reset, then the retained events',
      async () => {
        const subject = channel('chat', { resource: CHANNEL_ROOMS, retain: 2 });
        const k = key();
        const first = await publish(subject, WORKSPACE_A, k, 'a');
        for (const type of ['b', 'c', 'd']) await publish(subject, WORKSPACE_A, k, type);
        const reader = readChannel(subject, WORKSPACE_A, k, BigInt(first.id));
        try {
          const [reset, ...events] = await reader.take(3);
          assert.equal(reset?.kind, 'reset');
          assert.deepEqual(typesOf(events), ['event:c', 'event:d']);
          const oldest = events[0]?.kind === 'event' ? BigInt(events[0].id) : 0n;
          assert.equal(
            reset?.kind === 'reset' ? reset.resumedAfter : undefined,
            String(oldest - 1n),
          );
        } finally {
          reader.stop();
        }
      },
    );

    runner.it('answers a cursor beyond the latest event with stream-reset', async () => {
      const subject = channel('chat', { resource: CHANNEL_ROOMS });
      const k = key();
      const only = await publish(subject, WORKSPACE_A, k, 'a');
      const reader = readChannel(subject, WORKSPACE_A, k, BigInt(only.id) + 1_000n);
      const empty = readChannel(subject, WORKSPACE_A, key(), 5n);
      try {
        assert.deepEqual(typesOf(await reader.take(2)), ['reset', 'event:a']);
        const [reset] = await empty.take(1);
        assert.equal(reset?.kind === 'reset' ? reset.resumedAfter : undefined, null);
      } finally {
        reader.stop();
        empty.stop();
      }
    });

    runner.it("never shows workspace B another workspace's events", async () => {
      const subject = channel('chat', { resource: CHANNEL_ROOMS });
      const k = key();
      const b = readChannel(subject, WORKSPACE_B, k);
      try {
        assert.equal(await b.quiet(100), true);
        await publish(subject, WORKSPACE_A, k, 'secret');
        await subject.publishEphemeral({
          workspaceId: WORKSPACE_A,
          key: k,
          type: 'typing',
          data: {},
        });
        await publish(subject, WORKSPACE_B, k, 'mine');
        assert.deepEqual(typesOf(await b.take(1)), ['event:mine']);
        assert.equal(await b.quiet(150), true);
      } finally {
        b.stop();
      }
    });

    runner.it('delivers an ephemeral event to its key only, and stores nothing', async () => {
      const subject = channel('chat', { resource: CHANNEL_ROOMS });
      const k = key();
      const mine = readChannel(subject, WORKSPACE_A, k);
      const other = readChannel(subject, WORKSPACE_A, key());
      try {
        assert.equal(await mine.quiet(100), true);
        await subject.publishEphemeral({
          workspaceId: WORKSPACE_A,
          key: k,
          type: 'presence',
          data: { online: true },
        });
        const [delivery] = await mine.take(1, 1_000);
        assert.deepEqual(delivery, {
          kind: 'ephemeral',
          key: k,
          type: 'presence',
          data: { online: true },
        });
        assert.equal(await other.quiet(150), true);
      } finally {
        mine.stop();
        other.stop();
      }
      const late = readChannel(subject, WORKSPACE_A, k);
      try {
        assert.equal(await late.quiet(150), true);
      } finally {
        late.stop();
      }
    });

    runner.it('refuses a malformed publish before it reaches the log', async () => {
      const subject = channel('chat', { resource: CHANNEL_ROOMS });
      const tx = environment().tx();
      await assert.rejects(
        subject.publish(tx, { workspaceId: WORKSPACE_A, key: 'a:b', type: 'x', data: 1 }),
        TypeError,
      );
      await assert.rejects(
        subject.publish(tx, { workspaceId: WORKSPACE_A, key: 'k', type: 'error event', data: 1 }),
        TypeError,
      );
      await assert.rejects(
        subject.publish(tx, { workspaceId: WORKSPACE_A, key: 'k', type: 'x', data: 1n }),
        TypeError,
      );
    });
  });
}
