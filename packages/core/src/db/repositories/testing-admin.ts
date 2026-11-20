/**
 * Administrative PostgreSQL connections for the isolated test database helper: tagged clients,
 * connection-error recording, creation, and the once-per-process durability relaxation.
 */
import pg from 'pg';

const CONNECTION_TIMEOUT_MS = 5_000;
const DROP_TIMEOUT_MS = 30_000;

export interface RecordedConnectionError {
  readonly owner: string;
  readonly code: string;
}

/** The identity of one isolated database and the server it is administered through. */
export interface AdminContext {
  readonly adminUrl: string;
  readonly databaseName: string;
  readonly applicationStem: string;
  /** Whether the process runs in GitHub Actions, where the server is a disposable service. */
  readonly githubActions: boolean;
  readonly errors: RecordedConnectionError[];
}

/** Replace the database and application name while preserving other connection options. */
export function connectionUrl(url: string, database: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  parsed.searchParams.set('application_name', applicationName);
  return parsed.toString();
}

/** Tag an administrative connection without changing its target database. */
function adminUrlTagged(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('application_name', applicationName);
  return parsed.toString();
}

export function postgresErrorCode(error: unknown): string {
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

export function trackPoolErrors(
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

/** The owner of a connection is `<database>/<ownerRole>`; its application name `<stem>:<role>`. */
export function administrativeClient(
  context: AdminContext,
  applicationRole: string,
  ownerRole: string,
): pg.Client {
  const owner = `${context.databaseName}/${ownerRole}`;
  const connection = new pg.Client({
    connectionString: adminUrlTagged(
      context.adminUrl,
      `${context.applicationStem}:${applicationRole}`,
    ),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: DROP_TIMEOUT_MS,
  });
  connection.on('error', (error: Error) => {
    context.errors.push({ owner, code: postgresErrorCode(error) });
  });
  return connection;
}

/** End an administrative client, recording rather than raising a failure to close it. */
export async function endRecordingFailure(
  client: pg.Client,
  context: AdminContext,
  ownerRole: string,
): Promise<void> {
  await client.end().catch((error: unknown) => {
    context.errors.push({
      owner: `${context.databaseName}/${ownerRole}`,
      code: postgresErrorCode(error),
    });
  });
}

/** Whether a server is a disposable CI service whose durability may be traded for faster drops. */
export function relaxesDurability(state: {
  readonly githubActions: boolean;
  readonly superuser: boolean;
  readonly fsync: string;
  readonly fullPageWrites: string;
}): boolean {
  return (
    state.githubActions &&
    state.superuser &&
    (state.fsync === 'on' || state.fullPageWrites === 'on')
  );
}

let durabilityRelaxed: Promise<void> | undefined;

/** Best effort, once per process: an optimisation must never fail or leak server text into a suite. */
function relaxDisposableServerDurability(client: pg.Client, githubActions: boolean): Promise<void> {
  durabilityRelaxed ??= (async () => {
    try {
      const { rows } = await client.query<{
        fsync: string;
        full_page_writes: string;
        superuser: boolean;
      }>(
        `select current_setting('fsync') as fsync,
                current_setting('full_page_writes') as full_page_writes,
                current_setting('is_superuser') = 'on' as superuser`,
      );
      const row = rows[0];
      if (
        row !== undefined &&
        relaxesDurability({
          githubActions,
          superuser: row.superuser,
          fsync: row.fsync,
          fullPageWrites: row.full_page_writes,
        })
      ) {
        await client.query('alter system set fsync = off');
        await client.query('alter system set full_page_writes = off');
        await client.query('select pg_reload_conf()');
      }
    } catch {
      // The drop stays correct, only slower.
    }
  })();
  return durabilityRelaxed;
}

/** Create the empty database through a dedicated, short-lived administrative connection. */
export async function createEmptyDatabase(context: AdminContext): Promise<void> {
  const creator = administrativeClient(context, 'creator', 'creator');
  try {
    await creator.connect();
    await relaxDisposableServerDurability(creator, context.githubActions);
    await creator.query(`create database "${context.databaseName}"`);
  } finally {
    await endRecordingFailure(creator, context, 'creator');
  }
}

export async function forceDropAfterCreationFailure(context: AdminContext): Promise<void> {
  const client = administrativeClient(context, 'failed', 'creation-cleanup');
  try {
    await client.connect();
    await client.query(`drop database if exists "${context.databaseName}" with (force)`);
  } finally {
    await endRecordingFailure(client, context, 'creation-cleanup');
  }
}
