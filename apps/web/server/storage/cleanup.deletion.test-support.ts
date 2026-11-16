import { expect, it } from 'vitest';

import { type ObjectStore } from '@agent-workspace/core/storage';

import type { CleanupFixture } from './cleanup.fixture.test-support';
import { createCleanupHarness } from './cleanup.harness.test-support';

export function registerCleanupDeletionTests(setup: () => Promise<CleanupFixture>) {
  const harness = () => createCleanupHarness(setup);
  // @story US-STO-04
  it('[US-STO-04][unit][sdk] cleanup finishes an interrupted delete: the object, then the row', async () => {
    const h = await harness();
    const ws = await h.known();
    const catalog = await h.fixture.catalog(ws.id);
    const objectId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    await h.readyRow(ws, 'new.txt', { objectId });
    await h.newObject(ws.id, objectId);
    await h.readyRow(ws, 'other.txt', { objectId: otherId });
    await h.newObject(ws.id, otherId);
    await catalog.remove('new.txt');
    await catalog.remove('other.txt');

    await expect(h.run('report')).resolves.toMatchObject({ deletingFinished: 2 });
    await expect(catalog.deleting()).resolves.toHaveLength(2);

    await expect(h.run('delete')).resolves.toMatchObject({ deletingFinished: 2, orphans: 0 });
    await expect(catalog.deleting()).resolves.toEqual([]);
    await expect(h.objects.head(h.newName(ws.id, objectId))).resolves.toBeNull();
    await expect(h.objects.head(h.newName(ws.id, otherId))).resolves.toBeNull();
  });

  // @story US-STO-04
  it('[US-STO-04][unit][sdk] a delete that fails keeps the deleting row for the next pass', async () => {
    const h = await harness();
    const ws = await h.known();
    const catalog = await h.fixture.catalog(ws.id);
    const objectId = crypto.randomUUID();
    await h.readyRow(ws, 'old.txt', { sizeBytes: 7, objectId });
    await h.newObject(ws.id, objectId);
    await catalog.remove('old.txt');
    const failing: ObjectStore = {
      ...h.objects,
      delete: () => Promise.reject(new Error('the store is down')),
    };

    await expect(h.run('delete', { objects: failing })).resolves.toMatchObject({
      deletingFinished: 0,
    });
    await expect(catalog.deleting()).resolves.toHaveLength(1);
    await expect(h.run('delete')).resolves.toMatchObject({ deletingFinished: 1 });
    await expect(catalog.deleting()).resolves.toEqual([]);
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] a report pass writes nothing: every write method of the stores and the catalog throws', async () => {
    const h = await harness();
    const ws = await h.known();
    const catalog = await h.fixture.catalog(ws.id);
    const orphan = crypto.randomUUID();
    const stale = crypto.randomUUID();
    const gone = crypto.randomUUID();
    await h.newObject(ws.id, orphan);
    await h.reserveRow(ws, 'stale.bin', { sizeBytes: 5, objectId: stale });
    await h.newObject(ws.id, stale, 5);
    await h.readyRow(ws, 'gone.bin', { objectId: gone });
    await h.newObject(ws.id, gone);
    await catalog.remove('gone.bin');
    const reads = new Set(['listPage', 'head', 'deleting', 'stalePending', 'referencing']);
    const readOnly = <T extends object>(target: T): T =>
      new Proxy(target, {
        get: (inner, property) =>
          typeof property !== 'string' || property === 'then' || reads.has(property)
            ? Reflect.get(inner, property)
            : () => {
                throw new Error(`report mode called ${property}`);
              },
      });

    const report = await h.run('report', {
      objects: readOnly(h.objects),
      catalogs: async (id) => readOnly(await h.fixture.catalog(id)),
    });

    expect(report).toMatchObject({
      orphans: 1,
      stalePendingReady: 1,
      deletingFinished: 1,
      deleted: 0,
    });
    expect(h.lines.filter((line) => line.message.includes('failed'))).toEqual([]);
    expect(h.lines.find((line) => line.message === 'storage cleanup')?.fields).toMatchObject({
      mode: 'report',
      orphans: 1,
    });
    await expect(catalog.deleting()).resolves.toHaveLength(1);
    await expect(h.objects.head(h.newName(ws.id, orphan))).resolves.not.toBeNull();
  });
}
