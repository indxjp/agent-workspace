import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import type { Logger } from '@agent-workspace/core/telemetry';

import { runCleanupTick } from './cleanup-cron';

// Two roots on one database stand for two servers: each has its own pool, so the lock between them
// is PostgreSQL's, not the process's. No skip: without TEST_DATABASE_URL this suite fails loudly.
let isolated: IsolatedTestDatabase | undefined;
const roots: DatabaseRoot[] = [];

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase('aw_storage_cleanup_lock');
  for (let server = 0; server < 2; server += 1) {
    roots.push(await openDatabaseRoot({ DATABASE_URL: isolated.url }));
  }
}, 180_000);

afterAll(async () => {
  await Promise.all(roots.map((root) => root.close()));
  await isolated?.close();
});

const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};

function server(index: number) {
  const root = roots[index];
  if (root === undefined) throw new Error('the test servers did not start');
  return root;
}

describe('the storage cleanup lock', () => {
  // @story US-STO-14
  it('[US-STO-14][unit][sdk] cleanup runs once across two servers', async () => {
    let passes = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pass = async () => {
      passes += 1;
      markStarted();
      await gate;
      return 'done';
    };
    const tick = (index: number) =>
      runCleanupTick({
        lock: (name, work) => server(index).withNamedLock(name, work),
        pass,
        log: silent,
      });

    const first = tick(0);
    await started;
    const second = await tick(1);
    release();

    expect(second).toEqual({ acquired: false });
    await expect(first).resolves.toEqual({ acquired: true, value: 'done' });
    expect(passes).toBe(1);
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] a pass that throws releases the cleanup lock', async () => {
    const lock =
      (index: number) =>
      <R>(name: string, work: () => Promise<R>) =>
        server(index).withNamedLock(name, work);
    await expect(
      runCleanupTick({
        lock: lock(0),
        pass: () => Promise.reject(new Error('the pass failed')),
        log: silent,
      }),
    ).rejects.toThrow('the pass failed');

    await expect(
      runCleanupTick({ lock: lock(1), pass: () => Promise.resolve('after'), log: silent }),
    ).resolves.toEqual({ acquired: true, value: 'after' });
  });
});
