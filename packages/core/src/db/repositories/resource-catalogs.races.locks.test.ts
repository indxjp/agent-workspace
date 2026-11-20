import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectRunsBeside, expectWaitsFor, lockWaiters } from './catalog-locks.test-support.js';
import {
  closeRaceHarness,
  createRaceHarness,
  exclusiveWorkspaceLock,
  pathLock,
  RACE_SETUP_TIMEOUT_MS,
  reserveInput,
  rowsAt,
  rowsFor,
  seedFile,
  sharedWorkspaceLock,
  type RaceHarness,
} from './resource-catalogs.races.test-support.js';

async function expectReserveConfirmForgetWaitForPathLock(h: RaceHarness) {
  const { catalog, isolated } = h;
  const path = 'lock-proof/a.bin';
  await seedFile(h, path);
  await expectWaitsFor(isolated.db, pathLock(h, path), () =>
    catalog.reserve(path, reserveInput(h)),
  );
  const [pending] = (await rowsFor(h, path)).filter((row) => row.status === 'pending');
  if (pending === undefined) throw new Error('the reserve did not land');

  await expectWaitsFor(isolated.db, pathLock(h, path), () =>
    catalog.confirm(pending, { sizeBytes: 2, contentType: null }),
  );
  expect((await rowsFor(h, path)).filter((row) => row.status === 'deleting')).toHaveLength(1);

  const other = 'lock-proof/b.bin';
  await seedFile(h, other);
  const reserved = await catalog.reserve(other, reserveInput(h));
  await expectWaitsFor(isolated.db, pathLock(h, other), () => catalog.forget(reserved.row));
  expect((await rowsFor(h, other)).map((row) => row.status)).toEqual(['ready']);
}

async function expectRemoveWaitsForPathLockOnly(h: RaceHarness) {
  const { catalog, isolated } = h;
  const path = 'lock-proof/remove.bin';
  await seedFile(h, path);
  await expectWaitsFor(isolated.db, pathLock(h, path), () => catalog.remove(path));
  expect((await rowsFor(h, path)).map((row) => row.status)).toEqual(['deleting']);

  // A shared workspace lock is what every single-path writer holds, so a one-file remove takes
  // it too and does not wait; only a prefix writer would.
  const other = 'lock-proof/remove-beside.bin';
  await seedFile(h, other);
  await expectRunsBeside(isolated.db, sharedWorkspaceLock(h), () => catalog.remove(other));
  expect((await rowsFor(h, other)).map((row) => row.status)).toEqual(['deleting']);
}

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('the PostgreSQL catalog locks under concurrent requests', () => {
  let h: RaceHarness;

  beforeAll(async () => {
    h = await createRaceHarness('aw_resource_catalog_locks');
  }, RACE_SETUP_TIMEOUT_MS);

  afterAll(async () => closeRaceHarness(h));

  it('the lock barrier fails with a clear message when no session ever waits', async () => {
    const never = new Promise<never>(() => undefined);
    await expect(
      lockWaiters(h.isolated.db, { count: 1, settled: never, polls: 3 }),
    ).rejects.toThrow('no session waited for an advisory lock');
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a file write waits for the lock of the path it writes', async () => {
    await expectWaitsFor(h.isolated.db, pathLock(h, 'lock-wait/a.bin'), () =>
      seedFile(h, 'lock-wait/a.bin'),
    );
    expect(await rowsAt(h, 'lock-wait/a.bin')).toHaveLength(1);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a rename waits for a single-path writer of its workspace', async () => {
    await seedFile(h, 'lock-wait/from.bin');
    await expectWaitsFor(h.isolated.db, sharedWorkspaceLock(h), () =>
      h.catalog.rename('lock-wait/from.bin', 'lock-wait/to.bin'),
    );
    expect(await rowsAt(h, 'lock-wait/to.bin')).toHaveLength(1);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a single-path writer waits for a prefix writer of its workspace', async () => {
    await expectWaitsFor(h.isolated.db, exclusiveWorkspaceLock(h), () =>
      seedFile(h, 'workspace-wait/a.bin'),
    );
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] reserve, confirm and forget wait for the lock of the path they write', async () => {
    await expectReserveConfirmForgetWaitForPathLock(h);
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] removing one file waits for its path lock but runs beside other single-path writers', async () => {
    await expectRemoveWaitsForPathLockOnly(h);
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] removing a folder waits for a single-path writer of its workspace', async () => {
    await seedFile(h, 'lock-proof/dir/a.bin');
    await expectWaitsFor(h.isolated.db, sharedWorkspaceLock(h), () =>
      h.catalog.remove('lock-proof/dir'),
    );
    expect((await rowsFor(h, 'lock-proof/dir/a.bin')).map((row) => row.status)).toEqual([
      'deleting',
    ]);
  });
});
