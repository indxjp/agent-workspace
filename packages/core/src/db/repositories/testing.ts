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
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';

import { connect, parseDatabaseUrl, type Database, type DatabaseConfig } from '../client.js';
import { runMigrations } from '../migrate.js';

const POSTGRES_IDENTIFIER_LIMIT = 63;
const UNIQUE_SUFFIX_LENGTH = 25;
const PHYSICAL_PREFIX_LENGTH = POSTGRES_IDENTIFIER_LIMIT - UNIQUE_SUFFIX_LENGTH - 1;
const CONNECTION_TIMEOUT_MS = 5_000;
const DROP_TIMEOUT_MS = 30_000;
const POOL_QUIESCENCE_TIMEOUT_MS = 10_000;
const POOL_QUIESCENCE_POLL_MS = 25;

/**
 * A readable prefix this module is willing to use.
 *
 * The accepted length preserves the helper's original caller contract. Physical names retain the
 * first 37 characters, leaving one underscore and 25 base-36 characters (more than 120 random
 * bits) inside PostgreSQL's 63-byte identifier limit. The alphabet is ASCII, so characters and
 * bytes have the same length here.
 */
const SAFE_PREFIX = /^[a-z][a-z0-9_]{0,48}$/u;
const SAFE_METADATA = /^[a-zA-Z0-9 ._:/()-]{1,64}$/u;

interface RecordedConnectionError {
  readonly owner: string;
  readonly code: string;
}

/** One `pg_stat_activity` row attached to an isolated test database. */
export interface DatabaseSession {
  readonly pid: number;
  readonly application_name: string;
  readonly state: string | null;
  readonly backend_type: string | null;
}

/** The `pg_stat_activity.backend_type` of a client-opened session, the only kind a test owns. */
const CLIENT_BACKEND = 'client backend';

/**
 * The sessions a suite is answerable for.
 *
 * `pg_stat_activity` also reports the server's own workers against a database — most often an
 * autovacuum worker on a database a slow suite has just churned, which a coverage run makes far
 * more likely because its databases live longer. Those workers are not test leaks: they detach on
 * their own, and `DROP DATABASE` signals them away instead of refusing. Counting them made teardown
 * report a leak for work the server was doing correctly, so the inspection narrows to client
 * backends exactly as the service harness probe in `scripts/test-with-services.mjs` does.
 */
export function leakedSessions(rows: readonly DatabaseSession[]): DatabaseSession[] {
  return rows.filter((row) => row.backend_type === CLIENT_BACKEND);
}

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

/** Replace the database and application name while preserving other connection options. */
function connectionUrl(url: string, database: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  parsed.searchParams.set('application_name', applicationName);
  return parsed.toString();
}

/** Tag an administrative connection without changing its target database. */
function adminUrl(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('application_name', applicationName);
  return parsed.toString();
}

/** A fixed-width lower-case suffix carrying 128 random bits in PostgreSQL-safe base 36. */
function uniqueSuffix(): string {
  const value = BigInt(`0x${randomBytes(16).toString('hex')}`);
  return value.toString(36).padStart(UNIQUE_SUFFIX_LENGTH, '0');
}

function postgresErrorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[0-9A-Z]{5}$/u.test(error.code)
  ) {
    return error.code;
  }
  return 'unknown';
}

function trackClientErrors(
  connection: pg.Client,
  owner: string,
  errors: RecordedConnectionError[],
): pg.Client {
  connection.on('error', (error: Error) => {
    errors.push({ owner, code: postgresErrorCode(error) });
  });
  return connection;
}

function trackPoolErrors(
  connection: pg.Pool,
  owner: string,
  errors: RecordedConnectionError[],
): pg.Pool {
  connection.on('connect', (client: pg.PoolClient) => {
    client.on('error', (error: Error) => {
      errors.push({ owner: `${owner}/client`, code: postgresErrorCode(error) });
    });
  });
  connection.on('error', (error: Error) => {
    errors.push({ owner, code: postgresErrorCode(error) });
  });
  return connection;
}

function safeMetadata(value: string | null): string {
  if (value === null || value === '') return '<unset>';
  return SAFE_METADATA.test(value) ? value : '<redacted>';
}

function activityDiagnostic(
  prefix: string,
  suiteApplicationName: string,
  row: DatabaseSession,
): string {
  const isSuiteConnection = row.application_name === suiteApplicationName;
  const owner = isSuiteConnection ? prefix : 'external';
  return [
    `pid=${String(row.pid)}`,
    `owner=${owner}`,
    `application=${isSuiteConnection ? 'suite' : '<redacted>'}`,
    `state=${safeMetadata(row.state)}`,
    `backend=${safeMetadata(row.backend_type)}`,
    'query=<redacted>',
  ].join(' ');
}

function connectionErrorDiagnostic(errors: readonly RecordedConnectionError[]): string {
  return errors.map(({ owner, code }) => `owner=${owner} code=${code}`).join('; ');
}

function administrativeClient(
  validatedAdminUrl: string,
  applicationName: string,
  owner: string,
  errors: RecordedConnectionError[],
): pg.Client {
  return trackClientErrors(
    new pg.Client({
      connectionString: adminUrl(validatedAdminUrl, applicationName),
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      statement_timeout: DROP_TIMEOUT_MS,
    }),
    owner,
    errors,
  );
}

async function forceDropAfterCreationFailure(
  validatedAdminUrl: string,
  databaseName: string,
  applicationName: string,
  errors: RecordedConnectionError[],
): Promise<void> {
  const client = administrativeClient(
    validatedAdminUrl,
    applicationName,
    `${databaseName}/creation-cleanup`,
    errors,
  );
  try {
    await client.connect();
    await client.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await client.end().catch((error: unknown) => {
      errors.push({ owner: `${databaseName}/creation-cleanup`, code: postgresErrorCode(error) });
    });
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
): Promise<IsolatedTestDatabase> {
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

  const validatedAdminUrl = parseDatabaseUrl(rawAdminUrl);
  const suffix = uniqueSuffix();
  const databaseName = `${prefix.slice(0, PHYSICAL_PREFIX_LENGTH)}_${suffix}`;
  if (Buffer.byteLength(databaseName, 'utf8') > POSTGRES_IDENTIFIER_LIMIT) {
    throw new Error('The isolated test database name exceeded PostgreSQL’s identifier limit.');
  }

  const applicationStem = `aw:${suffix}`;
  const suiteApplicationName = `${applicationStem}:suite`;
  const connectionErrors: RecordedConnectionError[] = [];
  const creator = administrativeClient(
    validatedAdminUrl,
    `${applicationStem}:creator`,
    `${databaseName}/creator`,
    connectionErrors,
  );
  try {
    await creator.connect();
    await creator.query(`create database "${databaseName}"`);
  } finally {
    await creator.end().catch((error: unknown) => {
      connectionErrors.push({ owner: `${databaseName}/creator`, code: postgresErrorCode(error) });
    });
  }

  const url = connectionUrl(validatedAdminUrl, databaseName, suiteApplicationName);
  const config: DatabaseConfig = { url, maxConnections: 4 };
  let pool: pg.Pool;
  let db: Database;
  try {
    await runMigrations(config, migrationsDir);
    ({ pool, db } = connect(config));
  } catch (error) {
    try {
      await forceDropAfterCreationFailure(
        validatedAdminUrl,
        databaseName,
        `${applicationStem}:failed`,
        connectionErrors,
      );
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
  trackPoolErrors(pool, `${databaseName}/suite-pool`, connectionErrors);

  let closePromise: Promise<void> | undefined;
  const closeDatabase = async (): Promise<void> => {
    let poolEndCode: string | null = null;
    try {
      await pool.end();
    } catch (error) {
      poolEndCode = postgresErrorCode(error);
    }

    const inspectorOwner = `${databaseName}/inspector`;
    const inspector = administrativeClient(
      validatedAdminUrl,
      `${applicationStem}:inspector`,
      inspectorOwner,
      connectionErrors,
    );
    let activities: DatabaseSession[] = [];
    let activityCode: string | null = null;
    let normalDropCode: string | null = null;
    let forceDropCode: string | null = null;
    let verificationCode: string | null = null;
    let databaseRemains = false;

    try {
      await inspector.connect();
      try {
        const readActivities = async (): Promise<DatabaseSession[]> => {
          const result = await inspector.query<DatabaseSession>(
            `select pid, application_name, state, backend_type
               from pg_stat_activity
              where datname = $1 and pid <> pg_backend_pid()
              order by pid`,
            [databaseName],
          );
          return leakedSessions(result.rows);
        };
        activities = await readActivities();
        const quiescenceDeadline = Date.now() + POOL_QUIESCENCE_TIMEOUT_MS;
        while (
          activities.length > 0 &&
          activities.every((row) => row.application_name === suiteApplicationName) &&
          Date.now() < quiescenceDeadline
        ) {
          await delay(POOL_QUIESCENCE_POLL_MS);
          activities = await readActivities();
        }
      } catch (error) {
        activityCode = postgresErrorCode(error);
      }

      if (activityCode === null && activities.length === 0) {
        try {
          await inspector.query(`drop database if exists "${databaseName}"`);
        } catch (error) {
          normalDropCode = postgresErrorCode(error);
        }
      }

      if (activityCode !== null || activities.length > 0 || normalDropCode !== null) {
        try {
          await inspector.query(`drop database if exists "${databaseName}" with (force)`);
        } catch (error) {
          forceDropCode = postgresErrorCode(error);
        }
      }

      try {
        const result = await inspector.query<{ present: boolean }>(
          'select exists(select 1 from pg_database where datname = $1) as present',
          [databaseName],
        );
        databaseRemains = result.rows[0]?.present !== false;
      } catch (error) {
        verificationCode = postgresErrorCode(error);
      }
    } catch (error) {
      forceDropCode = postgresErrorCode(error);
    } finally {
      await inspector.end().catch((error: unknown) => {
        connectionErrors.push({ owner: inspectorOwner, code: postgresErrorCode(error) });
      });
    }

    const failures: string[] = [];
    if (poolEndCode !== null) failures.push(`owned pool close failed (code=${poolEndCode})`);
    if (activityCode !== null) {
      failures.push(`pg_stat_activity inspection failed (code=${activityCode})`);
    }
    if (forceDropCode !== null)
      failures.push(`bounded force cleanup failed (code=${forceDropCode})`);
    if (verificationCode !== null) {
      failures.push(`database absence verification failed (code=${verificationCode})`);
    }
    if (databaseRemains) {
      failures.push(
        `database remained after cleanup` +
          (normalDropCode === null ? '' : ` (normal drop code=${normalDropCode})`),
      );
    }
    if (activities.length > 0) {
      failures.push(
        `connections remained after the owned pool closed: ${activities
          .map((row) => activityDiagnostic(prefix, suiteApplicationName, row))
          .join('; ')}`,
      );
    }
    if (connectionErrors.length > 0) {
      failures.push(
        `connection errors were recorded: ${connectionErrorDiagnostic(connectionErrors)}`,
      );
    }
    if (failures.length > 0) {
      throw new Error(
        `Isolated PostgreSQL teardown failed for ${prefix}. Cleanup completed before this ` +
          `diagnostic was raised. ${failures.join(' ')}`,
      );
    }
  };

  return {
    url,
    db,
    close(): Promise<void> {
      closePromise ??= closeDatabase();
      return closePromise;
    },
  };
}
