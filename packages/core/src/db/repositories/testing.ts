/**
 * An isolated, migrated PostgreSQL database for suites that exercise a repository against the
 * real server.
 *
 * Every invocation owns a collision-resistant database, even when two test commands run the same
 * suite against one PostgreSQL server. Cleanup first closes the owned pool, proves that no other
 * client session remains, and prefers a normal drop. A remaining client session is a test leak: it
 * is reported with bounded, credential-free metadata, then force-dropped so the diagnostic does not
 * leave scratch state behind.
 *
 * Abruptly interrupted test processes cannot execute `close()`. When suites use a persistent,
 * externally managed PostgreSQL server, its operator must therefore janitor orphaned `aw_*`
 * databases before subsequent runs; this helper can only guarantee cleanup after control returns
 * to the owning process.
 *
 * `DROP DATABASE` always waits on a forced, immediate checkpoint, so each close costs a full flush
 * and fsync of the cluster. The harness clusters start with `fsync=off`; a CI job instead points
 * `TEST_DATABASE_URL` at a throwaway service started with defaults. On such a server only, the first
 * creator in each process relaxes `fsync` and `full_page_writes` with `ALTER SYSTEM` and a reload.
 * That persists in `postgresql.auto.conf`, so it requires `GITHUB_ACTIONS=true` and a superuser,
 * and a refusal is ignored.
 */
import { randomBytes } from 'node:crypto';

import type pg from 'pg';

import { connect, parseDatabaseUrl, type Database, type DatabaseConfig } from '../client.js';
import { packagedMigrationsDir, runMigrations } from '../migrate.js';

import {
  connectionUrl,
  createEmptyDatabase,
  forceDropAfterCreationFailure,
  postgresErrorCode,
  trackPoolErrors,
  type AdminContext,
} from './testing-admin.js';
import { teardownIsolatedDatabase } from './testing-teardown.js';

export { relaxesDurability } from './testing-admin.js';
export { runMigrationsPastStorageProof } from './testing-migrations.js';
export { leakedSessions } from './testing-teardown.js';

const POSTGRES_IDENTIFIER_LIMIT = 63;
const UNIQUE_SUFFIX_LENGTH = 25;
const PHYSICAL_PREFIX_LENGTH = POSTGRES_IDENTIFIER_LIMIT - UNIQUE_SUFFIX_LENGTH - 1;
const DEFAULT_MAX_CONNECTIONS = 4;

/**
 * A readable prefix this module is willing to use.
 *
 * The accepted length preserves the helper's original caller contract. Physical names retain the
 * first 37 characters, leaving one underscore and 25 base-36 characters (more than 120 random
 * bits) inside PostgreSQL's 63-byte identifier limit. The alphabet is ASCII, so characters and
 * bytes have the same length here.
 */
const SAFE_PREFIX = /^[a-z][a-z0-9_]{0,48}$/u;

/** A migrated database, owned by one suite, with the handle to reach it and the way to let it go. */
export interface IsolatedTestDatabase {
  /** The connection string of the database that was created. */
  readonly url: string;
  /** The Drizzle handle. */
  readonly db: Database;
  /** Close owned connections and drop the database. Concurrent and repeated calls share one result. */
  close(): Promise<void>;
}

/**
 * Close additional test-owned resources before dropping their isolated database.
 *
 * Every close is attempted and every failure is preserved. Database cleanup runs last even when a
 * resource close rejects, so one broken teardown cannot leak scratch state into the next suite.
 */
export async function closeIsolatedTestResources(
  isolated: IsolatedTestDatabase,
  ...resources: readonly Readonly<{ close(): Promise<void> }>[]
): Promise<void> {
  const resourceResults = await Promise.allSettled(
    resources.map((resource) => Promise.resolve().then(() => resource.close())),
  );
  const databaseResults = await Promise.allSettled([
    Promise.resolve().then(() => isolated.close()),
  ]);
  const failures: unknown[] = [];
  for (const result of [...resourceResults, ...databaseResults]) {
    if (result.status === 'rejected') {
      const reason: unknown = result.reason;
      failures.push(reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Test database cleanup failed.');
  }
}

/** A fixed-width lower-case suffix carrying 128 random bits in PostgreSQL-safe base 36. */
function uniqueSuffix(): string {
  const value = BigInt(`0x${randomBytes(16).toString('hex')}`);
  return value.toString(36).padStart(UNIQUE_SUFFIX_LENGTH, '0');
}

/** Options for {@link createIsolatedTestDatabase}. */
export interface IsolatedTestDatabaseOptions {
  /** The suite pool's size, a positive integer; 4 when omitted. */
  readonly maxConnections?: number;
}

/** Reject unusable inputs before any connection is made, returning the validated server URL. */
function validateCreationInputs(
  prefix: string,
  rawAdminUrl: string | undefined,
  maxConnections: number,
): string {
  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new Error(`maxConnections must be a positive integer, got ${String(maxConnections)}.`);
  }
  if (!SAFE_PREFIX.test(prefix)) {
    throw new Error(
      `${JSON.stringify(prefix)} is not a usable test database prefix; expected ${String(SAFE_PREFIX)}.`,
    );
  }
  if (rawAdminUrl === undefined || rawAdminUrl.trim() === '') {
    throw new Error(
      'TEST_DATABASE_URL is unset, so no isolated test database can be created. A suite that ' +
        'needs one must skip loudly or fail — it must not carry on as though it had a database.',
    );
  }
  return parseDatabaseUrl(rawAdminUrl);
}

/** Migrate the new database and open the suite pool, dropping the database if either fails. */
async function migrateAndConnect(
  admin: AdminContext,
  config: DatabaseConfig,
  migrationsDir: string | undefined,
): Promise<{ pool: pg.Pool; db: Database }> {
  try {
    await runMigrations(config, migrationsDir ?? packagedMigrationsDir());
    return connect(config);
  } catch (error) {
    try {
      await forceDropAfterCreationFailure(admin);
    } catch (cleanupError) {
      throw new AggregateError(
        [error],
        `Isolated PostgreSQL setup failed and its bounded cleanup also failed ` +
          `(code=${postgresErrorCode(cleanupError)}).`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

/**
 * Create a fresh, migrated database whose physical name starts with `prefix`.
 *
 * `migrationsDir` lets a migration regression create a database at a prior journal revision;
 * ordinary repository tests omit it and always receive the current schema.
 */
export async function createIsolatedTestDatabase(
  prefix: string,
  rawAdminUrl: string | undefined = process.env['TEST_DATABASE_URL'],
  migrationsDir?: string,
  options: IsolatedTestDatabaseOptions = {},
): Promise<IsolatedTestDatabase> {
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const validatedAdminUrl = validateCreationInputs(prefix, rawAdminUrl, maxConnections);

  const suffix = uniqueSuffix();
  const databaseName = `${prefix.slice(0, PHYSICAL_PREFIX_LENGTH)}_${suffix}`;
  if (Buffer.byteLength(databaseName, 'utf8') > POSTGRES_IDENTIFIER_LIMIT) {
    throw new Error('The isolated test database name exceeded PostgreSQL’s identifier limit.');
  }

  const applicationStem = `aw:${suffix}`;
  const suiteApplicationName = `${applicationStem}:suite`;
  const admin: AdminContext = {
    adminUrl: validatedAdminUrl,
    databaseName,
    applicationStem,
    githubActions: process.env['GITHUB_ACTIONS'] === 'true',
    errors: [],
  };
  await createEmptyDatabase(admin);

  const url = connectionUrl(validatedAdminUrl, databaseName, suiteApplicationName);
  const { pool, db } = await migrateAndConnect(admin, { url, maxConnections }, migrationsDir);
  trackPoolErrors(pool, `${databaseName}/suite-pool`, admin.errors);

  let closePromise: Promise<void> | undefined;
  return {
    url,
    db,
    close(): Promise<void> {
      closePromise ??= teardownIsolatedDatabase({ admin, prefix, suiteApplicationName, pool });
      return closePromise;
    },
  };
}
