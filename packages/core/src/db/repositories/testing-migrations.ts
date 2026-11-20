import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';

import { runMigrations } from '../migrate.js';

interface Journal {
  entries: Array<{ tag: string }>;
}

/** Apply the journal entries before the storage proof guard, from a scratch copy of the directory. */
async function migrateBeforeStorageProofGuard(url: string, migrationsDir: string): Promise<void> {
  const journal = JSON.parse(
    await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  // By suffix: `pnpm migrations:renumber` may change the number.
  const guard = journal.entries.findIndex((entry) => entry.tag.endsWith('_storage_proof_guard'));
  if (guard < 0) throw new Error('the storage proof guard migration is missing');
  const before = journal.entries.slice(0, guard);
  const dir = await mkdtemp(path.join(tmpdir(), 'aw-before-storage-proof-'));
  try {
    await mkdir(path.join(dir, 'meta'));
    await writeFile(
      path.join(dir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: before }),
    );
    await Promise.all(
      before.map((entry) =>
        cp(path.join(migrationsDir, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`)),
      ),
    );
    await runMigrations({ url, maxConnections: 2 }, dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

/** Record the clean adopt and skills passes that the release after 0.6.11 stores. */
async function recordCleanStorageMigrationRuns(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `insert into storage_migration_runs
         (rows_checked, legacy_rows, mismatches, stage, clean, proof_version)
       values (0, 0, 0, 'adopt', true, 2), (0, 0, 0, 'skills', true, 2)`,
    );
  } finally {
    await client.end();
  }
}

/**
 * Apply every migration in `migrationsDir` to a database that already holds stored data (files,
 * skills or session-state blobs), as an upgrade through the release after 0.6.11 does: the
 * migrations before the storage proof guard, then the clean adopt and skills passes that release
 * records, then the rest. A fresh database needs none of this; `runMigrations` alone applies it.
 */
export async function runMigrationsPastStorageProof(
  url: string,
  migrationsDir: string,
): Promise<void> {
  await migrateBeforeStorageProofGuard(url, migrationsDir);
  await recordCleanStorageMigrationRuns(url);
  await runMigrations({ url, maxConnections: 2 }, migrationsDir);
}
