/**
 * The migration entry point — `pnpm db:migrate`.
 *
 * R-15 §3 established the workflow this file implements, and three of its verified findings
 * are the reason it is not a one-liner:
 *
 *   1. **Deploy time is not `drizzle-kit`.** `migrate()` from `drizzle-orm/node-postgres/migrator`
 *      reads the committed `.sql` files. It needs no esbuild, no `drizzle.config.ts` and no
 *      TypeScript at runtime, so the runtime image never contains the 43 MB CLI.
 *   2. **Two concurrent migrators are not safe.** One wins and the other throws mid-DDL. The
 *      fix R-15 verified is a PostgreSQL advisory lock taken on a *dedicated* client — never
 *      on a connection borrowed from the pool `migrate()` will use, which deadlocks forever.
 *   3. **An out-of-order migration is skipped silently, with exit code 0.** `migrate()`
 *      compares each migration against a single high-water `created_at`, so a migration
 *      authored before one already applied is never run and never reported, and
 *      `drizzle-kit check` prints "Everything's fine". The only cheap detector is the count
 *      assertion at the end of {@link runMigrations}: the ledger must hold exactly as many
 *      rows as the journal has entries.
 *
 * That last check is the reason this file exists at all rather than a two-line script. It is
 * also written the way ADR-0015 requires: it fails when it cannot run. A journal that is
 * missing, unreadable, or not the shape it claims is an error, not a skipped assertion — an
 * absent input is not an absent risk.
 *
 * **Contributor rule (R-15 §3):** a migration whose `when` predates one already applied is lost
 * silently. When main gained a migration since your branch generated one, run
 * `pnpm migrations:renumber` during `git merge origin/main`: it moves your migrations after
 * main's with a strictly later `when` (scripts/migrations.mjs). `pnpm migrations:check` in
 * fast-checks rejects a journal that would skip one.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { z } from 'zod';

import {
  connect,
  readDatabaseConfig,
  reportDatabaseConnectionErrors,
  type DatabaseConfig,
} from './client.js';

/**
 * Advisory lock id. Any constant works as long as every migrator in the deployment uses the
 * same one; it is namespaced only by the database it is taken in.
 */
export const MIGRATION_LOCK_KEY = 4_242_424_242;

/** Drizzle's own ledger, created by `migrate()` itself. Defaults, stated so the query can be read. */
const LEDGER_SCHEMA = 'drizzle';
const LEDGER_TABLE = '__drizzle_migrations';

/**
 * The shape of `migrations/meta/_journal.json`, as verified in R-15 §3. Only the fields this
 * file relies on are described; unknown keys are tolerated because the journal is Drizzle's
 * file, not ours, and it may gain fields.
 */
const MigrationJournal = z.object({
  entries: z.array(z.object({ idx: z.number().int(), tag: z.string().min(1) })).min(1),
});

/**
 * Absolute path of `migrations/`, spec §29's repository-root directory.
 *
 * Resolved from this module rather than from `process.cwd()`, so the migrator works the same
 * whether it is run by `pnpm db:migrate` from the repository root, by a test from
 * `packages/core`, or by a container whose working directory is anyone's guess. `MIGRATIONS_DIR`
 * overrides it for an image that copies the directory somewhere else.
 */
export function resolveMigrationsDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env['MIGRATIONS_DIR'];
  if (override !== undefined && override.trim() !== '') return path.resolve(override.trim());
  // …/packages/core/{src,dist}/db/migrate.{ts,js} → four levels up is the repository root, and
  // the layout is the same compiled or not.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..', 'migrations');
}

/**
 * Read and validate the journal. Throws — naming the file and the reason — if it is missing,
 * unreadable, not JSON, or not the expected shape.
 */
export function readMigrationJournal(migrationsDir: string): { entries: { tag: string }[] } {
  const journalPath = path.join(migrationsDir, 'meta', '_journal.json');
  let raw: string;
  try {
    raw = readFileSync(journalPath, 'utf8');
  } catch (cause) {
    throw new Error(
      `Cannot read the migration journal at ${journalPath}. Without it the drift check cannot ` +
        'run, and a check that cannot run must fail rather than pass. Run `pnpm db:generate`.',
      { cause },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`The migration journal at ${journalPath} is not valid JSON.`, { cause });
  }
  const result = MigrationJournal.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `The migration journal at ${journalPath} is not the expected shape: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * How many migrations the ledger records, or `null` when the ledger table does not exist yet —
 * which is the state of a database that has never been migrated.
 *
 * The absence is established positively, with `to_regclass`, rather than by catching an error
 * from the count and assuming it meant "no table". A caught error could equally mean the
 * connection died or the role lacks permission, and ADR-0015 forbids reading either of those as
 * a clean zero.
 */
async function readLedgerCount(db: ReturnType<typeof connect>['db']): Promise<number | null> {
  const qualified = `${LEDGER_SCHEMA}.${LEDGER_TABLE}`;
  const exists = await db.execute<{ present: boolean }>(
    sql`select to_regclass(${qualified}) is not null as present`,
  );
  const existsRow = exists.rows[0];
  if (existsRow === undefined || typeof existsRow.present !== 'boolean') {
    throw new Error(
      `Could not establish whether ${qualified} exists. The drift check cannot run, so this ` +
        'migration is reported as failed.',
    );
  }
  if (!existsRow.present) return null;

  const result = await db.execute<{ applied: number }>(
    sql`select count(*)::int as applied from ${sql.identifier(LEDGER_SCHEMA)}.${sql.identifier(LEDGER_TABLE)}`,
  );
  const row = result.rows[0];
  if (row === undefined || typeof row.applied !== 'number' || !Number.isInteger(row.applied)) {
    throw new Error(
      `Could not read a migration count from ${qualified}. The drift check cannot run, so this ` +
        'migration is reported as failed.',
    );
  }
  return row.applied;
}

/** What one `runMigrations` call did, and what the database holds afterwards. */
export interface MigrationOutcome {
  /**
   * How many migrations THIS invocation applied. Zero on a re-run against an up-to-date
   * database — which is what makes a second `pnpm db:migrate` visibly a no-op rather than
   * merely printing the same total twice.
   */
  readonly applied: number;
  /** How many migrations the ledger records in total afterwards. */
  readonly ledgerTotal: number;
}

/**
 * Apply every pending migration under an advisory lock, then assert no migration was skipped.
 *
 * @returns what this invocation applied and what the ledger holds afterwards.
 */
export async function runMigrations(
  config: DatabaseConfig = readDatabaseConfig(),
  migrationsDir: string = resolveMigrationsDir(),
): Promise<MigrationOutcome> {
  // Read and validate the journal FIRST: if the drift check could not run afterwards, there is
  // no point taking a lock and mutating the schema.
  const journal = readMigrationJournal(migrationsDir);

  // The lock lives on its own client. R-15 verified that a pool which is itself holding the
  // advisory lock deadlocks `migrate()` indefinitely.
  const lockClient = new pg.Client({ connectionString: config.url });
  reportDatabaseConnectionErrors(lockClient);
  await lockClient.connect();
  const { pool, db } = connect(config);
  try {
    await lockClient.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    // Read the ledger before and after so the caller can report what THIS run did. A database
    // that has never been migrated has no ledger table at all, which is not an error here.
    const before = (await readLedgerCount(db)) ?? 0;
    await migrate(db, { migrationsFolder: migrationsDir });

    const ledgerTotal = await readLedgerCount(db);
    if (ledgerTotal === null) {
      throw new Error(
        `${LEDGER_SCHEMA}.${LEDGER_TABLE} does not exist after migrating. The drift check ` +
          'cannot run, so this migration is reported as failed.',
      );
    }
    if (ledgerTotal !== journal.entries.length) {
      throw new Error(
        `Migration drift: ${migrationsDir}/meta/_journal.json lists ${String(journal.entries.length)} ` +
          `migration(s) but the database has applied ${String(ledgerTotal)}. This is the silent ` +
          'out-of-order skip described in the storage research note: a migration whose ' +
          '`when` predates one already applied is never run. Re-generate the lost migration with ' +
          '`pnpm db:generate` so it gets a fresh timestamp; this check will keep failing until you do.',
      );
    }
    return { applied: ledgerTotal - before, ledgerTotal };
  } finally {
    await lockClient
      .query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    await lockClient.end();
    await pool.end();
  }
}

/** CLI entry point. Only runs when this module is the process entry, so tests may import it. */
async function main(): Promise<void> {
  const migrationsDir = resolveMigrationsDir();
  const outcome = await runMigrations(readDatabaseConfig(), migrationsDir);
  // Two numbers, because one cannot say both things. `applied` is what this run did — zero on a
  // no-op re-run — and `ledgerTotal` is what the database now holds. The previous single number
  // was the ledger total labelled "applied", which made an idempotent second run read as though
  // it had applied a migration again.
  console.log(
    `db:migrate — applied ${String(outcome.applied)} migration(s) this run; the ledger now ` +
      `records ${String(outcome.ledgerTotal)}, from ${migrationsDir}`,
  );
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  await main();
}
