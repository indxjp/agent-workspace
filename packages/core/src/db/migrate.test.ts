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
  pending = PENDING_MIGRATIONS,
): Promise<{ readonly dir: string; readonly total: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aw-migrate-lock-'));
  await mkdir(path.join(dir, 'meta'));
  const journal = JSON.parse(
    await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  const entries = journal.entries.slice(0, -pending);
  await writeFile(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  await Promise.all(
    entries.map((entry) =>
      cp(path.join(migrationsDir, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`)),
    ),
  );
  return { dir, total: journal.entries.length };
}

/** How many journal entries the legacy storage guard and the migrations after it make up. */
async function guardAndLater(migrationsDir: string): Promise<number> {
  const journal = JSON.parse(
    await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  // By suffix: `pnpm migrations:renumber` may change the number.
  const guard = journal.entries.findIndex((entry) => entry.tag.endsWith('_lively_nomad'));
  if (guard < 0) throw new Error('the legacy storage guard migration is missing');
  return journal.entries.length - guard;
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

// @story US-STO-13
describe('the legacy storage guard', () => {
  const migrationsDir = resolveMigrationsDir();
  let priorDir: string;
  let total: number;
  let pending: number;
  let isolated: IsolatedTestDatabase;

  beforeEach(async () => {
    pending = await guardAndLater(migrationsDir);
    ({ dir: priorDir, total } = await writePriorMigrations(migrationsDir, pending));
    isolated = await createIsolatedTestDatabase('aw_migrate_guard', undefined, priorDir);
  }, 180_000);

  afterEach(async () => {
    await isolated.close();
    await rm(priorDir, { recursive: true });
  });

  // The foreign keys are skipped: the rows below only need the columns the guard reads.
  async function seed(statements: readonly string[]): Promise<void> {
    const client = new pg.Client({ connectionString: isolated.url });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const statement of statements) await client.query(statement);
    } finally {
      await client.end();
    }
  }

  const workspace = '00000000-0000-4000-8000-000000000001';
  const principal = '00000000-0000-4000-8000-000000000002';
  const object = '00000000-0000-4000-8000-000000000003';
  const idOf = (objectId: string | null) => (objectId === null ? 'null' : `'${objectId}'`);
  const file = (name: string, objectId: string | null) =>
    `insert into files (workspace_id, path, kind, storage_key, object_id, owner_principal_id)
     values ('${workspace}', '${name}', 'file', 'files/${name}', ${idOf(objectId)}, '${principal}')`;
  const folder = `insert into files (workspace_id, path, kind, owner_principal_id)
     values ('${workspace}', 'docs', 'folder', '${principal}')`;
  const blob = (objectId: string | null) =>
    `insert into session_state_blobs
       (workspace_id, session_id, engine, blob_key, storage_key, object_id, size_bytes, sha256)
     values ('${workspace}', '${principal}', 'pi', 'k', 'workspaces/w/k', ${idOf(objectId)}, 1,
       '${'0'.repeat(64)}')`;

  async function ledgerCount(): Promise<number> {
    const result = await isolated.db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    return result.rows[0]?.count ?? -1;
  }

  const upgrade = () => runMigrations({ url: isolated.url, maxConnections: 2 }, migrationsDir);
  // drizzle wraps the server's message as the `cause` of "Failed query".
  const refusedUpgrade = async (): Promise<string> =>
    upgrade().then(
      () => 'upgraded',
      (error: unknown) => String((error as { cause?: unknown }).cause),
    );
  const refusal =
    'legacy_storage_rows_remain: run the storage migration first (AW_STORAGE_MIGRATE=copy)';

  it('[US-STO-13][api][cli] upgrading refuses while legacy rows remain', async () => {
    await seed([folder, file('a.txt', null)]);
    expect(await refusedUpgrade()).toContain(refusal);
    expect(await ledgerCount()).toBe(total - pending);

    await isolated.db.execute(sql`delete from files where kind = 'file'`);
    await seed([blob(null)]);
    expect(await refusedUpgrade()).toContain(refusal);
    expect(await ledgerCount()).toBe(total - pending);

    // A folder has no object id by design, and a row that has one is not legacy.
    await isolated.db.execute(sql`delete from session_state_blobs`);
    await seed([file('b.txt', object), blob(object)]);
    expect((await upgrade()).applied).toBe(pending);
  }, 180_000);
});
