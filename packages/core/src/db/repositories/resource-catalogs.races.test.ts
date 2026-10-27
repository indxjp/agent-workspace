import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { and, eq, type SQL, sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, connect } from '../client.js';
import { files } from '../schema/files.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import {
  CatalogPathTakenError,
  createDatabaseResourceCatalogRepositoryProvider,
  type ResourceCatalogRepository,
} from './resource-catalogs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { postgresViolations } from './violations.js';
import {
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

/** Pool size of the racing connection; the isolated database's own pool holds only four. */
const RACE_CONNECTIONS = 10;

/** How long a writer must stay blocked behind a held lock; generous for a loaded CI database. */
const BLOCKED_MS = 300;

// The storage design, §07: what memory cannot prove is one winner per path when many requests
// arrive at once, so these cases run on PostgreSQL only.
describe.skipIf(!hasDatabase)('the PostgreSQL catalog under concurrent requests', () => {
  let isolated: IsolatedTestDatabase;
  let racePool: pg.Pool;
  let catalog: ResourceCatalogRepository;
  let workspaceId: string;
  let userId: string;
  let principalId: string;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_resource_catalog_races');
    const { db } = isolated;
    workspaceId = crypto.randomUUID();
    userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    principalId = crypto.randomUUID();
    await db.insert(workspaces).values({ id: workspaceId, slug: 'races', name: 'races' });
    await db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Race owner' });
    await db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('race workspace scope did not resolve');

    const raced = connect({ url: isolated.url, maxConnections: RACE_CONNECTIONS });
    racePool = raced.pool;
    catalog = createDatabaseResourceCatalogRepositoryProvider(raced.db).forScope(scope);
  }, 180_000);

  afterAll(async () => closeIsolatedTestResources(isolated, { close: () => closePool(racePool) }));

  const rowsAt = (path: string) =>
    isolated.db
      .select()
      .from(files)
      .where(and(eq(files.workspaceId, workspaceId), eq(files.path, path)));

  /** Every row standing for `path`, whether at the path itself or waiting at a side path. */
  const rowsFor = (path: string) =>
    isolated.db
      .select()
      .from(files)
      .where(
        and(
          eq(files.workspaceId, workspaceId),
          sql`coalesce(${files.targetPath}, ${files.path}) = ${path}`,
        ),
      );

  const putInput = (path: string, sizeBytes: number) => ({
    path,
    kind: 'file' as const,
    storageKey: path,
    sizeBytes,
    contentType: null,
    ownerPrincipalId: principalId,
    createdBy: userId,
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] 20 concurrent reserves of one path give one winner and 19 taken', async () => {
    const input = { ownerPrincipalId: principalId, sizeBytes: 1, contentType: null };
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => catalog.reserve('reserve-race/a.bin', input)),
    );

    const winners = outcomes.filter((outcome) => outcome.kind === 'reserved');
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'taken')).toHaveLength(19);
    const winnerId = winners[0]?.row.id;
    expect(new Set(outcomes.map((outcome) => outcome.row.id))).toEqual(new Set([winnerId]));

    const rows = await rowsAt('reserve-race/a.bin');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: winnerId, status: 'pending' });
    expect(await rowsAt('reserve-race')).toHaveLength(1);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] 20 concurrent putFile calls on one path leave one ready row', async () => {
    const sizes = Array.from({ length: 20 }, (_, index) => index + 1);
    const saved = await Promise.all(
      sizes.map((size) => catalog.putFile(putInput('put-race/a.bin', size))),
    );

    expect(new Set(saved.map((row) => row.id)).size).toBe(1);
    const rows = await rowsAt('put-race/a.bin');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'ready' });
    expect(sizes).toContain(rows[0]?.sizeBytes);
    expect(await rowsAt('put-race')).toHaveLength(1);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] 10 concurrent publishes of one skill are numbered 1 to 10', async () => {
    await catalog.putSkill({
      name: 'raced',
      skillMd: '# raced',
      enabled: true,
      ownerPrincipalId: principalId,
      createdBy: userId,
    });
    const published = await Promise.all(
      Array.from({ length: 10 }, () =>
        catalog.publishSkillRevision('raced', {
          fileCount: 1,
          write: () => Promise.resolve(undefined),
        }),
      ),
    );

    const expected = Array.from({ length: 10 }, (_, index) => index + 1);
    expect(
      published.map((revision) => revision?.number).sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual(expected);
    const listed = await catalog.listSkillRevisions('raced');
    expect(listed.map((revision) => revision.number).sort((a, b) => a - b)).toEqual(expected);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a confirm racing a remove never leaves a pending orphan', async () => {
    const input = { ownerPrincipalId: principalId, sizeBytes: 1, contentType: null };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const path = `confirm-race/${attempt}.bin`;
      const outcome = await catalog.reserve(path, input);
      expect(outcome.kind).toBe('reserved');

      const [confirmed] = await Promise.all([
        catalog.confirm(outcome.row, { sizeBytes: 2, contentType: null }),
        catalog.remove(path),
      ]);

      expect(confirmed === null || confirmed.row.status === 'ready').toBe(true);
      const rows = await rowsFor(path);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('deleting');
      expect(await rowsAt(path)).toEqual([]);
    }
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] 10 concurrent renames onto one path: exactly one wins', async () => {
    const sources = Array.from({ length: 10 }, (_, index) => `rename-race/from-${index}.bin`);
    for (const path of sources) await catalog.putFile(putInput(path, 1));

    const settled = await Promise.allSettled(
      sources.map((path) =>
        catalog.renameFile(path, {
          path: 'rename-race/to.bin',
          kind: 'file',
          storageKey: 'rename-race/to.bin',
          sizeBytes: 1,
          contentType: null,
        }),
      ),
    );

    const won = settled.flatMap((result) =>
      result.status === 'fulfilled' && result.value !== null ? [result.value] : [],
    );
    expect(won).toHaveLength(1);
    const rows = await rowsAt('rename-race/to.bin');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(won[0]?.id);
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] a putFile racing a remove of one path leaves one row', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const path = `put-remove-race/${attempt}.bin`;
      await catalog.putFile(putInput(path, 1));

      await Promise.all([catalog.putFile(putInput(path, 2)), catalog.remove(path)]);

      // The remove moves the old row aside; a put that follows it adds a ready row at the path.
      const statuses = (await rowsFor(path)).map((row) => row.status).sort();
      expect([['deleting'], ['deleting', 'ready']]).toContainEqual(statuses);
      expect((await rowsAt(path)).length).toBeLessThanOrEqual(1);
    }
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] 20 rounds of 20 concurrent reserves of one path: exactly one wins per round', async () => {
    const input = { ownerPrincipalId: principalId, sizeBytes: 1, contentType: null };
    const path = 'round-race/a.bin';
    for (let round = 0; round < 20; round += 1) {
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () => catalog.reserve(path, input)),
      );
      const winners = outcomes.filter((outcome) => outcome.kind === 'reserved');
      expect(winners).toHaveLength(1);
      expect(new Set(outcomes.map((outcome) => outcome.row.id)).size).toBe(1);
      expect(await rowsAt(path)).toHaveLength(1);

      const winner = winners[0]?.row;
      if (winner === undefined) throw new Error('no reserve won');
      const ready = await catalog.confirm(winner, { sizeBytes: 1, contentType: null });
      expect(ready).toMatchObject({ row: { status: 'ready' } });
      const removed = await catalog.remove(path);
      expect(removed.map((row) => row.id)).toEqual([winner.id]);
      for (const row of removed) await catalog.forget(row);
      expect(await rowsAt(path)).toEqual([]);
    }
  });

  /**
   * Hold `lock` in a transaction on the test pool, start `write` on the race pool, and prove it waits
   * for the lock: still running after {@link BLOCKED_MS}, done once the lock is released.
   */
  async function expectWaitsFor(lock: SQL, write: () => Promise<unknown>): Promise<void> {
    let held = (): void => undefined;
    let release = (): void => undefined;
    const lockHeld = new Promise<void>((resolve) => (held = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = isolated.db.transaction(async (tx) => {
      await tx.execute(lock);
      held();
      await released;
    });
    await lockHeld;
    let done = false;
    const writing = write().finally(() => (done = true));
    try {
      await sleep(BLOCKED_MS);
      expect(done).toBe(false);
    } finally {
      release();
      await holder;
    }
    await writing;
    expect(done).toBe(true);
  }

  /** Hold `lock` and prove `write` finishes without waiting for it. */
  async function expectRunsBeside(lock: SQL, write: () => Promise<unknown>): Promise<void> {
    let held = (): void => undefined;
    let release = (): void => undefined;
    const lockHeld = new Promise<void>((resolve) => (held = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = isolated.db.transaction(async (tx) => {
      await tx.execute(lock);
      held();
      await released;
    });
    await lockHeld;
    try {
      const outcome = await Promise.race([
        write().then(() => 'done'),
        sleep(BLOCKED_MS * 10).then(() => 'blocked'),
      ]);
      expect(outcome).toBe('done');
    } finally {
      release();
      await holder;
    }
  }

  const pathLock = (path: string) =>
    sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}::text || ':' || ${path}, 0))`;

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] putFile and renameFile wait for the lock of the path they write', async () => {
    await expectWaitsFor(pathLock('lock-wait/a.bin'), () =>
      catalog.putFile(putInput('lock-wait/a.bin', 1)),
    );
    await catalog.putFile(putInput('lock-wait/from.bin', 1));
    await expectWaitsFor(pathLock('lock-wait/to.bin'), () =>
      catalog.renameFile('lock-wait/from.bin', {
        path: 'lock-wait/to.bin',
        kind: 'file',
        storageKey: 'lock-wait/to.bin',
        sizeBytes: 1,
        contentType: null,
      }),
    );
    expect(await rowsAt('lock-wait/to.bin')).toHaveLength(1);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a single-path writer waits for a prefix writer of its workspace', async () => {
    await expectWaitsFor(
      sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}::text, 0))`,
      () => catalog.putFile(putInput('workspace-wait/a.bin', 1)),
    );
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] 20 mixed renameFile and renameFilesByPrefix calls never deadlock', async () => {
    const indexes = Array.from({ length: 20 }, (_, index) => index);
    for (const index of indexes) {
      await catalog.putFile(putInput(`mix-a/d/f${index}.bin`, 1));
      await catalog.putFile(putInput(`mix-b/d/f${index}.bin`, 1));
    }

    const settled = await Promise.allSettled(
      indexes.map((index) => {
        const [from, to] = index % 4 < 2 ? ['mix-a', 'mix-b'] : ['mix-b', 'mix-a'];
        if (index % 2 === 0) return catalog.renameFilesByPrefix(`${from}/d`, `${to}/d${index}`);
        const target = `${to}/f${index}.bin`;
        return catalog.renameFile(`${from}/d/f${index}.bin`, {
          path: target,
          kind: 'file',
          storageKey: target,
          sizeBytes: 1,
          contentType: null,
        });
      }),
    );

    // A loser is fine, whether the clash check or the unique key caught it; a deadlock (40P01) or
    // any other failure is not.
    for (const result of settled) {
      if (result.status === 'fulfilled') continue;
      if (result.reason instanceof CatalogPathTakenError) continue;
      expect([...postgresViolations(result.reason)].map((violation) => violation.code)).toContain(
        '23505',
      );
    }
  });

  const replacing = (objectId = crypto.randomUUID()) => ({
    ownerPrincipalId: principalId,
    sizeBytes: 1,
    contentType: null,
    objectId,
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] concurrent replacements of one file leave one ready row and the rest deleting', async () => {
    const path = 'replace-race/a.bin';
    const first = await catalog.putFile(putInput(path, 1));

    const confirmed = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const reserved = await catalog.reserve(path, replacing());
        if (reserved.kind !== 'reserved') return null;
        return catalog.confirm(reserved.row, { sizeBytes: 2, contentType: null });
      }),
    );

    const swaps = confirmed.flatMap((outcome) => (outcome === null ? [] : [outcome]));
    expect(swaps.length).toBeGreaterThan(0);
    expect(swaps.every((swap) => swap.replaced !== undefined)).toBe(true);
    const rows = await rowsFor(path);
    expect(rows.filter((row) => row.status === 'ready')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'pending')).toEqual([]);
    expect(rows.filter((row) => row.status === 'deleting')).toHaveLength(swaps.length);
    expect(await rowsAt(path)).toHaveLength(1);
    expect(rows.map((row) => row.id)).toContain(first.id);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] 20 concurrent replacements of one ready file give one pending winner', async () => {
    const path = 'replace-reserve-race/a.bin';
    await catalog.putFile(putInput(path, 1));

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => catalog.reserve(path, replacing())),
    );

    expect(outcomes.filter((outcome) => outcome.kind === 'reserved')).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.row.id)).size).toBe(1);
    expect((await rowsFor(path)).map((row) => row.status).sort()).toEqual(['pending', 'ready']);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] reserve, confirm and forget wait for the lock of the path they write', async () => {
    const path = 'lock-proof/a.bin';
    await catalog.putFile(putInput(path, 1));
    await expectWaitsFor(pathLock(path), () => catalog.reserve(path, replacing()));
    const [pending] = (await rowsFor(path)).filter((row) => row.status === 'pending');
    if (pending === undefined) throw new Error('the reserve did not land');

    await expectWaitsFor(pathLock(path), () =>
      catalog.confirm(pending, { sizeBytes: 2, contentType: null }),
    );
    expect((await rowsFor(path)).filter((row) => row.status === 'deleting')).toHaveLength(1);

    const other = 'lock-proof/b.bin';
    await catalog.putFile(putInput(other, 1));
    const reserved = await catalog.reserve(other, replacing());
    await expectWaitsFor(pathLock(other), () => catalog.forget(reserved.row));
    expect((await rowsFor(other)).map((row) => row.status)).toEqual(['ready']);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a confirm racing a renameFile swaps the replacement in at the new path', async () => {
    const from = 'confirm-rename/a.bin';
    const to = 'confirm-rename/b.bin';
    const old = await catalog.putFile(putInput(from, 1));
    const reserved = await catalog.reserve(from, replacing());
    expect(reserved.kind).toBe('reserved');

    // The rename takes the lock of `from`, then waits on `to`, which the test holds. The confirm
    // reads the row (still standing for `from`) and waits on `from`. Releasing `to` lets the
    // rename move the file and its pending replacement before the confirm takes the path lock.
    let held = (): void => undefined;
    let release = (): void => undefined;
    const lockHeld = new Promise<void>((resolve) => (held = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = isolated.db.transaction(async (tx) => {
      await tx.execute(pathLock(to));
      held();
      await released;
    });
    await lockHeld;
    let confirming: Promise<unknown> = Promise.resolve();
    try {
      const renaming = catalog.renameFile(from, {
        path: to,
        kind: 'file',
        storageKey: to,
        sizeBytes: 1,
        contentType: null,
      });
      await sleep(BLOCKED_MS);
      let done = false;
      confirming = catalog
        .confirm(reserved.row, { sizeBytes: 2, contentType: null })
        .finally(() => (done = true));
      await sleep(BLOCKED_MS);
      expect(done).toBe(false);
      release();
      await holder;
      await expect(renaming).resolves.toMatchObject({ id: old.id, path: to });
      await expect(confirming).resolves.toMatchObject({
        row: { id: reserved.row.id, path: to, status: 'ready' },
        replaced: { id: old.id, status: 'deleting', targetPath: to },
      });
    } finally {
      release();
      await holder;
      await confirming.catch(() => undefined);
    }
    expect(await rowsFor(from)).toEqual([]);
    const at = await rowsFor(to);
    expect(at.map((row) => [row.id, row.status]).sort()).toEqual(
      [
        [old.id, 'deleting'],
        [reserved.row.id, 'ready'],
      ].sort(),
    );
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] removing one file waits for its path lock but runs beside other single-path writers', async () => {
    const path = 'lock-proof/remove.bin';
    await catalog.putFile(putInput(path, 1));
    await expectWaitsFor(pathLock(path), () => catalog.remove(path));
    expect((await rowsFor(path)).map((row) => row.status)).toEqual(['deleting']);

    // A shared workspace lock is what every single-path writer holds, so a one-file remove takes
    // it too and does not wait; only a prefix writer would.
    const other = 'lock-proof/remove-beside.bin';
    await catalog.putFile(putInput(other, 1));
    const shared = sql`select pg_advisory_xact_lock_shared(hashtextextended(${workspaceId}::text, 0))`;
    await expectRunsBeside(shared, () => catalog.remove(other));
    expect((await rowsFor(other)).map((row) => row.status)).toEqual(['deleting']);
  });

  // @story US-STO-04
  it('[US-STO-04][contract][sdk] removing a folder waits for a single-path writer of its workspace', async () => {
    await catalog.putFile(putInput('lock-proof/dir/a.bin', 1));
    const shared = sql`select pg_advisory_xact_lock_shared(hashtextextended(${workspaceId}::text, 0))`;
    await expectWaitsFor(shared, () => catalog.remove('lock-proof/dir'));
    expect((await rowsFor('lock-proof/dir/a.bin')).map((row) => row.status)).toEqual(['deleting']);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] 10 concurrent createSkill calls for one name give one row and 9 nulls', async () => {
    const input = {
      name: 'create-race',
      skillMd: '# race',
      enabled: true,
      ownerPrincipalId: principalId,
    };
    const outcomes = await Promise.all(
      Array.from({ length: RACE_CONNECTIONS }, () => catalog.createSkill(input)),
    );

    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
    expect(
      (await catalog.listSkills()).filter((skill) => skill.name === 'create-race'),
    ).toHaveLength(1);
  });
});
