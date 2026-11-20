/**
 * Teardown of an isolated test database: close the owned pool, prove no other client session
 * remains, prefer a normal drop, force-drop a leak, verify absence, and report every failure.
 */
import { setTimeout as delay } from 'node:timers/promises';

import type pg from 'pg';

import {
  administrativeClient,
  endRecordingFailure,
  postgresErrorCode,
  type AdminContext,
} from './testing-admin.js';

const POOL_QUIESCENCE_TIMEOUT_MS = 10_000;
const POOL_QUIESCENCE_POLL_MS = 25;
const SAFE_METADATA = /^[a-zA-Z0-9 ._:/()-]{1,64}$/u;

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

/** What a teardown needs to know about the database it owns. */
export interface TeardownTarget {
  readonly admin: AdminContext;
  readonly prefix: string;
  readonly suiteApplicationName: string;
  readonly pool: pg.Pool;
}

/** What the cleanup steps observed; every code is a credential-free PostgreSQL error code. */
interface CleanupOutcome {
  activities: DatabaseSession[];
  activityCode: string | null;
  normalDropCode: string | null;
  forceDropCode: string | null;
  verificationCode: string | null;
  databaseRemains: boolean;
}

function safeMetadata(value: string | null): string {
  if (value === null || value === '') return '<unset>';
  return SAFE_METADATA.test(value) ? value : '<redacted>';
}

function activityDiagnostic(target: TeardownTarget, row: DatabaseSession): string {
  const isSuiteConnection = row.application_name === target.suiteApplicationName;
  const owner = isSuiteConnection ? target.prefix : 'external';
  return [
    `pid=${String(row.pid)}`,
    `owner=${owner}`,
    `application=${isSuiteConnection ? 'suite' : '<redacted>'}`,
    `state=${safeMetadata(row.state)}`,
    `backend=${safeMetadata(row.backend_type)}`,
    'query=<redacted>',
  ].join(' ');
}

function connectionErrorDiagnostic(errors: AdminContext['errors']): string {
  return errors.map(({ owner, code }) => `owner=${owner} code=${code}`).join('; ');
}

async function endOwnedPool(pool: pg.Pool): Promise<string | null> {
  try {
    await pool.end();
    return null;
  } catch (error) {
    return postgresErrorCode(error);
  }
}

async function readActivities(
  inspector: pg.Client,
  databaseName: string,
): Promise<DatabaseSession[]> {
  const result = await inspector.query<DatabaseSession>(
    `select pid, application_name, state, backend_type
       from pg_stat_activity
      where datname = $1 and pid <> pg_backend_pid()
      order by pid`,
    [databaseName],
  );
  return leakedSessions(result.rows);
}

/**
 * Read sessions into `outcome`, waiting briefly while only the suite's own closing pool connections
 * remain. Each read is recorded as it lands, so a later failed poll still reports the last sessions seen.
 */
async function readSettledActivities(
  inspector: pg.Client,
  target: TeardownTarget,
  outcome: CleanupOutcome,
): Promise<void> {
  const { databaseName } = target.admin;
  outcome.activities = await readActivities(inspector, databaseName);
  const quiescenceDeadline = Date.now() + POOL_QUIESCENCE_TIMEOUT_MS;
  while (
    outcome.activities.length > 0 &&
    outcome.activities.every((row) => row.application_name === target.suiteApplicationName) &&
    Date.now() < quiescenceDeadline
  ) {
    await delay(POOL_QUIESCENCE_POLL_MS);
    outcome.activities = await readActivities(inspector, databaseName);
  }
}

async function inspectActivities(
  inspector: pg.Client,
  target: TeardownTarget,
  outcome: CleanupOutcome,
): Promise<void> {
  try {
    await readSettledActivities(inspector, target, outcome);
  } catch (error) {
    outcome.activityCode = postgresErrorCode(error);
  }
}

async function verifyDatabaseAbsent(
  inspector: pg.Client,
  databaseName: string,
  outcome: CleanupOutcome,
): Promise<void> {
  try {
    const result = await inspector.query<{ present: boolean }>(
      'select exists(select 1 from pg_database where datname = $1) as present',
      [databaseName],
    );
    outcome.databaseRemains = result.rows[0]?.present !== false;
  } catch (error) {
    outcome.verificationCode = postgresErrorCode(error);
  }
}

/** Drop normally when the inspection was clean, force-drop otherwise, then verify the result. */
async function dropAndVerify(
  inspector: pg.Client,
  target: TeardownTarget,
  outcome: CleanupOutcome,
): Promise<void> {
  const { databaseName } = target.admin;
  await inspectActivities(inspector, target, outcome);

  if (outcome.activityCode === null && outcome.activities.length === 0) {
    try {
      await inspector.query(`drop database if exists "${databaseName}"`);
    } catch (error) {
      outcome.normalDropCode = postgresErrorCode(error);
    }
  }

  const needsForce =
    outcome.activityCode !== null ||
    outcome.activities.length > 0 ||
    outcome.normalDropCode !== null;
  if (needsForce) {
    try {
      await inspector.query(`drop database if exists "${databaseName}" with (force)`);
    } catch (error) {
      outcome.forceDropCode = postgresErrorCode(error);
    }
  }

  await verifyDatabaseAbsent(inspector, databaseName, outcome);
}

async function cleanupDatabase(target: TeardownTarget): Promise<CleanupOutcome> {
  const outcome: CleanupOutcome = {
    activities: [],
    activityCode: null,
    normalDropCode: null,
    forceDropCode: null,
    verificationCode: null,
    databaseRemains: false,
  };
  const inspector = administrativeClient(target.admin, 'inspector', 'inspector');
  try {
    await inspector.connect();
    await dropAndVerify(inspector, target, outcome);
  } catch (error) {
    outcome.forceDropCode = postgresErrorCode(error);
  } finally {
    await endRecordingFailure(inspector, target.admin, 'inspector');
  }
  return outcome;
}

function describeFailures(
  target: TeardownTarget,
  poolEndCode: string | null,
  outcome: CleanupOutcome,
): string[] {
  const failures: string[] = [];
  if (poolEndCode !== null) failures.push(`owned pool close failed (code=${poolEndCode})`);
  if (outcome.activityCode !== null) {
    failures.push(`pg_stat_activity inspection failed (code=${outcome.activityCode})`);
  }
  if (outcome.forceDropCode !== null) {
    failures.push(`bounded force cleanup failed (code=${outcome.forceDropCode})`);
  }
  if (outcome.verificationCode !== null) {
    failures.push(`database absence verification failed (code=${outcome.verificationCode})`);
  }
  if (outcome.databaseRemains) {
    const normalDrop =
      outcome.normalDropCode === null ? '' : ` (normal drop code=${outcome.normalDropCode})`;
    failures.push(`database remained after cleanup${normalDrop}`);
  }
  if (outcome.activities.length > 0) {
    const sessions = outcome.activities.map((row) => activityDiagnostic(target, row)).join('; ');
    failures.push(`connections remained after the owned pool closed: ${sessions}`);
  }
  if (target.admin.errors.length > 0) {
    failures.push(
      `connection errors were recorded: ${connectionErrorDiagnostic(target.admin.errors)}`,
    );
  }
  return failures;
}

/** Close the owned pool and drop the database, raising one diagnostic once cleanup has finished. */
export async function teardownIsolatedDatabase(target: TeardownTarget): Promise<void> {
  const poolEndCode = await endOwnedPool(target.pool);
  const outcome = await cleanupDatabase(target);
  const failures = describeFailures(target, poolEndCode, outcome);
  if (failures.length > 0) {
    throw new Error(
      `Isolated PostgreSQL teardown failed for ${target.prefix}. Cleanup completed before this ` +
        `diagnostic was raised. ${failures.join(' ')}`,
    );
  }
}
