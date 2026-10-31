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

/** Where the legacy storage guards sit in the journal; by suffix, as `pnpm migrations:renumber` may change the number. */
const LEGACY_ROWS_GUARD_SUFFIX = '_lively_nomad';
const MIGRATION_PROOF_GUARD_SUFFIX = '_storage_proof_guard';

/** The journal position of the migration whose tag ends in `suffix`, and the journal length. */
async function journalIndex(
  migrationsDir: string,
  suffix: string,
): Promise<{ readonly index: number; readonly total: number }> {
  const journal = JSON.parse(
    await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  const index = journal.entries.findIndex((entry) => entry.tag.endsWith(suffix));
  if (index < 0) throw new Error(`the migration *${suffix} is missing`);
  return { index, total: journal.entries.length };
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

// The foreign keys are skipped: the rows below only need the columns the guards read.
async function seed(isolated: IsolatedTestDatabase, statements: readonly string[]): Promise<void> {
  const client = new pg.Client({ connectionString: isolated.url });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

async function ledgerCountOf(isolated: IsolatedTestDatabase): Promise<number> {
  const result = await isolated.db.execute<{ count: number }>(
    sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
  );
  return result.rows[0]?.count ?? -1;
}

/** The server's message of a refused statement; drizzle wraps it as the `cause` of "Failed query". */
const refusalOf = (attempt: Promise<unknown>): Promise<string> =>
  attempt.then(
    () => 'applied',
    (error: unknown) => String((error as { cause?: unknown }).cause ?? error),
  );

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
const skill = `insert into skills (workspace_id, name, skill_md, owner_principal_id)
   values ('${workspace}', 'notes', '# Notes', '${principal}')`;

const LEGACY_ROWS_REFUSAL =
  'legacy_storage_rows_remain: run the storage migration first (AW_STORAGE_MIGRATE=copy)';

// @story US-STO-13
describe('the legacy storage guard', () => {
  const migrationsDir = resolveMigrationsDir();
  let priorDir: string;
  let targetDir: string;
  let pending: number;
  let isolated: IsolatedTestDatabase;

  // Up to, not including, the proof guard after it, which needs run records this guard predates.
  beforeEach(async () => {
    const guard = await journalIndex(migrationsDir, LEGACY_ROWS_GUARD_SUFFIX);
    const proof = await journalIndex(migrationsDir, MIGRATION_PROOF_GUARD_SUFFIX);
    pending = proof.index - guard.index;
    ({ dir: priorDir } = await writePriorMigrations(migrationsDir, guard.total - guard.index));
    ({ dir: targetDir } = await writePriorMigrations(migrationsDir, proof.total - proof.index));
    isolated = await createIsolatedTestDatabase('aw_migrate_guard', undefined, priorDir);
  }, 180_000);

  afterEach(async () => {
    await isolated.close();
    await rm(priorDir, { recursive: true });
    await rm(targetDir, { recursive: true });
  });

  const upgrade = () => runMigrations({ url: isolated.url, maxConnections: 2 }, targetDir);

  it('[US-STO-13][api][cli] upgrading refuses while legacy rows remain', async () => {
    const before = await ledgerCountOf(isolated);
    await seed(isolated, [folder, file('a.txt', null)]);
    expect(await refusalOf(upgrade())).toContain(LEGACY_ROWS_REFUSAL);
    expect(await ledgerCountOf(isolated)).toBe(before);

    await isolated.db.execute(sql`delete from files where kind = 'file'`);
    await seed(isolated, [blob(null)]);
    expect(await refusalOf(upgrade())).toContain(LEGACY_ROWS_REFUSAL);
    expect(await ledgerCountOf(isolated)).toBe(before);

    // A folder has no object id by design, and a row that has one is not legacy.
    await isolated.db.execute(sql`delete from session_state_blobs`);
    await seed(isolated, [file('b.txt', object), blob(object)]);
    expect((await upgrade()).applied).toBe(pending);
  }, 180_000);
});

// @story US-STO-13
describe('the storage migration proof guard', () => {
  const migrationsDir = resolveMigrationsDir();
  let priorDir: string;
  let total: number;
  let pending: number;
  let isolated: IsolatedTestDatabase;

  beforeEach(async () => {
    const guard = await journalIndex(migrationsDir, MIGRATION_PROOF_GUARD_SUFFIX);
    pending = guard.total - guard.index;
    ({ dir: priorDir, total } = await writePriorMigrations(migrationsDir, pending));
    isolated = await createIsolatedTestDatabase('aw_migrate_proof', undefined, priorDir);
  }, 180_000);

  afterEach(async () => {
    await isolated.close();
    await rm(priorDir, { recursive: true });
  });

  const upgrade = () => runMigrations({ url: isolated.url, maxConnections: 2 }, migrationsDir);
  const refusal = 'legacy_storage_rows_remain: upgrade through the release after 0.6.11 first';

  let minute = 0;
  /** One pass record; each is a minute after the one before, so the last one seeded is the latest. */
  const run = (
    stage: 'adopt' | 'skills' | 'finalize',
    fields: {
      readonly clean?: boolean | null;
      readonly legacyRows?: number;
      readonly proofVersion?: number | null;
      readonly orphans?: number | null;
    } = {},
  ) => {
    minute += 1;
    const { clean = true, legacyRows = 0, proofVersion = 2, orphans = null } = fields;
    return `insert into storage_migration_runs
       (finished_at, rows_checked, legacy_rows, mismatches, stage, clean, orphans, proof_version)
     values (timestamp with time zone '2026-11-01 00:00:00+00' + interval '${String(minute)} minutes',
       0, ${String(legacyRows)}, 0, '${stage}', ${String(clean)}, ${String(orphans)},
       ${String(proofVersion)})`;
  };
  const proven = () => [run('adopt'), run('skills')];

  it('[US-STO-13][api][cli] a fresh database upgrades with no step', async () => {
    expect((await upgrade()).applied).toBe(pending);
    expect(await ledgerCountOf(isolated)).toBe(total);
  }, 180_000);

  it.each([
    ['no pass record at all', [file('a.txt', object)]],
    [
      'records written by 0.6.11',
      [
        file('a.txt', object),
        run('adopt', { proofVersion: null }),
        run('skills', { proofVersion: null }),
      ],
    ],
    ['no skills record', [blob(object), run('adopt')]],
    ['no adopt record', [blob(object), run('skills')]],
    [
      'an unclean latest adopt pass',
      [file('a.txt', object), run('skills'), run('adopt', { clean: false })],
    ],
    [
      'a clean adopt pass followed by a failed one',
      [file('a.txt', object), ...proven(), run('adopt', { clean: false })],
    ],
    [
      'adopted objects skipped',
      [file('a.txt', object), run('skills'), run('adopt', { legacyRows: 2 })],
    ],
    [
      'legacy skill objects left',
      [file('a.txt', object), run('adopt'), run('skills', { legacyRows: 1 })],
    ],
    [
      'an unclean latest skills pass',
      [file('a.txt', object), run('adopt'), run('skills', { clean: false })],
    ],
    ['only a run record', [run('finalize')]],
    ['only skill rows, no pass record', [skill]],
    [
      'a latest adopt pass with clean NULL',
      [file('a.txt', object), run('adopt', { clean: null }), run('skills')],
    ],
  ])(
    '[US-STO-13][api][cli] upgrading refuses until a clean adopt and skills pass is recorded: %s',
    async (_case, statements) => {
      await seed(isolated, statements);
      expect(await refusalOf(upgrade())).toContain(refusal);
      expect(await ledgerCountOf(isolated)).toBe(total - pending);
    },
    180_000,
  );

  it('[US-STO-13][api][cli] upgrading still refuses while legacy rows remain', async () => {
    await seed(isolated, [file('a.txt', null), ...proven()]);
    const refused = await refusalOf(upgrade());
    expect(refused).toContain(LEGACY_ROWS_REFUSAL);
    // This release has no copy stage, so the message names the release that has one.
    expect(refused).toContain('(AW_STORAGE_MIGRATE=copy) on the release after 0.6.11');
    expect(await ledgerCountOf(isolated)).toBe(total - pending);
  }, 180_000);

  it('[US-STO-13][api][cli] a clean adopt and skills pass upgrades, orphans and earlier failures included', async () => {
    await seed(isolated, [
      folder,
      file('a.txt', object),
      blob(object),
      run('adopt', { clean: false }),
      run('skills', { legacyRows: 4 }),
      ...[run('adopt'), run('skills', { orphans: 3 })],
    ]);
    expect((await upgrade()).applied).toBe(pending);
    expect(await ledgerCountOf(isolated)).toBe(total);
  }, 180_000);

  it('[US-STO-13][api][cli] after the guard a file or blob row cannot be written without an object id', async () => {
    await seed(isolated, proven());
    await upgrade();
    await expect(refusalOf(seed(isolated, [file('late.txt', null)]))).resolves.toContain(
      'files_file_has_object_id',
    );
    await expect(refusalOf(seed(isolated, [blob(null)]))).resolves.toContain('object_id');
    await seed(isolated, [folder, file('b.txt', object), blob(object)]);
  }, 180_000);

  it('[US-STO-13][api][cli] two upgrades of a refusing database both refuse and apply nothing', async () => {
    await seed(isolated, [file('a.txt', object), run('adopt')]);
    const outcomes = await Promise.all([refusalOf(upgrade()), refusalOf(upgrade())]);
    expect(outcomes).toEqual([expect.stringContaining(refusal), expect.stringContaining(refusal)]);
    expect(await ledgerCountOf(isolated)).toBe(total - pending);
  }, 180_000);
});
