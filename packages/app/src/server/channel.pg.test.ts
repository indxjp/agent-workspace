/**
 * `channel()` against a real PostgreSQL (issue #1518): the conformance cases the in-memory twin
 * passes, plus what only PostgreSQL can show: a rolled-back publish is never delivered, and a
 * killed `LISTEN` connection still delivers within a second. Since issue #1519, a resource bound
 * to a channel publishes each write of its PostgreSQL store in the write's transaction.
 */
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { channelEventLogOf } from '../db/channel-events.js';
import { appSchemaName } from '../db/schema-name.js';
import { storeOf, type AppDatabase } from '../db/store.js';
import { ref, text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import {
  CHANNEL_ROOMS,
  describeChannelConformance,
  readChannel,
  WORKSPACE_A,
} from '../testing/channel-conformance.js';
import { fakePerson } from '../testing/fake-person.js';
import { createTestAppSchema, type TestAppSchema } from '../testing/pg-test-schema.js';
import { resetAppRuntimeForTests, setAppRuntimeForTests } from '../testing/runtime.js';
import { bindChannel, clearChannelBindings, publishBoundWrite } from './channel-bindings.js';
import { channel } from './channel.js';
import {
  CHANNEL_LISTENER_APPLICATION,
  createChannelListener,
  type ChannelListener,
} from './channel-listener.js';
import { replaceAppRuntime } from './runtime.js';

/** A room and its messages, keyed on the room: the shape `aw generate channel` binds. */
const chatRooms = defineResource({
  name: 'chat_room',
  fields: { title: text() },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
  audit: false,
});
const chatMessages = defineResource({
  name: 'chat_message',
  fields: { room: ref('chat_room'), body: text() },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
  audit: false,
});

const rawUrl = process.env['TEST_DATABASE_URL'];
const url = rawUrl === undefined || rawUrl.trim() === '' ? undefined : rawUrl;

if (url === undefined) {
  console.warn(
    '[server/channel.pg.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so channel() was NOT ' +
      'exercised against a real PostgreSQL LISTEN/NOTIFY. A green result without it says nothing ' +
      'about the PostgreSQL channel.',
  );
}

describe.skipIf(url === undefined)('channel() against real PostgreSQL', () => {
  let schema: TestAppSchema | undefined;
  let pool: pg.Pool | undefined;
  let listener: ChannelListener | undefined;
  const ready = (): { schema: TestAppSchema; pool: pg.Pool } => {
    if (schema === undefined || pool === undefined)
      throw new Error('the test schema was not created');
    return { schema, pool };
  };
  const db = (): AppDatabase => ready().schema.db;

  beforeAll(async () => {
    schema = await createTestAppSchema(url ?? '', [chatRooms, chatMessages]);
    pool = new pg.Pool({ connectionString: url, max: 2 });
    listener = createChannelListener(pool);
    const installed = setAppRuntimeForTests({ appName: schema.appName });
    const log = channelEventLogOf({ db: schema.db, appName: schema.appName });
    const current = listener;
    replaceAppRuntime({ ...installed, channelLog: log, channelListener: () => current });
  });

  afterAll(async () => {
    clearChannelBindings();
    resetAppRuntimeForTests();
    await listener?.close();
    await pool?.end();
    await schema?.drop();
  });

  describeChannelConformance('PostgreSQL', () => ({ tx: db }), { describe, it });

  it('never delivers a publish whose transaction rolled back', async () => {
    const subject = channel('chat', { resource: CHANNEL_ROOMS });
    const key = crypto.randomUUID();
    const reader = readChannel(subject, WORKSPACE_A, key);
    try {
      expect(await reader.quiet(100)).toBe(true);
      await db()
        .transaction(async (tx) => {
          await subject.publish(tx, { workspaceId: WORKSPACE_A, key, type: 'lost', data: {} });
          throw new Error('roll back');
        })
        .catch(() => undefined);
      await db().transaction(async (tx) => {
        await subject.publish(tx, { workspaceId: WORKSPACE_A, key, type: 'kept', data: {} });
      });
      const [delivery] = await reader.take(1, 1_000);
      expect(delivery).toMatchObject({ kind: 'event', type: 'kept' });
      expect(await reader.quiet(1_200)).toBe(true);
    } finally {
      reader.stop();
    }
  });

  it('notifies in the same statement as the insert, so a committed event is announced once', async () => {
    const subject = channel('chat', { resource: CHANNEL_ROOMS });
    const key = crypto.randomUUID();
    const reader = readChannel(subject, WORKSPACE_A, key);
    try {
      expect(await reader.quiet(100)).toBe(true);
      const record = await subject.publish(db(), {
        workspaceId: WORKSPACE_A,
        key,
        type: 'x',
        data: [1],
      });
      expect(record).toMatchObject({ key, type: 'x', data: [1] });
      expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      expect(await reader.take(1, 1_000)).toEqual([{ kind: 'event', ...record }]);
      expect(await reader.quiet(1_200)).toBe(true);
    } finally {
      reader.stop();
    }
  });

  it('still delivers within 1000 ms after the LISTEN connection is killed', async () => {
    const subject = channel('chat', { resource: CHANNEL_ROOMS });
    const key = crypto.randomUUID();
    const reader = readChannel(subject, WORKSPACE_A, key);
    try {
      expect(await reader.quiet(200)).toBe(true);
      const killed = await ready().pool.query<{ killed: boolean }>(
        'select pg_terminate_backend(pid) as killed from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()',
        [CHANNEL_LISTENER_APPLICATION],
      );
      expect(killed.rows.map((row) => row.killed)).toContain(true);
      const started = performance.now();
      await subject.publish(db(), { workspaceId: WORKSPACE_A, key, type: 'after-kill', data: {} });
      const [delivery] = await reader.take(1, 1_000);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(delivery).toMatchObject({ kind: 'event', type: 'after-kill' });
      // The listener is back: a later publish arrives too.
      await subject.publish(db(), { workspaceId: WORKSPACE_A, key, type: 'later', data: {} });
      expect(await reader.take(1, 1_000)).toMatchObject([{ type: 'later' }]);
    } finally {
      reader.stop();
    }
  });

  it('publishes a bound write in its transaction, and a publish that fails rolls the write back', async () => {
    const { db: database, appName } = ready().schema;
    const subject = channel('chat_message', { resource: chatRooms, key: 'room' });
    bindChannel(chatMessages, subject);
    const rooms = storeOf(chatRooms, { db: database, appName });
    const messages = storeOf(chatMessages, {
      db: database,
      appName,
      afterWrite: publishBoundWrite,
    });
    const person = fakePerson({ workspaceId: WORKSPACE_A, role: 'admin' });
    const room = await rooms.create(person, { title: 'general' });
    const reader = readChannel(subject, WORKSPACE_A, room.id);
    try {
      expect(await reader.quiet(100)).toBe(true);
      const created = await messages.create(person, { room: room.id, body: 'hello' });
      expect(await reader.take(1, 1_000)).toMatchObject([
        { kind: 'event', type: 'created', data: { id: created.id, body: 'hello', room: room.id } },
      ]);
      // A second channel keyed on the body refuses a key of over 200 characters, in the write.
      bindChannel(chatMessages, channel('chat_body', { resource: chatRooms, key: 'body' }));
      await expect(
        messages.create(person, { room: room.id, body: 'x'.repeat(201) }),
      ).rejects.toMatchObject({ code: 'internal_error' });
      expect((await messages.list(person)).items.map((item) => item.body)).toEqual(['hello']);
      // The first channel's event of that write rolled back with it.
      expect(await reader.quiet(1_200)).toBe(true);
    } finally {
      reader.stop();
      clearChannelBindings();
    }
  });

  it('prunes each key to retain in the table itself', async () => {
    const subject = channel('chat', { resource: CHANNEL_ROOMS, retain: 2 });
    const key = crypto.randomUUID();
    for (const type of ['a', 'b', 'c']) {
      await subject.publish(db(), { workspaceId: WORKSPACE_A, key, type, data: null });
    }
    const { rows } = await ready().schema.db.execute(
      sql.raw(
        `SELECT "type" FROM "${appSchemaName(ready().schema.appName)}"."app_channel_events" WHERE "key" = '${key}' ORDER BY "id"`,
      ),
    );
    expect(rows.map((row) => row['type'])).toEqual(['b', 'c']);
  });
});
