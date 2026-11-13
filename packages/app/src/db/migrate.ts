/**
 * `migrateApp`: applies an app's committed migrations to its own schema `app_<name>` (issue
 * #1502), with the platform migrator's two safeguards (the platform's `db:migrate` runner):
 *
 * 1. An advisory lock, held by the one client that applies the migrations, so two deployments
 *    starting at once apply each migration once. The key is the app's schema, so two apps migrate
 *    side by side.
 * 2. A ledger count: like Drizzle's `migrate()`, a migration older than the newest one applied is
 *    skipped, so afterwards the ledger must hold exactly as many rows as the journal lists.
 *
 * It runs as the role that owns the app's schema and needs no privilege on the database: it never
 * creates an extension (`gen_random_uuid()` is built into PostgreSQL 13 and later), and it runs
 * `CREATE SCHEMA` only when the schema is missing, since PostgreSQL checks the database's `CREATE`
 * privilege before it looks at `IF NOT EXISTS`. That is also why the migrations are applied here,
 * with Drizzle's `readMigrationFiles` and Drizzle's ledger layout, and not by Drizzle's `migrate()`,
 * which always runs `CREATE SCHEMA IF NOT EXISTS` for its ledger's schema.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';
import { z } from 'zod';

import { appSchemaName } from './schema-name.js';

/** The ledger table Drizzle keeps in the app's schema. */
export const APP_MIGRATIONS_TABLE = '__app_migrations';

/** What {@link migrateApp} takes. */
export interface MigrateAppOptions {
  /** A `postgres://` connection string of the schema owner. */
  readonly url: string;
  readonly appName: string;
  /** The folder holding the `.sql` migrations and `meta/_journal.json`. */
  readonly migrationsFolder: string;
}

/** What one {@link migrateApp} call did. */
export interface AppMigrationOutcome {
  /** How many migrations this call applied: zero when the schema was up to date. */
  readonly applied: number;
  /** How many the ledger records afterwards. */
  readonly ledgerTotal: number;
}

const JournalSchema = z.object({
  entries: z.array(z.object({ idx: z.number().int(), tag: z.string().min(1) })).min(1),
});

/** The journal's entry count; a journal that is missing or malformed fails the migration. */
async function journalLength(migrationsFolder: string): Promise<number> {
  const file = path.join(migrationsFolder, 'meta', '_journal.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (cause) {
    throw new Error(`Cannot read the app migration journal at ${file}.`, { cause });
  }
  const journal = JournalSchema.safeParse(parsed);
  if (!journal.success) {
    throw new Error(`The app migration journal at ${file} is not the expected shape.`);
  }
  return journal.data.entries.length;
}

async function ledgerCount(client: pg.Client, schema: string): Promise<number> {
  const present = await client.query<{ present: boolean }>(
    'select to_regclass($1) is not null as present',
    [`"${schema}"."${APP_MIGRATIONS_TABLE}"`],
  );
  if (present.rows[0]?.present !== true) return 0;
  const counted = await client.query<{ applied: number }>(
    `SELECT count(*)::int AS applied FROM "${schema}"."${APP_MIGRATIONS_TABLE}"`,
  );
  const applied = counted.rows[0]?.applied;
  if (typeof applied !== 'number') {
    throw new Error(`Could not count the migrations recorded in ${schema}.`);
  }
  return applied;
}

/** Creates `schema` only when it is missing: `IF NOT EXISTS` would need `CREATE` on the database. */
async function ensureSchema(client: pg.Client, schema: string): Promise<void> {
  const found = await client.query<{ present: boolean }>(
    'select to_regnamespace($1) is not null as present',
    [`"${schema}"`],
  );
  if (found.rows[0]?.present !== true) await client.query(`CREATE SCHEMA "${schema}"`);
}

/**
 * Applies every migration newer than the newest one the ledger records, in one transaction, and
 * records each: the ledger layout and the rule of Drizzle's `migrate()`, without its `CREATE SCHEMA`.
 */
async function applyPending(
  client: pg.Client,
  schema: string,
  migrationsFolder: string,
): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const ledger = `"${schema}"."${APP_MIGRATIONS_TABLE}"`;
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${ledger} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
  );
  const last = await client.query<{ created_at: string | null }>(
    `SELECT created_at FROM ${ledger} ORDER BY created_at DESC LIMIT 1`,
  );
  const lastRow = last.rows[0];
  const newest = lastRow === undefined ? undefined : Number(lastRow.created_at);
  await client.query('BEGIN');
  try {
    for (const migration of migrations) {
      if (newest !== undefined && newest >= migration.folderMillis) continue;
      for (const statement of migration.sql) await client.query(statement);
      await client.query(`INSERT INTO ${ledger} ("hash", "created_at") VALUES ($1, $2)`, [
        migration.hash,
        migration.folderMillis,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * Creates the schema of `appName` when missing, then applies every pending migration in
 * `migrationsFolder` under the app's advisory lock, recording them in
 * `app_<name>.__app_migrations`.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 * @throws {Error} when the journal is unreadable, or the ledger and the journal disagree after the
 *   run (a migration was skipped).
 */
export async function migrateApp(options: MigrateAppOptions): Promise<AppMigrationOutcome> {
  const schema = appSchemaName(options.appName);
  const expected = await journalLength(options.migrationsFolder);
  const lockKey = `aw-app-migrate:${schema}`;
  const failures: unknown[] = [];
  // A dropped connection is an `error` event; it fails this run instead of the process.
  const lock = new pg.Client({ connectionString: options.url });
  lock.on('error', (error) => failures.push(error));
  let locked = false;
  let outcome: AppMigrationOutcome | undefined;
  try {
    await lock.connect();
    await lock.query('select pg_advisory_lock(hashtext($1))', [lockKey]);
    locked = true;
    await ensureSchema(lock, schema);
    const before = await ledgerCount(lock, schema);
    await applyPending(lock, schema, options.migrationsFolder);
    const ledgerTotal = await ledgerCount(lock, schema);
    if (ledgerTotal !== expected) {
      throw new Error(
        `App migration drift in ${schema}: the journal lists ${String(expected)} migration(s) but ` +
          `the ledger records ${String(ledgerTotal)}. A migration older than one already applied ` +
          'was skipped; give it a later timestamp.',
      );
    }
    outcome = { applied: ledgerTotal - before, ledgerTotal };
  } catch (error) {
    failures.push(error);
  } finally {
    if (locked) {
      await lock
        .query('select pg_advisory_unlock(hashtext($1))', [lockKey])
        .catch((error: unknown) => failures.push(error));
    }
    await lock.end().catch((error: unknown) => failures.push(error));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `Migrating ${schema} failed.`);
  if (outcome === undefined) throw new Error(`Migrating ${schema} reported no outcome.`);
  return outcome;
}
