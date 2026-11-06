/**
 * `app_channel_events`: the durable events of an app's `channel()`s (issue #1518), in the app's
 * own schema, created by the app template's forward-only migration `0002_app_kit_channels`,
 * whose text is {@link createChannelEventsSql}.
 *
 * {@link channelEventLogOf} is the log over PostgreSQL. Its `append` inserts an event and calls
 * `pg_notify` in one statement, so in the caller's transaction: PostgreSQL delivers a notify only
 * when that transaction commits, so a row that rolled back is never announced. The statement first
 * takes a transaction-scoped advisory lock on the event's key, so the events of one key commit in
 * the order of their ids and a reader that has seen id `n` never misses a later commit below it.
 * Each append then prunes the key down to its newest `retain` events.
 *
 * A notification's payload is `<workspace>:<app>/<channel>:<id>` for a durable event, and
 * `<workspace>:<app>/<channel>:<json>` for an ephemeral one; both stay under PostgreSQL's 8000-byte
 * limit. The app name is part of the topic, so two apps sharing a database never hear each other.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { ChannelEphemeralPayloadSchema, type ChannelEphemeralPayload } from '../channel-wire.js';
import { quoted } from './columns.js';
import { appSchemaName } from './schema-name.js';
import type { AppSqlRunner } from './store.js';

/** The table's name, the same in every app schema. */
export const CHANNEL_EVENTS_TABLE = 'app_channel_events';

/** The one PostgreSQL notification channel every app's `channel()` notifies on. */
export const CHANNEL_NOTIFY = 'aw_channel';

/** PostgreSQL refuses a notification payload of 8000 bytes or more. */
const MAX_NOTIFY_BYTES = 7_999;

/**
 * The table as one deterministic SQL text, for the app template's `0002_app_kit_channels`
 * migration. It is idempotent, so applying it twice is harmless.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 */
export function createChannelEventsSql(appName: string): string {
  const table = `${quoted(appSchemaName(appName))}.${quoted(CHANNEL_EVENTS_TABLE)}`;
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    '  "id" bigserial PRIMARY KEY,',
    '  "workspace_id" uuid NOT NULL,',
    '  "channel" text NOT NULL,',
    '  "key" text NOT NULL,',
    '  "type" text NOT NULL,',
    '  "data" jsonb NOT NULL,',
    '  "at" timestamptz NOT NULL DEFAULT now()',
    ');',
    `CREATE INDEX IF NOT EXISTS "${CHANNEL_EVENTS_TABLE}_key_idx" ON ${table} ("workspace_id", "channel", "key", "id");`,
    '',
  ].join('\n');
}

/** Which events a read or a write is about: one key of one channel, in one workspace. */
export interface ChannelScope {
  readonly workspaceId: string;
  readonly channel: string;
  readonly key: string;
}

/** A durable event to append. */
export interface NewChannelEvent extends ChannelScope {
  readonly type: string;
  readonly data: unknown;
}

/** An ephemeral event: notified, never stored, with no id. */
export type EphemeralChannelEvent = NewChannelEvent;

/** One stored event; `id` is its decimal sequence, the stream's resume cursor. */
export interface ChannelEventRecord {
  readonly id: string;
  readonly key: string;
  readonly type: string;
  readonly data: unknown;
  /** When it was stored, as an ISO 8601 UTC timestamp. */
  readonly at: string;
}

/** The oldest and newest stored ids of a key. */
export interface ChannelBounds {
  readonly oldest: bigint;
  readonly latest: bigint;
}

/**
 * The durable side of an app's channels: {@link channelEventLogOf} over PostgreSQL, and
 * `memoryChannelHub` in `@indx-workspace/app/testing` in memory.
 */
export interface ChannelEventLog {
  /**
   * Stores `event` in `tx`, announces it on commit, and prunes its key to `retain` events, in one
   * function and `tx`.
   */
  append(tx: AppSqlRunner, event: NewChannelEvent, retain: number): Promise<ChannelEventRecord>;
  /** Announces `event` without storing it. */
  notifyEphemeral(event: EphemeralChannelEvent): Promise<void>;
  /** The key's oldest and newest ids, or `null` when it has none. */
  bounds(scope: ChannelScope): Promise<ChannelBounds | null>;
  /** The key's events after `after`, oldest first, at most `limit`. */
  after(scope: ChannelScope, after: bigint, limit: number): Promise<readonly ChannelEventRecord[]>;
}

/** The topic a channel's notifications travel under: `<workspace>:<app>/<channel>`. */
export function channelTopic(workspaceId: string, appName: string, channel: string): string {
  return `${workspaceId.toLowerCase()}:${appName}/${channel}`;
}

/** A notification, parsed. */
export type ChannelNotification =
  | { readonly kind: 'durable'; readonly topic: string; readonly id: bigint }
  | {
      readonly kind: 'ephemeral';
      readonly topic: string;
      readonly event: ChannelEphemeralPayload;
    };

const DURABLE_ID = /^\d{1,19}$/u;

/** The payload of an ephemeral notification, or a `RangeError` when it is 8000 bytes or more. */
export function ephemeralPayload(topic: string, event: ChannelEphemeralPayload): string {
  const payload = `${topic}:${JSON.stringify(event)}`;
  if (new TextEncoder().encode(payload).byteLength > MAX_NOTIFY_BYTES) {
    throw new RangeError('An ephemeral channel event must encode to fewer than 8000 bytes.');
  }
  return payload;
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A notification's payload, parsed; `null` for one that is not a channel's. */
export function parseChannelNotification(payload: string): ChannelNotification | null {
  const first = payload.indexOf(':');
  const second = first < 0 ? -1 : payload.indexOf(':', first + 1);
  if (second < 0) return null;
  const topic = payload.slice(0, second);
  const rest = payload.slice(second + 1);
  if (DURABLE_ID.test(rest)) return { kind: 'durable', topic, id: BigInt(rest) };
  const event = ChannelEphemeralPayloadSchema.safeParse(parsedJson(rest));
  return event.success ? { kind: 'ephemeral', topic, event: event.data } : null;
}

/** What {@link channelEventLogOf} takes. */
export interface ChannelEventLogOptions {
  /** The database ephemeral events are notified through and reads run on. */
  readonly db: AppSqlRunner;
  /** The app's name key; the table lives in the schema `app_<name>`. */
  readonly appName: string;
}

const RowSchema = z.object({
  id: z.string(),
  key: z.string(),
  type: z.string(),
  data: z.string(),
  at: z.string(),
});

function recordOf(row: Record<string, unknown> | undefined): ChannelEventRecord {
  const parsed = RowSchema.parse(row);
  return { ...parsed, data: JSON.parse(parsed.data) as unknown };
}

const ISO_AT = sql.raw(`to_char("at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

/**
 * The channel event log of `appName` over PostgreSQL.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 */
export function channelEventLogOf(options: ChannelEventLogOptions): ChannelEventLog {
  const { db, appName } = options;
  const table = sql.raw(`${quoted(appSchemaName(appName))}.${quoted(CHANNEL_EVENTS_TABLE)}`);
  const where = (scope: ChannelScope) =>
    sql`"workspace_id" = ${scope.workspaceId}::uuid AND "channel" = ${scope.channel} AND "key" = ${scope.key}`;
  const lockKey = (scope: ChannelScope): string =>
    `aw-channel:${appName}:${scope.workspaceId}:${scope.channel}:${scope.key}`;
  return {
    async append(tx, event, retain) {
      const topic = channelTopic(event.workspaceId, appName, event.channel);
      // One statement: the key's lock, the insert and its notify, which PostgreSQL sends on commit.
      const { rows } = await tx.execute(
        sql`WITH "locked" AS (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(event)}, 0))), "inserted" AS (INSERT INTO ${table} ("workspace_id", "channel", "key", "type", "data") SELECT ${event.workspaceId}::uuid, ${event.channel}, ${event.key}, ${event.type}, ${JSON.stringify(event.data ?? null)}::jsonb FROM "locked" RETURNING "id", "key", "type", "data", "at") SELECT "id"::text AS "id", "key", "type", "data"::text AS "data", ${ISO_AT} AS "at", pg_notify(${CHANNEL_NOTIFY}, ${topic} || ':' || "id"::text) AS "notified" FROM "inserted"`,
      );
      await tx.execute(
        sql`DELETE FROM ${table} WHERE ${where(event)} AND "id" <= (SELECT "id" FROM ${table} WHERE ${where(event)} ORDER BY "id" DESC OFFSET ${retain} LIMIT 1)`,
      );
      return recordOf(rows[0]);
    },
    async notifyEphemeral(event) {
      const topic = channelTopic(event.workspaceId, appName, event.channel);
      const payload = ephemeralPayload(topic, {
        key: event.key,
        type: event.type,
        data: event.data ?? null,
      });
      await db.execute(sql`SELECT pg_notify(${CHANNEL_NOTIFY}, ${payload})`);
    },
    async bounds(scope) {
      const { rows } = await db.execute(
        sql`SELECT min("id")::text AS "oldest", max("id")::text AS "latest" FROM ${table} WHERE ${where(scope)}`,
      );
      const row = rows[0];
      const oldest = row?.['oldest'];
      const latest = row?.['latest'];
      if (typeof oldest !== 'string' || typeof latest !== 'string') return null;
      return { oldest: BigInt(oldest), latest: BigInt(latest) };
    },
    async after(scope, after, limit) {
      const { rows } = await db.execute(
        sql`SELECT "id"::text AS "id", "key", "type", "data"::text AS "data", ${ISO_AT} AS "at" FROM ${table} WHERE ${where(scope)} AND "id" > ${after.toString()}::bigint ORDER BY "id" LIMIT ${limit}`,
      );
      return rows.map(recordOf);
    },
  };
}
