import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIGRATION_LOCK_KEY, resolveMigrationsDir, runMigrations } from './migrate.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './repositories/testing.js';

const PENDING_MIGRATIONS = 2;

/** A migrations directory holding every journal entry except the newest few. */
async function writePriorMigrations(
  migrationsDir: string,
): Promise<{ readonly dir: string; readonly total: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aw-migrate-lock-'));
  await mkdir(path.join(dir, 'meta'));
  const journal = JSON.parse(
    await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  const entries = journal.entries.slice(0, -PENDING_MIGRATIONS);
  await writeFile(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  await Promise.all(
    entries.map((entry) =>
      cp(path.join(migrationsDir, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`)),
    ),
  );
  return { dir, total: journal.entries.length };
}

async function countAdvisoryWaiters(client: pg.Client): Promise<number> {
  const waiting = await client.query<{ count: number }>(
    `select count(*)::int as count from pg_locks
      where locktype = 'advisory' and not granted
        and database = (select oid from pg_database where datname = current_database())`,
  );
  return waiting.rows[0]?.count ?? 0;
}

describe('runMigrations under concurrency', () => {
  const migrationsDir = resolveMigrationsDir();
  let priorDir: string;
  let total: number;
  let isolated: IsolatedTestDatabase;

  beforeEach(async () => {
    ({ dir: priorDir, total } = await writePriorMigrations(migrationsDir));
    isolated = await createIsolatedTestDatabase('aw_migrate_lock', undefined, priorDir);
  }, 180_000);

  afterEach(async () => {
    await isolated.close();
    await rm(priorDir, { recursive: true });
  });

  const config = (): { url: string; maxConnections: number } => ({
    url: isolated.url,
    maxConnections: 4,
  });

  async function ledgerCount(): Promise<number> {
    const result = await isolated.db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    return result.rows[0]?.count ?? -1;
  }

  it('applies the pending migrations once when two runs start together', async () => {
    expect(await ledgerCount()).toBe(total - PENDING_MIGRATIONS);

    const outcomes = await Promise.all([
      runMigrations(config(), migrationsDir),
      runMigrations(config(), migrationsDir),
    ]);

    expect(outcomes.map((outcome) => outcome.applied).toSorted((a, b) => a - b)).toEqual([
      0,
      PENDING_MIGRATIONS,
    ]);
    expect(outcomes.map((outcome) => outcome.ledgerTotal)).toEqual([total, total]);
    expect(await ledgerCount()).toBe(total);
  }, 180_000);

  it('makes every run wait for the lock holder, then lets exactly one apply and one no-op', async () => {
    const holder = new pg.Client({ connectionString: isolated.url });
    await holder.connect();
    try {
      await holder.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      // `allSettled` attaches a handler now, so a rejection while we poll is not unhandled.
      const settled = Promise.allSettled([
        runMigrations(config(), migrationsDir),
        runMigrations(config(), migrationsDir),
      ]);

      const deadline = Date.now() + 30_000;
      while ((await countAdvisoryWaiters(holder)) < 2) {
        if (Date.now() > deadline) throw new Error('both migrations did not queue on the lock');
        await delay(20);
      }
      expect(await ledgerCount()).toBe(total - PENDING_MIGRATIONS);

      await holder.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      const results = await settled;
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      const applied = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value.applied] : [],
      );

      expect(applied.toSorted((a, b) => a - b)).toEqual([0, PENDING_MIGRATIONS]);
      expect(await ledgerCount()).toBe(total);
    } finally {
      await holder.end();
    }
  }, 180_000);
});
