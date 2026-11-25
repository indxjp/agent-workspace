import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { holdTransactionLock, lockWaiters } from './catalog-locks.test-support.js';
import { CatalogPathTakenError } from './resource-catalogs.js';
import {
  closeRaceHarness,
  createRaceHarness,
  pathLock,
  RACE_CONNECTIONS,
  RACE_SETUP_TIMEOUT_MS,
  reserveInput,
  rowsAt,
  rowsFor,
  seedFile,
  type RaceHarness,
} from './resource-catalogs.races.test-support.js';
import { postgresViolations } from './violations.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

const CONCURRENT_RESERVES = 20;

async function reserveConcurrently(h: RaceHarness, path: string, count: number) {
  return Promise.all(Array.from({ length: count }, () => h.catalog.reserve(path, reserveInput(h))));
}

async function expectOneReserveWins(h: RaceHarness) {
  const outcomes = await reserveConcurrently(h, 'reserve-race/a.bin', CONCURRENT_RESERVES);

  const winners = outcomes.filter((outcome) => outcome.kind === 'reserved');
  expect(winners).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.kind === 'taken')).toHaveLength(19);
  const winnerId = winners[0]?.row.id;
  expect(new Set(outcomes.map((outcome) => outcome.row.id))).toEqual(new Set([winnerId]));

  const rows = await rowsAt(h, 'reserve-race/a.bin');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: winnerId, status: 'pending' });
  expect(await rowsAt(h, 'reserve-race')).toHaveLength(1);
}

async function expectSkillRevisionsNumbered(h: RaceHarness) {
  const { catalog } = h;
  await catalog.putSkill({
    name: 'raced',
    skillMd: '# raced',
    enabled: true,
    ownerPrincipalId: h.principalId,
    createdBy: h.userId,
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
  expect(published.map((revision) => revision?.number).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
    expected,
  );
  const listed = await catalog.listSkillRevisions('raced');
  expect(listed.map((revision) => revision.number).sort((a, b) => a - b)).toEqual(expected);
}

/** Queue a confirm and a remove behind one held path lock, in the order `first` names. */
async function queueConfirmAndRemove(
  h: RaceHarness,
  path: string,
  row: Parameters<RaceHarness['catalog']['confirm']>[0],
  first: 'confirm' | 'remove',
) {
  const { catalog, isolated } = h;
  const release = await holdTransactionLock(isolated.db, pathLock(h, path));
  const confirm = () => catalog.confirm(row, { sizeBytes: 2, contentType: null });
  const remove = () => catalog.remove(path);
  let confirming: ReturnType<typeof confirm>;
  let removing: ReturnType<typeof remove>;
  try {
    if (first === 'confirm') {
      confirming = confirm();
      await lockWaiters(isolated.db, { count: 1, settled: confirming });
      removing = remove();
    } else {
      removing = remove();
      await lockWaiters(isolated.db, { count: 1, settled: removing });
      confirming = confirm();
    }
    await lockWaiters(isolated.db, { count: 2, settled: Promise.race([confirming, removing]) });
  } finally {
    await release();
  }
  return Promise.all([confirming, removing]);
}

async function expectConfirmRemoveHasOneWinner(h: RaceHarness) {
  for (const first of ['confirm', 'remove'] as const) {
    const path = `confirm-race/${first}-first.bin`;
    const outcome = await h.catalog.reserve(path, reserveInput(h));
    expect(outcome.kind).toBe('reserved');

    // Both writers queue behind the held path lock in a known order, then run one after the other.
    const [confirmed, removed] = await queueConfirmAndRemove(h, path, outcome.row, first);

    if (first === 'confirm') {
      expect(confirmed?.row).toMatchObject({ id: outcome.row.id, status: 'ready' });
    } else {
      expect(confirmed).toBeNull();
    }
    expect(removed.map((row) => row.id)).toEqual([outcome.row.id]);
    const rows = await rowsFor(h, path);
    expect(rows.map((row) => [row.id, row.status])).toEqual([[outcome.row.id, 'deleting']]);
    expect(await rowsAt(h, path)).toEqual([]);
  }
}

async function expectOneRenameWins(h: RaceHarness) {
  const sources = Array.from({ length: 10 }, (_, index) => `rename-race/from-${index}.bin`);
  const seeded = new Map<string, string>();
  for (const path of sources) {
    seeded.set(path, (await seedFile(h, path)).id);
  }

  const settled = await Promise.allSettled(
    sources.map((path) => h.catalog.rename(path, 'rename-race/to.bin')),
  );

  const won = sources.filter((_, index) => {
    const result = settled[index];
    return result?.status === 'fulfilled' && result.value.rows === 1;
  });
  expect(won).toHaveLength(1);
  const rows = await rowsAt(h, 'rename-race/to.bin');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(seeded.get(won[0] ?? ''));
}

async function expectOneWinnerPerReserveRound(h: RaceHarness) {
  const { catalog } = h;
  const path = 'round-race/a.bin';
  for (let round = 0; round < 20; round += 1) {
    const outcomes = await reserveConcurrently(h, path, CONCURRENT_RESERVES);
    const winners = outcomes.filter((outcome) => outcome.kind === 'reserved');
    expect(winners).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.row.id)).size).toBe(1);
    expect(await rowsAt(h, path)).toHaveLength(1);

    const winner = winners[0]?.row;
    if (winner === undefined) throw new Error('no reserve won');
    const ready = await catalog.confirm(winner, { sizeBytes: 1, contentType: null });
    expect(ready).toMatchObject({ row: { status: 'ready' } });
    const removed = await catalog.remove(path);
    expect(removed.map((row) => row.id)).toEqual([winner.id]);
    for (const row of removed) await catalog.forget(row);
    expect(await rowsAt(h, path)).toEqual([]);
  }
}

async function expectMixedRenamesNeverDeadlock(h: RaceHarness) {
  const indexes = Array.from({ length: 20 }, (_, index) => index);
  for (const index of indexes) {
    await seedFile(h, `mix-a/d/f${index}.bin`);
    await seedFile(h, `mix-b/d/f${index}.bin`);
  }

  const settled = await Promise.allSettled(
    indexes.map((index) => {
      const [from, to] = index % 4 < 2 ? ['mix-a', 'mix-b'] : ['mix-b', 'mix-a'];
      if (index % 2 === 0) return h.catalog.rename(`${from}/d`, `${to}/d${index}`);
      const target = `${to}/f${index}.bin`;
      return h.catalog.rename(`${from}/d/f${index}.bin`, target);
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
}

async function expectReplacementsLeaveOneReadyRow(h: RaceHarness) {
  const path = 'replace-race/a.bin';
  const first = await seedFile(h, path);

  const confirmed = await Promise.all(
    Array.from({ length: 10 }, async () => {
      const reserved = await h.catalog.reserve(path, reserveInput(h));
      if (reserved.kind !== 'reserved') return null;
      return h.catalog.confirm(reserved.row, { sizeBytes: 2, contentType: null });
    }),
  );

  const swaps = confirmed.flatMap((outcome) => (outcome === null ? [] : [outcome]));
  expect(swaps.length).toBeGreaterThan(0);
  expect(swaps.every((swap) => swap.replaced !== undefined)).toBe(true);
  const rows = await rowsFor(h, path);
  expect(rows.filter((row) => row.status === 'ready')).toHaveLength(1);
  expect(rows.filter((row) => row.status === 'pending')).toEqual([]);
  expect(rows.filter((row) => row.status === 'deleting')).toHaveLength(swaps.length);
  expect(await rowsAt(h, path)).toHaveLength(1);
  expect(rows.map((row) => row.id)).toContain(first.id);
}

async function expectConcurrentReplacementsGiveOnePendingWinner(h: RaceHarness) {
  const path = 'replace-reserve-race/a.bin';
  await seedFile(h, path);

  const outcomes = await reserveConcurrently(h, path, CONCURRENT_RESERVES);

  expect(outcomes.filter((outcome) => outcome.kind === 'reserved')).toHaveLength(1);
  expect(new Set(outcomes.map((outcome) => outcome.row.id)).size).toBe(1);
  expect((await rowsFor(h, path)).map((row) => row.status).sort()).toEqual(['pending', 'ready']);
}

async function expectConcurrentCreateSkillGivesOneRow(h: RaceHarness) {
  const input = {
    name: 'create-race',
    skillMd: '# race',
    enabled: true,
    ownerPrincipalId: h.principalId,
  };
  const outcomes = await Promise.all(
    Array.from({ length: RACE_CONNECTIONS }, () => h.catalog.createSkill(input)),
  );

  expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
  expect(
    (await h.catalog.listSkills()).filter((skill) => skill.name === 'create-race'),
  ).toHaveLength(1);
}

// The storage design, §07: what memory cannot prove is one winner per path when many requests
// arrive at once, so these cases run on PostgreSQL only.
describe.skipIf(!hasDatabase)('the PostgreSQL catalog under concurrent requests', () => {
  let h: RaceHarness;

  beforeAll(async () => {
    h = await createRaceHarness('aw_resource_catalog_races');
  }, RACE_SETUP_TIMEOUT_MS);

  afterAll(async () => closeRaceHarness(h));

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] 20 concurrent reserves of one path give one winner and 19 taken', async () => {
    await expectOneReserveWins(h);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] 10 concurrent publishes of one skill are numbered 1 to 10', async () => {
    await expectSkillRevisionsNumbered(h);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a confirm racing a remove has one winner, whichever reaches the path lock first', async () => {
    await expectConfirmRemoveHasOneWinner(h);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] 10 concurrent renames onto one path: exactly one wins', async () => {
    await expectOneRenameWins(h);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] 20 rounds of 20 concurrent reserves of one path: exactly one wins per round', async () => {
    await expectOneWinnerPerReserveRound(h);
    // About 500 PostgreSQL transactions (20 rounds of 20 reserves, each round confirmed, removed
    // and forgotten): half a second idle, but CI runners share one host and its PostgreSQL.
  }, 60_000);

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] 20 mixed file and folder renames never deadlock', async () => {
    await expectMixedRenamesNeverDeadlock(h);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] concurrent replacements of one file leave one ready row and the rest deleting', async () => {
    await expectReplacementsLeaveOneReadyRow(h);
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] 20 concurrent replacements of one ready file give one pending winner', async () => {
    await expectConcurrentReplacementsGiveOnePendingWinner(h);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] 10 concurrent createSkill calls for one name give one row and 9 nulls', async () => {
    await expectConcurrentCreateSkillGivesOneRow(h);
  });
});
