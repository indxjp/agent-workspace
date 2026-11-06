/**
 * Helpers for the microsecond-precision `created_at` cases against a real PostgreSQL (issue #135,
 * round 3 finding 5 and round 4 findings 2 and 4).
 */
import { expect } from 'vitest';

import type { ListRunsInput } from './store';
import type { RunDatabase } from './store.postgres.test-support';
import { listOverHttp } from './store.test-support';

/** Set each run's `created_at` to `<prefix>.<micro>Z`, at the precision the column holds. */
export async function setMicrosecondInstants(
  database: RunDatabase,
  prefix: string,
  at: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [micro, runId] of Object.entries(at)) {
    await database.db.execute(
      `update runs set created_at = '${prefix}.${micro}Z' where id = '${runId}'`,
    );
  }
}

type RunFilter = NonNullable<ListRunsInput['filter']>;

const MICROS = ['122999', '123000', '123999', '124000'] as const;
type Micro = (typeof MICROS)[number];

/**
 * Four runs at `.122999`, `.123000`, `.123999` and `.124000` around a bound of `.123Z`, listed
 * through the repository directly and then through `GET /api/runs`.
 */
export async function checkRangeAroundOwnRenderedBound(database: RunDatabase): Promise<void> {
  const { workspaceId, userId, sessionId } = await database.seedWorkspace();
  const store = database.makeStore();
  const listRuns = store.listRuns.bind(store);
  const model = crypto.randomUUID();
  const at: Record<Micro, string> = {
    '122999': crypto.randomUUID(),
    '123000': crypto.randomUUID(),
    '123999': crypto.randomUUID(),
    '124000': crypto.randomUUID(),
  };
  await database.db
    .insert(database.core.runs)
    .values(MICROS.map((micro) => ({ id: at[micro], workspaceId, sessionId, model })));
  await setMicrosecondInstants(database, '2026-03-01T12:00:00', at);
  const [record] = (await listRuns(workspaceId, { limit: 1, filter: { model } })).items;
  if (record === undefined) throw new Error('the runs were not listed');
  expect(record.id).toBe(at['124000']);
  const [inLastMicros] = (
    await listRuns(workspaceId, {
      limit: 1,
      filter: { model, createdTo: new Date(record.createdAt.getTime() - 1) },
    })
  ).items;
  if (inLastMicros === undefined) throw new Error('the .123999 run was not listed');
  expect(inLastMicros.id).toBe(at['123999']);
  const rendered = inLastMicros.createdAt.toISOString();
  expect(rendered).toBe('2026-03-01T12:00:00.123Z');

  const bound = new Date(rendered);
  const before = new Date(bound.getTime() - 1);
  const after = new Date(bound.getTime() + 1);
  const idsWith = async (filter: RunFilter): Promise<string[]> =>
    (await listRuns(workspaceId, { limit: 10, filter: { model, ...filter } })).items
      .map((run) => run.id)
      .sort();
  const sortedIds = (...keys: readonly Micro[]): string[] => keys.map((key) => at[key]).sort();
  expect(await idsWith({ createdTo: bound })).toEqual(sortedIds('122999', '123000', '123999'));
  expect(await idsWith({ createdFrom: bound })).toEqual(sortedIds('123000', '123999', '124000'));
  expect(await idsWith({ createdFrom: bound, createdTo: bound })).toEqual(
    sortedIds('123000', '123999'),
  );
  expect(await idsWith({ createdTo: before })).toEqual(sortedIds('122999'));
  expect(await idsWith({ createdFrom: after })).toEqual(sortedIds('124000'));

  await database.asOwnerOf(workspaceId, userId, store, async () => {
    const inside = await listOverHttp(`model=${model}&from=${rendered}&to=${rendered}`);
    expect([...inside.ids].sort()).toEqual(sortedIds('123000', '123999'));
    const upTo = await listOverHttp(`model=${model}&to=${rendered}`);
    expect(upTo.ids).not.toContain(at['124000']);
    expect([...upTo.ids].sort()).toEqual(sortedIds('122999', '123000', '123999'));
    const outside = await listOverHttp(`model=${model}&to=${before.toISOString()}`);
    expect(outside.ids).toEqual([at['122999']]);
  });
}
