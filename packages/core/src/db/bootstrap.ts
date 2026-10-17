import pg from 'pg';

import { readDatabaseConfig, reportDatabaseConnectionErrors } from './client.js';
import { runMigrations } from './migrate.js';
import { readSeedOptions, runSeed, type SeedOptions, type SeedResult } from './seed.js';

const SEED_LOCK_KEY = 4_242_424_243;

/**
 * Migrate and idempotently seed before any application listener is opened.
 *
 * Returns the ids the seed settled on — the same on every call against the same database — so a
 * caller such as the local runtime launcher (S1-11, contract C2) can name the bootstrap workspace
 * and its owner without a second query.
 */
export async function prepareDatabase(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: Pick<SeedOptions, 'general'> = {},
): Promise<SeedResult> {
  const config = readDatabaseConfig(env);
  await runMigrations(config);
  const lock = new pg.Client({ connectionString: config.url });
  reportDatabaseConnectionErrors(lock);
  await lock.connect();
  try {
    await lock.query('select pg_advisory_lock($1)', [SEED_LOCK_KEY]);
    return await runSeed(config, { ...readSeedOptions(env), ...options });
  } finally {
    await lock.query('select pg_advisory_unlock($1)', [SEED_LOCK_KEY]).catch(() => undefined);
    await lock.end();
  }
}
