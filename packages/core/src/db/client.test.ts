/**
 * The environment readers are gates, and ADR-0015 says a gate decides on a positive
 * assertion. These tests exist to prove the rejections happen — that `undefined`, `''`,
 * `'localhost'` and `NaN` are named errors rather than values that slip through a falsy
 * comparison into `pg`.
 */
import { EventEmitter } from 'node:events';

import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closePool,
  createPool,
  databaseConnectionErrorCode,
  parseDatabaseUrl,
  parseMaxConnections,
  readDatabaseConfig,
  type DatabaseConnectionErrorReport,
} from './client.js';

const rawTestUrl = process.env['TEST_DATABASE_URL'];
const testDatabaseUrl = rawTestUrl !== undefined && rawTestUrl.trim() !== '' ? rawTestUrl : null;

if (testDatabaseUrl === null) {
  console.warn(
    '[client.test.ts] SKIPPED the PostgreSQL regression — TEST_DATABASE_URL is not set, so a ' +
      'server-terminated idle pool client was NOT exercised.',
  );
}

describe('parseDatabaseUrl', () => {
  it.each([
    'postgres://user:pass@localhost:5432/agentworkspace',
    'postgresql://user@db/agentworkspace?sslmode=require',
    'postgres:///agentworkspace?host=/cloudsql/project:region:instance&user=aw',
  ])('accepts %s', (url) => {
    expect(parseDatabaseUrl(url)).toBe(url);
  });

  it('trims surrounding whitespace', () => {
    expect(parseDatabaseUrl('  postgres://u@h/d  ')).toBe('postgres://u@h/d');
  });

  it.each([
    ['unset', undefined, /unset/u],
    ['null', null, /null/u],
    ['a number', 5432, /a number/u],
    ['empty', '', /empty or whitespace/u],
    ['whitespace', '   ', /empty or whitespace/u],
    ['not a URL at all', 'not a url', /not a parseable URL/u],
    ['a scheme with no host part', '://host/db', /not a parseable URL/u],
    // `new URL('localhost:5432')` PARSES — as the scheme `localhost:`. A bare host:port is the
    // most likely typo here, so it is worth pinning that it is rejected, and by which rule.
    ['a bare host:port', 'localhost:5432', /scheme/u],
    ['the wrong scheme', 'mysql://user@host/db', /scheme/u],
    ['a file URL', 'file:///tmp/db', /scheme/u],
    ['no host', 'postgres:///db', /names no host/u],
  ])('rejects %s', (_label, value, pattern) => {
    expect(() => parseDatabaseUrl(value)).toThrow(pattern);
  });

  it('never puts the connection string into the error, because it carries a password', () => {
    const secret = 'mysql://user:hunter2@host/db';
    expect(() => parseDatabaseUrl(secret)).toThrow();
    try {
      parseDatabaseUrl(secret);
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
    }
  });
});

describe('parseMaxConnections', () => {
  it('defaults when unset or blank', () => {
    expect(parseMaxConnections(undefined)).toBe(10);
    expect(parseMaxConnections('   ')).toBe(10);
    expect(parseMaxConnections(undefined, 4)).toBe(4);
  });

  it('accepts a positive integer', () => {
    expect(parseMaxConnections('1')).toBe(1);
    expect(parseMaxConnections(' 25 ')).toBe(25);
  });

  it.each(['0', '-1', '1.5', '1e3', '12abc', 'NaN', 'Infinity', '1001'])('rejects %s', (value) => {
    expect(() => parseMaxConnections(value)).toThrow(/DATABASE_POOL_MAX/u);
  });
});

describe('readDatabaseConfig', () => {
  it('reads a whole configuration from an environment object', () => {
    expect(
      readDatabaseConfig({ DATABASE_URL: 'postgres://u@h/d', DATABASE_POOL_MAX: '3' }),
    ).toEqual({
      url: 'postgres://u@h/d',
      maxConnections: 3,
    });
  });

  it('fails when DATABASE_URL is absent rather than defaulting to a local database', () => {
    expect(() => readDatabaseConfig({})).toThrow(/DATABASE_URL is unset/u);
  });
});

/**
 * S1-25 (issue #510): a pool without an `error` listener turns a server-terminated idle client
 * (57P01 on Ctrl+C) into an uncaught exception. Every pool now reports a redacted code instead.
 */
describe('createPool error handling', () => {
  const offlineConfig = { url: 'postgres://u:hunter2@127.0.0.1:1/d', maxConnections: 1 };
  const terminated = (): Error =>
    Object.assign(
      new Error('terminating connection due to administrator command postgres://u:hunter2@h/d'),
      { code: '57P01' },
    );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports only the SQLSTATE of a pool error and does not throw', async () => {
    const reports: DatabaseConnectionErrorReport[] = [];
    const pool = createPool(offlineConfig, { onError: (report) => reports.push(report) });
    try {
      expect(() => pool.emit('error', terminated())).not.toThrow();
      expect(reports).toEqual([{ code: '57P01' }]);
    } finally {
      await pool.end();
    }
  });

  it('logs one redacted line by default, without the message, URL or password', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const pool = createPool(offlineConfig);
    try {
      pool.emit('error', terminated());
    } finally {
      await pool.end();
    }
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toContain('57P01');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('postgres://');
    expect(line).not.toContain('administrator command');
  });

  it('swallows a sink that throws', async () => {
    const pool = createPool(offlineConfig, {
      onError: () => {
        throw new Error('sink failed');
      },
    });
    try {
      expect(() => pool.emit('error', terminated())).not.toThrow();
    } finally {
      await pool.end();
    }
  });

  it('gives a connected client a silent error listener', async () => {
    const reports: DatabaseConnectionErrorReport[] = [];
    const pool = createPool(offlineConfig, { onError: (report) => reports.push(report) });
    const client = new EventEmitter();
    try {
      pool.emit('connect', client);
      expect(() => client.emit('error', new Error('x'))).not.toThrow();
      // The checked-out client's next query rejects to its caller; nothing is reported twice.
      expect(reports).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});

describe('databaseConnectionErrorCode', () => {
  it.each([
    ['a SQLSTATE', { code: '57P01' }, '57P01'],
    ['a Node errno', { code: 'ECONNRESET' }, 'ECONNRESET'],
    ['a numeric code', { code: 57 }, 'unknown'],
    ['a lowercase code', { code: 'econnreset' }, 'unknown'],
    ['a code carrying text', { code: 'postgres://u:hunter2@h' }, 'unknown'],
    ['no code', new Error('boom'), 'unknown'],
    ['a string', 'boom', 'unknown'],
    ['null', null, 'unknown'],
  ])('maps %s', (_label, error, expected) => {
    expect(databaseConnectionErrorCode(error)).toBe(expected);
  });
});

describe.skipIf(testDatabaseUrl === null)('createPool against PostgreSQL (#510)', () => {
  it('reports a server-terminated idle client as 57P01 instead of crashing', async () => {
    const applicationName = `aw_client_test_${String(process.pid)}_${String(Date.now())}`;
    const url = new URL(testDatabaseUrl ?? '');
    url.searchParams.set('application_name', applicationName);
    const reports: DatabaseConnectionErrorReport[] = [];
    const pool = createPool(
      { url: url.toString(), maxConnections: 1 },
      { onError: (report) => reports.push(report) },
    );
    const admin = new pg.Client({ connectionString: testDatabaseUrl ?? '' });
    try {
      await pool.query('select 1');
      expect(pool.idleCount).toBe(1);
      await admin.connect();
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity ' +
          'where pid <> pg_backend_pid() and datname = current_database() and application_name = $1',
        [applicationName],
      );
      await vi.waitFor(
        () => {
          expect(reports).toContainEqual({ code: '57P01' });
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      await admin.end();
      await pool.end();
    }
  }, 30_000);

  // The checked-out client's listener is silent, so the caller must learn of the loss from its
  // next query: it rejects rather than hanging, and the process does not crash (review of #510).
  it('rejects the next query of a checked-out client whose backend was terminated', async () => {
    const applicationName = `aw_client_out_${String(process.pid)}_${String(Date.now())}`;
    const url = new URL(testDatabaseUrl ?? '');
    url.searchParams.set('application_name', applicationName);
    const reports: DatabaseConnectionErrorReport[] = [];
    const pool = createPool(
      { url: url.toString(), maxConnections: 1 },
      { onError: (report) => reports.push(report) },
    );
    const admin = new pg.Client({ connectionString: testDatabaseUrl ?? '' });
    const client = await pool.connect();
    let released = false;
    try {
      await client.query('select 1');
      await admin.connect();
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity ' +
          'where pid <> pg_backend_pid() and datname = current_database() and application_name = $1',
        [applicationName],
      );
      // No listener of the test's own: the pool's silent one is all that keeps this from crashing.
      await vi.waitFor(
        async () => {
          const { rowCount } = await admin.query(
            'select 1 from pg_stat_activity where application_name = $1',
            [applicationName],
          );
          expect(rowCount).toBe(0);
        },
        { timeout: 10_000, interval: 50 },
      );
      await expect(client.query('select 1')).rejects.toBeInstanceOf(Error);
      // Silent while checked out: the caller's rejection is the one report.
      expect(reports).toEqual([]);
      client.release(true);
      released = true;
    } finally {
      if (!released) client.release(true);
      await admin.end();
      await pool.end();
    }
  }, 30_000);

  // `pg.Pool#end()` resolves before its clients have closed; a server stopped then answers their
  // unread Terminate with 57P01 (the S1-25 merge CI failure). `closePool` waits for each close.
  it('closePool resolves only after every connection the pool opened has closed', async () => {
    const pool = createPool({ url: testDatabaseUrl ?? '', maxConnections: 3 });
    let removed = 0;
    pool.on('remove', () => {
      removed += 1;
    });
    const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
    for (const client of clients) client.release();
    expect(pool.idleCount).toBe(3);
    await closePool(pool);
    expect(removed).toBe(3);
    expect(pool.totalCount).toBe(0);
  }, 30_000);
});

describe('closePool', () => {
  it('ends a pool that never connected without waiting', async () => {
    const pool = createPool({ url: 'postgres://127.0.0.1:1/never', maxConnections: 1 });
    await closePool(pool);
    expect(pool.ended).toBe(true);
  });

  it('ends a pool it did not create', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://127.0.0.1:1/never' });
    await closePool(pool);
    expect(pool.ended).toBe(true);
  });
});
