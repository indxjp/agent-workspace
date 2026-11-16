import type { createPool } from '../client.js';
import type { DatabaseRoot, LockOutcome } from './root.js';

type Pool = ReturnType<typeof createPool>;

type RootLocks = Pick<
  DatabaseRoot,
  'tryAcquireMaintenanceLease' | 'withWorkspaceSetupLock' | 'withNamedLock'
>;

/** How long a waiter sleeps between two tries of the setup lock: short at first, then capped. */
const SETUP_LOCK_RETRY_MS = [25, 50, 100, 200, 250] as const;

const TRY_ADVISORY_LOCK_SQL = 'select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired';
const ADVISORY_UNLOCK_SQL = 'select pg_advisory_unlock(hashtextextended($1, 0))';

/** Try the session-level advisory lock `key` on a held pool client until `waitMs` has passed. */
async function withAdvisoryLock<T>(
  pool: Pool,
  key: string,
  waitMs: number,
  work: () => Promise<T>,
): Promise<LockOutcome<T>> {
  const deadline = Date.now() + Math.max(0, waitMs);
  const client = await pool.connect();
  // Only a client whose unlock failed may still hold the lock; it is destroyed, not pooled.
  let unlockFailure: Error | undefined;
  try {
    for (let attempt = 0; ; attempt += 1) {
      const tried = await client.query<{ acquired: boolean }>(TRY_ADVISORY_LOCK_SQL, [key]);
      if (tried.rows[0]?.acquired === true) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { acquired: false };
      const pause = SETUP_LOCK_RETRY_MS[Math.min(attempt, SETUP_LOCK_RETRY_MS.length - 1)];
      await new Promise((resolve) => setTimeout(resolve, Math.min(pause ?? 250, remaining)));
    }
    try {
      return { acquired: true, value: await work() };
    } finally {
      await client.query(ADVISORY_UNLOCK_SQL, [key]).catch((error: unknown) => {
        unlockFailure = error instanceof Error ? error : new Error(String(error));
      });
    }
  } finally {
    client.release(unlockFailure);
  }
}

/** The advisory locks and leases of {@link DatabaseRoot}, each on a pool client held for its life. */
export function rootLocks(pool: Pool): RootLocks {
  return {
    async tryAcquireMaintenanceLease(name, ttlMs) {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
        throw new Error('maintenance lease TTL must be a positive safe integer');
      }
      const client = await pool.connect();
      const acquired = await client.query<{ acquired: boolean }>(TRY_ADVISORY_LOCK_SQL, [name]);
      if (acquired.rows[0]?.acquired !== true) {
        client.release();
        return null;
      }
      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        clearTimeout(expiry);
        try {
          await client.query(ADVISORY_UNLOCK_SQL, [name]);
        } finally {
          client.release();
        }
      };
      const expiry = setTimeout(() => void release(), ttlMs);
      expiry.unref();
      return { release };
    },
    async withWorkspaceSetupLock<T>(
      workspaceId: string,
      waitMs: number,
      work: () => Promise<T>,
    ): Promise<LockOutcome<T>> {
      return withAdvisoryLock(pool, `agent-workspace:setup:${workspaceId}`, waitMs, work);
    },
    withNamedLock<T>(name: string, work: () => Promise<T>): Promise<LockOutcome<T>> {
      return withAdvisoryLock(pool, `agent-workspace:lock:${name}`, 0, work);
    },
  };
}
