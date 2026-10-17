/**
 * The database connection, constructed in exactly one place.
 *
 * Application code that talks to PostgreSQL goes through {@link createDatabase}. There is one
 * deliberate exception in this package, and it is the only one: `migrate.ts` opens a raw
 * `pg.Client` of its own to hold the migration advisory lock, because R-15 verified that a pool
 * holding that lock deadlocks Drizzle's `migrate()`. That file states the reason at the call
 * site; nothing else may add a second exception without doing the same.
 *
 * The `pg` driver is a §40 "mature library is mandatory" case — a database client is on the
 * specification's own list of things not to reimplement — and R-15 pinned it at 8.23.0.
 *
 * The environment reader below is written the way ADR-0015 requires every gate to be
 * written: it decides on a positive assertion. `DATABASE_URL` is accepted because it parsed as
 * a URL with a supported protocol and a host, never because nothing about it looked wrong. A
 * missing, blank, unparseable or `mysql://` value is a named, thrown error — not a fallback to
 * localhost, and not `undefined` handed onward to `pg` to fail somewhere less legible.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema/index.js';

/** The connection settings this project reads from the environment (spec §37). */
export interface DatabaseConfig {
  /** A validated `postgres:` / `postgresql:` connection string. */
  readonly url: string;
  /** Maximum pooled connections. */
  readonly maxConnections: number;
}

const SUPPORTED_PROTOCOLS = ['postgres:', 'postgresql:'] as const;
const DEFAULT_MAX_CONNECTIONS = 10;
const MAX_MAX_CONNECTIONS = 1000;

/** Describe an unexpected value for an error message without dumping a credential into a log. */
function describeType(value: unknown): string {
  if (value === undefined) return 'unset';
  if (value === null) return 'null';
  return `a ${typeof value}`;
}

/**
 * Validate a `DATABASE_URL`, returning it unchanged, or throw explaining what was wrong.
 *
 * Every rejection names the reason. The error never contains the value itself: a connection
 * string carries a password.
 */
export function parseDatabaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error(
      `DATABASE_URL is ${describeType(raw)}; expected a postgres:// connection string (spec §37).`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error(
      'DATABASE_URL is empty or whitespace; expected a postgres:// connection string.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      'DATABASE_URL is not a parseable URL. Expected postgres://user:pass@host:port/db.',
    );
  }
  if (!SUPPORTED_PROTOCOLS.includes(parsed.protocol as (typeof SUPPORTED_PROTOCOLS)[number])) {
    throw new Error(
      `DATABASE_URL uses the "${parsed.protocol}" scheme; this project supports only ` +
        `${SUPPORTED_PROTOCOLS.join(' and ')} (spec §28 — PostgreSQL).`,
    );
  }
  // A Unix socket (Cloud SQL's `/cloudsql/<instance>`) is named by the `host` query parameter,
  // which `pg` reads, with an empty authority: `postgres:///db?host=/cloudsql/...&user=...`.
  if (parsed.hostname === '' && !parsed.searchParams.get('host')) {
    throw new Error('DATABASE_URL names no host.');
  }
  return trimmed;
}

/**
 * Validate an optional pool size.
 *
 * Parses before it compares, so `NaN` can never reach the range test and slip through as a
 * falsy comparison (ADR-0015). `'12abc'`, `'0'`, `'-1'` and `'1e3'` are all rejected by
 * name; only a plain positive integer is accepted.
 */
export function parseMaxConnections(raw: unknown, fallback = DEFAULT_MAX_CONNECTIONS): number {
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return fallback;
  if (typeof raw !== 'string') {
    throw new Error(`DATABASE_POOL_MAX is ${describeType(raw)}; expected a positive integer.`);
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `DATABASE_POOL_MAX is ${JSON.stringify(trimmed)}; expected a positive integer.`,
    );
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MAX_CONNECTIONS) {
    throw new Error(
      `DATABASE_POOL_MAX is ${JSON.stringify(trimmed)}; expected an integer between 1 and ${String(MAX_MAX_CONNECTIONS)}.`,
    );
  }
  return value;
}

/** Read and validate the database configuration from an environment. Throws on anything invalid. */
export function readDatabaseConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConfig {
  return {
    url: parseDatabaseUrl(env['DATABASE_URL']),
    maxConnections: parseMaxConnections(env['DATABASE_POOL_MAX']),
  };
}

/**
 * What a failed database connection reports (S1-25, issue #510).
 *
 * `code` is a SQLSTATE (`57P01`), a Node errno (`ECONNRESET`) or `'unknown'`. It never carries the
 * error message, the connection string or the host: a driver message can echo any of them.
 */
export interface DatabaseConnectionErrorReport {
  readonly code: string;
}

/** Where a pool or lock client reports a connection error. It must not throw; if it does, the throw is swallowed. */
export type DatabaseConnectionErrorSink = (report: DatabaseConnectionErrorReport) => void;

/** Options for {@link createPool}. */
export interface CreatePoolOptions {
  /** Replaces the default one-line `console.error` report. */
  readonly onError?: DatabaseConnectionErrorSink;
}

const SQLSTATE = /^[0-9A-Z]{5}$/u;
const NODE_ERRNO = /^E[A-Z0-9_]+$/u;

/**
 * The safe code of a connection error: its SQLSTATE or Node errno, or `'unknown'`.
 *
 * Reads `code` and nothing else, so neither the message nor anything it quotes can leak.
 */
export function databaseConnectionErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'unknown';
  const code = error.code;
  if (typeof code !== 'string') return 'unknown';
  return SQLSTATE.test(code) || NODE_ERRNO.test(code) ? code : 'unknown';
}

/** The default sink: exactly one redacted line, in the `[tag]` style of the server's composition logs. */
function logDatabaseConnectionError(report: DatabaseConnectionErrorReport): void {
  console.error(`[db] a database connection failed (${report.code}); the pool discards it`);
}

/** Anything that emits a driver `error` event: a `pg.Pool` or a `pg.Client`. */
interface ErrorEventEmitter {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * Attach an `error` listener that reports a redacted code and never throws.
 *
 * Without a listener, an `error` event is an uncaught exception that ends the process: this is
 * what a pooled idle client does when the server terminates it (`57P01`, issue #510). Exported for
 * the raw lock clients in `bootstrap.ts` and `migrate.ts`; not re-exported from the db index.
 */
export function reportDatabaseConnectionErrors(
  emitter: ErrorEventEmitter,
  onError: DatabaseConnectionErrorSink = logDatabaseConnectionError,
): void {
  emitter.on('error', (error) => {
    try {
      onError({ code: databaseConnectionErrorCode(error) });
    } catch {
      // A reporter must never turn a discarded connection into a crash.
    }
  });
}

/** The connections each {@link createPool} pool opened and has not yet finished closing. */
const openConnections = new WeakMap<pg.Pool, Set<pg.PoolClient>>();

/**
 * Create a `pg` connection pool. The caller owns it and must close it, with {@link closePool} when
 * the database server may be stopped right afterwards.
 */
export function createPool(config: DatabaseConfig, options: CreatePoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString: config.url, max: config.maxConnections });
  const open = new Set<pg.PoolClient>();
  openConnections.set(pool, open);
  // pg-pool re-emits an IDLE client's error (e.g. 57P01 on a server shutdown) as a pool `error`.
  reportDatabaseConnectionErrors(pool, options.onError);
  // pg-pool removes its idle error listener while a client is checked out, so an error between
  // two queries on a checked-out client would be uncaught. That client's next query rejects to
  // its caller anyway, so this listener stays silent rather than reporting the error twice.
  pool.on('connect', (client) => {
    open.add(client);
    client.on('error', () => undefined);
  });
  // `remove` is emitted from the client's own `end()` callback: its connection has closed.
  pool.on('remove', (client) => {
    open.delete(client);
  });
  return pool;
}

/** How long {@link closePool} waits for the pool's connections to finish closing. */
const CLOSE_POOL_SETTLE_MS = 5_000;

/**
 * End `pool` and resolve once every connection it opened has closed.
 *
 * `pg.Pool#end()` resolves as soon as its last client is removed, while each removed client's own
 * `end()` is still in flight: the Terminate message is sent, but the backend may not have read it.
 * A server stopped at that moment terminates those backends with `57P01`, which the pool then
 * reports as a failed connection (S1-25, issue #510, ADR-0112). This also waits for each of those
 * closes, at most {@link CLOSE_POOL_SETTLE_MS} so a socket that never closes cannot hang a stop.
 * A pool that {@link createPool} did not make is only ended.
 */
export async function closePool(pool: pg.Pool): Promise<void> {
  const open = openConnections.get(pool);
  await pool.end();
  if (open === undefined || open.size === 0) return;
  const closing: ReadonlySet<pg.PoolClient> = open;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, CLOSE_POOL_SETTLE_MS);
    function onRemove(): void {
      if (closing.size === 0) done();
    }
    function done(): void {
      clearTimeout(timer);
      pool.off('remove', onRemove);
      resolve();
    }
    pool.on('remove', onRemove);
  });
}

/**
 * Wrap a pool in a Drizzle instance bound to the whole schema.
 *
 * Passing `schema` is what makes `db.query.<table>` available and what gives inserts and
 * selects their inferred types. It does not open a connection.
 */
export function createDatabase(pool: pg.Pool) {
  return drizzle(pool, { schema });
}

/** The Drizzle handle every module in the project takes as its database parameter. */
export type Database = ReturnType<typeof createDatabase>;

/**
 * Pool plus handle, for the one-shot entry points (migrate, seed) that own their connection.
 * Long-lived services should create the pool once and keep it, not call this per request.
 */
export function connect(config: DatabaseConfig = readDatabaseConfig()): {
  pool: pg.Pool;
  db: Database;
} {
  const pool = createPool(config);
  return { pool, db: createDatabase(pool) };
}
