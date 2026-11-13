import { expect, it } from 'vitest';

import { storageObjectName } from '@agent-workspace/core/storage';

import type { CleanupFixture } from './cleanup.fixture.test-support';
import { createCleanupHarness } from './cleanup.harness.test-support';
const PREFIX = 'files/workspaces';

export function registerCleanupReferencesTests(setup: () => Promise<CleanupFixture>) {
  const harness = () => createCleanupHarness(setup);
  // @story US-STO-14
  it('[US-STO-14][unit][sdk] cleanup finds an orphan and removes it only in delete mode', async () => {
    const h = await harness();
    const ws = await h.known();
    const kept = crypto.randomUUID();
    const orphan = crypto.randomUUID();
    await h.readyRow(ws, 'new.txt', { objectId: kept });
    await h.newObject(ws.id, kept);
    await h.newObject(ws.id, orphan);

    await expect(h.run('report')).resolves.toMatchObject({
      scanned: 2,
      orphans: 1,
      deleted: 0,
    });
    await expect(h.objects.head(h.newName(ws.id, orphan))).resolves.not.toBeNull();

    await expect(h.run('delete')).resolves.toMatchObject({ orphans: 1, deleted: 1 });
    await expect(h.objects.head(h.newName(ws.id, orphan))).resolves.toBeNull();
    await expect(h.objects.head(h.newName(ws.id, kept))).resolves.not.toBeNull();
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] an object of the old per-area layout is neither scanned nor deleted', async () => {
    const h = await harness();
    const ws = await h.known();
    const old = `${PREFIX}/${ws.id}/unadopted.txt`;
    await h.objects.write(old, new Uint8Array(7), { contentType: null });

    for (const mode of ['report', 'delete'] as const) {
      await expect(h.run(mode)).resolves.toMatchObject({ scanned: 0, orphans: 0, deleted: 0 });
    }
    await expect(h.objects.head(old)).resolves.not.toBeNull();
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] an object a deleting, side-path or pending row points at is never an orphan', async () => {
    const h = await harness();
    const ws = await h.known();
    const catalog = await h.fixture.catalog(ws.id);
    const goneId = crypto.randomUUID();
    const keptId = crypto.randomUUID();
    const replacement = crypto.randomUUID();
    const pendingId = crypto.randomUUID();
    // a removed file whose row still waits for its delete
    await h.readyRow(ws, 'gone.txt', { sizeBytes: 7, objectId: goneId });
    await h.newObject(ws.id, goneId);
    await catalog.remove('gone.txt');
    // a replacement waiting at a side path
    await h.readyRow(ws, 'kept.txt', { sizeBytes: 7, objectId: keptId });
    await h.newObject(ws.id, keptId);
    await h.reserveRow(ws, 'kept.txt', { objectId: replacement });
    await h.newObject(ws.id, replacement);
    // an upload still waiting for its completion
    await h.reserveRow(ws, 'later.txt', { objectId: pendingId });
    await h.newObject(ws.id, pendingId);

    await expect(h.run('report')).resolves.toMatchObject({ scanned: 4, orphans: 0 });
  });

  // @story US-STO-09
  it('[US-STO-09][contract][run] a session-state object with a row is never an orphan', async () => {
    const h = await harness();
    const ws = await h.known();
    const ready = crypto.randomUUID();
    const deleting = crypto.randomUUID();
    const pending = crypto.randomUUID();
    const orphan = crypto.randomUUID();
    const stateObject = (objectId: string) =>
      h.objects.write(storageObjectName(ws.id, 'session-state', objectId), new Uint8Array(7), {
        contentType: null,
      });
    for (const [objectId, status] of [
      [ready, 'ready'],
      [deleting, 'deleting'],
      [pending, 'pending'],
    ] as const) {
      await stateObject(objectId);
      await h.fixture.stateBlob(ws.id, objectId, status);
    }
    await stateObject(orphan);

    await expect(h.run('report')).resolves.toMatchObject({
      scanned: 4,
      orphans: 1,
      deleted: 0,
      deletingFinished: 1,
      stalePendingDeleted: 1,
    });
    const name = (objectId: string) => storageObjectName(ws.id, 'session-state', objectId);
    await expect(h.objects.head(name(deleting))).resolves.not.toBeNull();
    await expect(h.objects.head(name(pending))).resolves.not.toBeNull();

    // A deleting row and an abandoned reservation are finished first: object, then row. Only
    // then is anything an orphan, and a row in any status keeps its object until it is gone.
    await expect(h.run('delete')).resolves.toMatchObject({
      orphans: 1,
      deleted: 1,
      deletingFinished: 1,
      stalePendingDeleted: 1,
    });
    await expect(h.objects.head(name(orphan))).resolves.toBeNull();
    await expect(h.objects.head(name(ready))).resolves.not.toBeNull();
    await expect(h.objects.head(name(deleting))).resolves.toBeNull();
    await expect(h.objects.head(name(pending))).resolves.toBeNull();
    const rows = await h.fixture.sessionState(ws.id);
    await expect(rows.unsettledBlobs(new Date(Date.now() + 60_000))).resolves.toEqual([]);
    await expect(rows.referencedObjectIds([ready, deleting, pending])).resolves.toEqual([ready]);
  });

  // @story US-STO-09
  it('[US-STO-09][contract][run] a session-state reservation younger than the minimum age is left alone', async () => {
    const h = await harness();
    const ws = await h.known();
    const young = crypto.randomUUID();
    await h.objects.write(storageObjectName(ws.id, 'session-state', young), new Uint8Array(7), {
      contentType: null,
    });
    await h.fixture.stateBlob(ws.id, young, 'pending');

    await expect(h.run('delete', { now: () => new Date() })).resolves.toMatchObject({
      stalePendingDeleted: 0,
      deleted: 0,
    });
    const rows = await h.fixture.sessionState(ws.id);
    await expect(rows.referencedObjectIds([young])).resolves.toEqual([young]);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a skills object with a row is not an orphan', async () => {
    const h = await harness();
    const ws = await h.known();
    const kept = crypto.randomUUID();
    const orphan = crypto.randomUUID();
    const skillObject = (objectId: string) =>
      h.objects.write(storageObjectName(ws.id, 'skills', objectId), new Uint8Array(7), {
        contentType: null,
      });
    await skillObject(kept);
    await skillObject(orphan);
    await h.readyRow(ws, '.skills/demo/SKILL.md', {
      sizeBytes: 7,
      objectId: kept,
      area: 'skills',
    });
    await expect(h.run('report')).resolves.toMatchObject({ scanned: 2, orphans: 1, deleted: 0 });
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] objects younger than the minimum age are skipped and counted in both modes', async () => {
    const h = await harness();
    const ws = await h.known();
    const id = crypto.randomUUID();
    await h.newObject(ws.id, id);
    const options = { now: () => new Date() };

    for (const mode of ['report', 'delete'] as const) {
      await expect(h.run(mode, options)).resolves.toMatchObject({
        scanned: 1,
        skippedYoung: 1,
        orphans: 0,
        deleted: 0,
      });
    }
    await expect(h.objects.head(h.newName(ws.id, id))).resolves.not.toBeNull();
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] cleanup pages through the listing and counts every object once', async () => {
    const h = await harness();
    const first = await h.known();
    const second = await h.known();
    const kept = crypto.randomUUID();
    await h.readyRow(first, 'kept.txt', { objectId: kept });
    await h.newObject(first.id, kept);
    await h.newObject(first.id, crypto.randomUUID());
    await h.newObject(second.id, crypto.randomUUID());

    await expect(h.run('delete', { pageSize: 1 })).resolves.toMatchObject({
      scanned: 3,
      orphans: 2,
      deleted: 2,
    });
    await expect(h.objects.head(h.newName(first.id, kept))).resolves.not.toBeNull();
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] cleanup reads past the first page at the default page size', async () => {
    const h = await harness();
    const ws = await h.known();
    for (let n = 0; n <= 1000; n += 1) await h.newObject(ws.id, crypto.randomUUID());

    await expect(h.run('delete')).resolves.toMatchObject({
      scanned: 1001,
      orphans: 1001,
      deleted: 1001,
    });
    expect((await h.objects.listPage('', { recursive: true })).entries).toEqual([]);
  });
}
