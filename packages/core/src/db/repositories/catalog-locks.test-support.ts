import { setTimeout as delay } from 'node:timers/promises';
import { sql, type SQL } from 'drizzle-orm';
import { expect } from 'vitest';
import type { IsolatedTestDatabase } from './testing.js';

/** How often, and how many times, `lockWaiters` asks `pg_locks` before it gives up. */
const LOCK_WAITER_POLL_MS = 5;
const LOCK_WAITER_POLLS = 400;

export async function holdTransactionLock(db: IsolatedTestDatabase['db'], lock: SQL) {
  let held = (): void => undefined;
  let release = (): void => undefined;
  const lockHeld = new Promise<void>((resolve) => (held = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const holder = db.transaction(async (tx) => {
    await tx.execute(lock);
    held();
    await released;
  });
  await lockHeld;
  return async () => {
    release();
    await holder;
  };
}

/**
 * Resolves once `count` sessions of this test database wait for an advisory lock: a barrier that
 * proves a writer reached its lock. Polled on the test pool, which no writer uses, until
 * `settled` does, so a race it loses leaves no query running; a writer that neither waits nor
 * settles fails the test after `polls` polls instead of spinning until the suite timeout.
 */
export async function lockWaiters(
  db: IsolatedTestDatabase['db'],
  {
    count,
    settled,
    polls = LOCK_WAITER_POLLS,
  }: {
    readonly count: number;
    readonly settled: Promise<unknown>;
    readonly polls?: number;
  },
): Promise<void> {
  let stop = false;
  void settled.then(
    () => (stop = true),
    () => (stop = true),
  );
  for (let poll = 0; poll < polls; poll += 1) {
    if (stop) return;
    const result = await db.execute(
      sql`select count(*)::int as waiting from pg_locks l join pg_database d on d.oid = l.database
          where d.datname = current_database() and l.locktype = 'advisory' and not l.granted`,
    );
    const waiting = Number((result.rows[0] as { waiting?: unknown } | undefined)?.waiting ?? 0);
    if (waiting >= count) return;
    await delay(LOCK_WAITER_POLL_MS);
  }
  if (stop) return;
  throw new Error(
    `After ${String(polls)} polls, no session waited for an advisory lock (wanted ${String(count)}).`,
  );
}

/**
 * Hold `lock` in a transaction on the test pool, start `write` on the race pool, and prove it waits
 * for the lock: queued on an advisory lock while it is held, done once the lock is released.
 */
export async function expectWaitsFor(
  db: IsolatedTestDatabase['db'],
  lock: SQL,
  write: () => Promise<unknown>,
): Promise<void> {
  const release = await holdTransactionLock(db, lock);
  let done = false;
  const writing = write().finally(() => (done = true));
  try {
    await Promise.race([lockWaiters(db, { count: 1, settled: writing }), writing]);
    expect(done).toBe(false);
  } finally {
    await release();
  }
  await writing;
  expect(done).toBe(true);
}

/** Hold `lock` and prove `write` finishes without waiting for it. */
export async function expectRunsBeside(
  db: IsolatedTestDatabase['db'],
  lock: SQL,
  write: () => Promise<unknown>,
): Promise<void> {
  const release = await holdTransactionLock(db, lock);
  try {
    const writing = write();
    const outcome = await Promise.race([
      writing.then(() => 'done'),
      lockWaiters(db, { count: 1, settled: writing }).then(() => 'blocked'),
    ]);
    expect(outcome).toBe('done');
  } finally {
    await release();
  }
}
