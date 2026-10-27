import { setTimeout as delay } from 'node:timers/promises';

import { sql } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  leakedSessions,
  relaxesDurability,
  type IsolatedTestDatabase,
} from './testing.js';

const adminUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = Boolean(adminUrl?.trim());

if (!hasDatabase) {
  console.warn(
    '[repositories/testing.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so deterministic ' +
      'isolated PostgreSQL teardown was NOT exercised.',
  );
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

function taggedUrl(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('application_name', applicationName);
  return parsed.toString();
}

async function databaseExists(name: string): Promise<boolean> {
  if (adminUrl === undefined) throw new Error('TEST_DATABASE_URL is required by this test.');
  const errors: Error[] = [];
  const client = new pg.Client({
    connectionString: taggedUrl(adminUrl, 'aw:rf002:existence-check'),
  });
  client.on('error', (error) => errors.push(error));
  try {
    await client.connect();
    const result = await client.query<{ present: boolean }>(
      'select exists(select 1 from pg_database where datname = $1) as present',
      [name],
    );
    expect(errors).toEqual([]);
    return result.rows[0]?.present === true;
  } finally {
    await client.end();
  }
}

async function waitForConnectionError(errorPromise: Promise<Error>): Promise<Error> {
  return Promise.race([
    errorPromise,
    delay(5_000).then(() => {
      throw new Error('PostgreSQL did not report the forced connection termination within 5s.');
    }),
  ]);
}

function isolatedWithoutDatabase(close: () => Promise<void>): IsolatedTestDatabase {
  return {
    url: 'postgres://unused.test/unused',
    get db(): never {
      throw new Error('This database-free test must not access the database handle.');
    },
    close,
  };
}

describe('closeIsolatedTestResources', () => {
  it('closes every resource before the isolated database on the happy path', async () => {
    const closed: string[] = [];
    const isolated = isolatedWithoutDatabase(() => {
      closed.push('database');
      return Promise.resolve();
    });

    await closeIsolatedTestResources(
      isolated,
      {
        close(): Promise<void> {
          closed.push('first resource');
          return Promise.resolve();
        },
      },
      {
        close(): Promise<void> {
          closed.push('second resource');
          return Promise.resolve();
        },
      },
    );

    expect(closed).toEqual(['first resource', 'second resource', 'database']);
  });

  it('waits for asynchronous resource cleanup before closing the isolated database', async () => {
    const closed: string[] = [];
    let releaseResource = (): void => undefined;
    const resourceClosed = new Promise<void>((resolve) => {
      releaseResource = resolve;
    });
    const isolated = isolatedWithoutDatabase(() => {
      closed.push('database');
      return Promise.resolve();
    });

    const cleanup = closeIsolatedTestResources(isolated, {
      close(): Promise<void> {
        closed.push('resource started');
        return resourceClosed.then(() => {
          closed.push('resource finished');
        });
      },
    });
    await Promise.resolve();

    expect(closed).toEqual(['resource started']);
    releaseResource();
    await cleanup;
    expect(closed).toEqual(['resource started', 'resource finished', 'database']);
  });

  it('still closes the isolated database after synchronous and asynchronous failures', async () => {
    const syncError = new Error('synchronous resource close failed');
    const asyncError = new Error('asynchronous resource close failed');
    const attempted: string[] = [];
    const isolated = isolatedWithoutDatabase(() => {
      attempted.push('database');
      return Promise.resolve();
    });

    let failure: unknown;
    try {
      await closeIsolatedTestResources(
        isolated,
        {
          close(): Promise<void> {
            attempted.push('sync failure');
            throw syncError;
          },
        },
        {
          close(): Promise<void> {
            attempted.push('async failure');
            return Promise.reject(asyncError);
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(attempted).toEqual(['sync failure', 'async failure', 'database']);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error('Expected resource cleanup to raise an AggregateError.');
    }
    expect(failure.errors).toEqual([syncError, asyncError]);
  });
});

describe('leakedSessions', () => {
  const suiteBackend = {
    pid: 101,
    application_name: 'aw:0000000000000000000000001:suite',
    state: 'idle',
    backend_type: 'client backend',
  };

  it('reports every client backend still attached, whoever opened it', () => {
    const externalBackend = {
      pid: 102,
      application_name: 'someone_else',
      state: 'idle in transaction',
      backend_type: 'client backend',
    };

    expect(leakedSessions([suiteBackend, externalBackend])).toEqual([
      suiteBackend,
      externalBackend,
    ]);
  });

  it('ignores the server’s own workers, which detach on their own', () => {
    // An autovacuum worker attaches to whichever database it is maintaining, so a long-lived
    // isolated database — which is what a coverage run produces — can carry one at teardown. It is
    // the server working, not a suite that forgot to close a connection, and `DROP DATABASE`
    // signals it away. Treating it as a leak failed teardown for a correct run.
    const autovacuumWorker = {
      pid: 103,
      application_name: '',
      state: 'active',
      backend_type: 'autovacuum worker',
    };

    expect(leakedSessions([autovacuumWorker])).toEqual([]);
    expect(leakedSessions([autovacuumWorker, suiteBackend])).toEqual([suiteBackend]);
  });
});

describe('relaxesDurability', () => {
  const disposable = { githubActions: true, superuser: true, fsync: 'on', fullPageWrites: 'on' };

  it('relaxes a disposable superuser CI server that still has durability on', () => {
    expect(relaxesDurability(disposable)).toBe(true);
    expect(relaxesDurability({ ...disposable, fullPageWrites: 'off' })).toBe(true);
    expect(relaxesDurability({ ...disposable, fsync: 'off' })).toBe(true);
  });

  it('leaves a server alone when any single condition fails', () => {
    expect(relaxesDurability({ ...disposable, githubActions: false })).toBe(false);
    expect(relaxesDurability({ ...disposable, superuser: false })).toBe(false);
    expect(relaxesDurability({ ...disposable, fsync: 'off', fullPageWrites: 'off' })).toBe(false);
  });
});

describe.skipIf(!hasDatabase)('isolated PostgreSQL teardown', () => {
  it('closes every resource before dropping the isolated database', async () => {
    const isolated = await createIsolatedTestDatabase('aw_rf002_resources');
    const name = databaseName(isolated.url);
    const closed: string[] = [];

    await closeIsolatedTestResources(
      isolated,
      {
        close(): Promise<void> {
          closed.push('first');
          return Promise.resolve();
        },
      },
      {
        close(): Promise<void> {
          closed.push('second');
          return Promise.resolve();
        },
      },
    );

    expect(closed).toEqual(['first', 'second']);
    await expect(databaseExists(name)).resolves.toBe(false);
  }, 180_000);

  it('aggregates synchronous and asynchronous resource failures after database cleanup', async () => {
    const isolated = await createIsolatedTestDatabase('aw_rf002_resource_failures');
    const name = databaseName(isolated.url);
    const syncError = new Error('synchronous resource close failed');
    const asyncError = new Error('asynchronous resource close failed');
    const attempted: string[] = [];

    let failure: unknown;
    try {
      await closeIsolatedTestResources(
        isolated,
        {
          close(): Promise<void> {
            attempted.push('sync failure');
            throw syncError;
          },
        },
        {
          close(): Promise<void> {
            attempted.push('async failure');
            return Promise.reject(asyncError);
          },
        },
        {
          close(): Promise<void> {
            attempted.push('success');
            return Promise.resolve();
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(attempted).toEqual(['sync failure', 'async failure', 'success']);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error('Expected resource cleanup to raise an AggregateError.');
    }
    expect(failure.errors).toEqual([syncError, asyncError]);
    await expect(databaseExists(name)).resolves.toBe(false);
  }, 180_000);

  it('gives concurrent callers using one readable prefix distinct tagged databases', async () => {
    const [first, second] = await Promise.all([
      createIsolatedTestDatabase('aw_rf002_collision'),
      createIsolatedTestDatabase('aw_rf002_collision'),
    ]);
    const firstName = databaseName(first.url);
    const secondName = databaseName(second.url);

    try {
      expect(firstName).not.toBe(secondName);
      expect(firstName).toMatch(/^aw_rf002_collision_[a-z0-9]{25}$/u);
      expect(secondName).toMatch(/^aw_rf002_collision_[a-z0-9]{25}$/u);
      expect(Buffer.byteLength(firstName, 'utf8')).toBeLessThanOrEqual(63);
      expect(Buffer.byteLength(secondName, 'utf8')).toBeLessThanOrEqual(63);

      const [firstIdentity, secondIdentity] = await Promise.all([
        first.db.execute<{ database: string; application: string }>(
          sql`select current_database() as database, current_setting('application_name') as application`,
        ),
        second.db.execute<{ database: string; application: string }>(
          sql`select current_database() as database, current_setting('application_name') as application`,
        ),
      ]);
      expect(firstIdentity.rows[0]?.database).toBe(firstName);
      expect(secondIdentity.rows[0]?.database).toBe(secondName);
      expect(firstIdentity.rows[0]?.application).toMatch(/^aw:[a-z0-9]{25}:suite$/u);
      expect(secondIdentity.rows[0]?.application).toMatch(/^aw:[a-z0-9]{25}:suite$/u);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  }, 180_000);

  it('shares one clean close promise across concurrent and repeated callers', async () => {
    const longestAcceptedPrefix = `aw_${'x'.repeat(46)}`;
    const isolated = await createIsolatedTestDatabase(longestAcceptedPrefix);
    await isolated.db.execute(sql`select 1`);
    const name = databaseName(isolated.url);
    expect(name).toMatch(new RegExp(`^${longestAcceptedPrefix.slice(0, 37)}_[a-z0-9]{25}$`, 'u'));

    const firstClose = isolated.close();
    const concurrentClose = isolated.close();
    expect(concurrentClose).toBe(firstClose);
    await firstClose;
    expect(isolated.close()).toBe(firstClose);
    await expect(databaseExists(name)).resolves.toBe(false);
  }, 180_000);

  it('reports safe leaked-session metadata, redacts query and secret-like text, then cleans up', async () => {
    const isolated = await createIsolatedTestDatabase('aw_rf002_leak');
    const name = databaseName(isolated.url);
    const safeClient = new pg.Client({
      connectionString: taggedUrl(isolated.url, 'rf002_external_owner'),
    });
    const secretClient = new pg.Client({
      connectionString: taggedUrl(isolated.url, 'RF002_PASSWORD_SECRET'),
    });
    let resolveSafeError: (error: Error) => void = () => undefined;
    let resolveSecretError: (error: Error) => void = () => undefined;
    const safeErrorPromise = new Promise<Error>((resolve) => {
      resolveSafeError = resolve;
    });
    const secretErrorPromise = new Promise<Error>((resolve) => {
      resolveSecretError = resolve;
    });
    safeClient.on('error', resolveSafeError);
    secretClient.on('error', resolveSecretError);

    await Promise.all([safeClient.connect(), secretClient.connect()]);
    await safeClient.query('select 1 /* RF002_QUERY_SECRET */');
    await secretClient.query('select 1');

    let failure: unknown;
    try {
      await isolated.close();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain('owner=external');
    expect(message).toContain('state=idle');
    expect(message).toContain('query=<redacted>');
    expect(message).toContain('application=<redacted>');
    expect(message).not.toContain('rf002_external_owner');
    expect(message).not.toContain('RF002_QUERY_SECRET');
    expect(message).not.toContain('RF002_PASSWORD_SECRET');
    expect(message).not.toContain(isolated.url);
    expect(message).toContain('Cleanup completed before this diagnostic was raised');

    const [safeError, secretError] = await Promise.all([
      waitForConnectionError(safeErrorPromise),
      waitForConnectionError(secretErrorPromise),
    ]);
    expect('code' in safeError ? safeError.code : undefined).toBe('57P01');
    expect('code' in secretError ? secretError.code : undefined).toBe('57P01');
    await Promise.all([
      safeClient.end().catch(() => undefined),
      secretClient.end().catch(() => undefined),
    ]);
    await expect(databaseExists(name)).resolves.toBe(false);
  }, 180_000);

  it('relaxes durability on a disposable CI superuser server', async () => {
    const isolated = await createIsolatedTestDatabase('aw_rf002_durability');
    try {
      const read = async (): Promise<{
        fsync: string;
        full_page_writes: string;
        superuser: boolean;
      }> => {
        const { rows } = await isolated.db.execute<{
          fsync: string;
          full_page_writes: string;
          superuser: boolean;
        }>(
          sql`select current_setting('fsync') as fsync,
                     current_setting('full_page_writes') as full_page_writes,
                     current_setting('is_superuser') = 'on' as superuser`,
        );
        const row = rows[0];
        if (row === undefined) throw new Error('The settings query returned no row.');
        return row;
      };
      let state = await read();
      if (process.env['GITHUB_ACTIONS'] === 'true' && state.superuser) {
        // pg_reload_conf() only signals the postmaster, so give the reload a moment to land.
        const deadline = Date.now() + 5_000;
        while (state.fsync === 'on' && Date.now() < deadline) {
          await delay(50);
          state = await read();
        }
        expect(state.fsync).toBe('off');
        expect(state.full_page_writes).toBe('off');
      }
    } finally {
      await isolated.close();
    }
  }, 180_000);

  it('completes twenty create, query, and clean-close cycles', async () => {
    const closeMs: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const isolated = await createIsolatedTestDatabase('aw_rf002_cycle');
      try {
        const result = await isolated.db.execute<{ value: number }>(sql`select 1::int as value`);
        expect(result.rows[0]?.value).toBe(1);
      } finally {
        const started = performance.now();
        await isolated.close();
        closeMs.push(performance.now() - started);
      }
    }
    const sorted = [...closeMs].sort((a, b) => a - b);
    const at = (fraction: number): number =>
      Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0);
    console.info(
      `[isolated-close] n=${String(sorted.length)} median=${String(at(0.5))} p90=${String(at(0.9))} max=${String(at(1))} ms`,
    );
  }, 300_000);
});
