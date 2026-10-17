/**
 * Column conventions shared by every table in the schema.
 *
 * There is exactly one of these files and every table calls into it, so a convention is
 * changed in one place rather than in seven. The helpers deliberately return *fresh* column
 * builders on each call: a Drizzle column builder is mutable and carries the column it was
 * attached to, so a shared constant would alias one column object across every table.
 *
 * The rules these encode, stated once:
 *
 *   * Every table's primary key is a database-generated UUID. `gen_random_uuid()` is in core
 *     PostgreSQL from 13 onward, so this needs no extension on the Postgres 17 the project
 *     targets (spec §28). Application code never invents an id.
 *   * Every timestamp is `timestamptz`. A control plane that spans time zones has no use for
 *     `timestamp without time zone`, and mixing the two is how off-by-an-hour bugs start.
 *   * `updated_at` is bumped by Drizzle on every update it issues (`$onUpdate`). It is NOT
 *     maintained by a database trigger, so a hand-written `UPDATE` in psql will leave it stale.
 *     That is a deliberate trade — a trigger per table is more machinery than this buys — and
 *     it is recorded in docs/adr/W1-DB-01-schema-conventions.md.
 */
import { sql } from 'drizzle-orm';
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/** The primary key every table uses: `uuid PRIMARY KEY DEFAULT gen_random_uuid()`. */
export function primaryKeyId() {
  return uuid('id').primaryKey().defaultRandom();
}

/** `created_at timestamptz NOT NULL DEFAULT now()` — set by the database, never by the caller. */
export function createdAt() {
  return timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();
}

/**
 * `updated_at timestamptz NOT NULL DEFAULT now()`, bumped by Drizzle on update.
 * See the file header for what `$onUpdate` does and does not cover.
 */
export function updatedAt() {
  return timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`);
}

/**
 * `bytea` — raw bytes, read and written as a Node `Buffer`.
 *
 * `drizzle-orm@0.45.2` ships no `bytea` column builder: the directory
 * `drizzle-orm/pg-core/columns/` contains `bigint`, `boolean`, `char`, … and nothing named
 * `bytea`, `blob` or `binary`. `customType` is Drizzle's documented way to add one, and
 * `drizzle-kit generate` emits whatever `dataType()` returns, so the DDL says `bytea`.
 *
 * The `pg` driver already maps PostgreSQL's `bytea` to a `Buffer` in both directions, so no
 * `toDriver` / `fromDriver` conversion is declared here — declaring an identity conversion
 * would only add a place for the two directions to disagree.
 *
 * This exists for `secrets`, where the type is half the point: a column typed `bytea` cannot
 * be handed a plaintext string by a caller that has not thought about encoding, which is the
 * property spec §23 asks the storage layer to have.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});
