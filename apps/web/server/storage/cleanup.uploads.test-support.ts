import { createHash } from 'node:crypto';

import { expect, it } from 'vitest';

import { storageObjectName, type ObjectStore } from '@agent-workspace/core/storage';

import { CLEANUP_MIN_AGE_MS } from './cleanup';

import type { CleanupFixture } from './cleanup.fixture.test-support';
import { createCleanupHarness } from './cleanup.harness.test-support';
/** The objects store, running `during` once when the pass checks the object `name`. */
const onHead = (store: ObjectStore, name: string, during: () => Promise<unknown>) => {
  let ran = false;
  return new Proxy(store, {
    get: (inner, property) =>
      property === 'head'
        ? async (key: string) => {
            if (key === name && !ran) {
              ran = true;
              await during();
            }
            return inner.head(key);
          }
        : (Reflect.get(inner, property) as unknown),
  });
};

export function registerCleanupUploadsTests(setup: () => Promise<CleanupFixture>) {
  const harness = () => createCleanupHarness(setup);
  // @story US-STO-02
  it('[US-STO-02][unit][sdk] a stale upload in the new naming with its declared size becomes ready', async () => {
    const h = await harness();
    const ws = await h.known();
    const catalog = await h.fixture.catalog(ws.id);
    const objectId = crypto.randomUUID();
    await h.reserveRow(ws, 'up.bin', { sizeBytes: 5, objectId });
    await h.newObject(ws.id, objectId, 5);

    await expect(h.run('delete')).resolves.toMatchObject({ stalePendingReady: 1, orphans: 0 });
    const ready = await catalog.get('up.bin');
    expect(ready).toMatchObject({ status: 'ready', sizeBytes: 5 });
    // Published on a copy, as `completeUpload` does; the uploaded object is gone.
    expect(ready?.objectId).not.toBe(objectId);
    await expect(h.objects.head(h.newName(ws.id, ready?.objectId ?? ''))).resolves.not.toBeNull();
    await expect(h.objects.head(h.newName(ws.id, objectId))).resolves.toBeNull();
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] a stale upload confirmed by cleanup records the SHA-256 of its bytes', async () => {
    const h = await harness();
    const ws = await h.known();
    const catalog = await h.fixture.catalog(ws.id);
    const objectId = crypto.randomUUID();
    const bytes = new TextEncoder().encode('five!');
    await h.reserveRow(ws, 'sum.bin', { sizeBytes: bytes.length, objectId });
    await h.objects.write(h.newName(ws.id, objectId), bytes, { contentType: null });

    await expect(h.run('delete')).resolves.toMatchObject({ stalePendingReady: 1 });
    await expect(catalog.get('sum.bin')).resolves.toMatchObject({
      status: 'ready',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  // @story US-STO-04
  it('[US-STO-04][unit][sdk] a row reserved 2 h ago and re-minted 1 min ago is not stale', async () => {
    const h = await harness();
    const ws = await h.known();
    const catalog = await h.fixture.catalog(ws.id);
    const objectId = crypto.randomUUID();
    const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
    await h.reserveRow(ws, 'mint.bin', { sizeBytes: 5, objectId, uploadMode: 'signed' });
    await h.newObject(ws.id, objectId, 5);
    await pause();
    const cut = new Date();
    await pause();
    // The same owner asks for the link again: the reservation is as young as the new link.
    await expect(
      catalog.reserve('mint.bin', {
        ownerPrincipalId: ws.principalId,
        sizeBytes: 5,
        contentType: 'text/plain',
        objectId,
        uploadMode: 'signed',
      }),
    ).resolves.toMatchObject({ kind: 'taken' });

    // The pass sees `cut` as its cut-off: the first reservation is older, the re-mint younger.
    const now = () => new Date(cut.getTime() + CLEANUP_MIN_AGE_MS);
    await expect(h.run('delete', { now })).resolves.toMatchObject({
      stalePendingReady: 0,
      stalePendingDeleted: 0,
    });
    await expect(catalog.pending('mint.bin')).resolves.not.toBeNull();
    await expect(h.objects.head(h.newName(ws.id, objectId))).resolves.not.toBeNull();
  });

  // @story US-STO-04
  it('[US-STO-04][unit][sdk] a stale cleanup snapshot cannot delete an upload that was confirmed during its object check', async () => {
    const h = await harness();
    const ws = await h.known();
    const catalog = await h.fixture.catalog(ws.id);
    const objectId = crypto.randomUUID();
    // A relay save wrote its bytes and has not confirmed them yet: its row still declares 0.
    const row = await h.reserveRow(ws, 'late.bin', { objectId, uploadMode: 'relay' });
    await h.newObject(ws.id, objectId, 4);
    const confirmLate = () => catalog.confirm(row, { sizeBytes: 4, contentType: 'text/plain' });

    await h.run('delete', {
      objects: onHead(h.objects, h.newName(ws.id, objectId), confirmLate),
    });

    await expect(catalog.get('late.bin')).resolves.toMatchObject({ id: row.id, objectId });
    await expect(h.objects.head(h.newName(ws.id, objectId))).resolves.not.toBeNull();
    await expect(catalog.deleting()).resolves.toEqual([]);
  });

  // @story US-STO-04
  it('[US-STO-04][unit][sdk] a stale cleanup snapshot cannot delete an upload that was refreshed during its object check', async () => {
    const h = await harness();
    const ws = await h.known();
    const catalog = await h.fixture.catalog(ws.id);
    const objectId = crypto.randomUUID();
    // The first PUT stopped short; the owner mints the link again while the pass looks at it.
    const row = await h.reserveRow(ws, 'again.bin', {
      sizeBytes: 5,
      objectId,
      uploadMode: 'signed',
    });
    await h.newObject(ws.id, objectId, 4);
    const remint = () =>
      catalog.reserve('again.bin', {
        ownerPrincipalId: ws.principalId,
        sizeBytes: 5,
        contentType: 'text/plain',
        objectId,
        uploadMode: 'signed',
      });

    await h.run('delete', { objects: onHead(h.objects, h.newName(ws.id, objectId), remint) });

    await expect(catalog.pending('again.bin')).resolves.toMatchObject({ id: row.id });
    await expect(h.objects.head(h.newName(ws.id, objectId))).resolves.not.toBeNull();
    await expect(catalog.deleting()).resolves.toEqual([]);
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] a stale signed upload that declared 0 bytes becomes ready', async () => {
    const h = await harness();
    const ws = await h.known();
    const catalog = await h.fixture.catalog(ws.id);
    const objectId = crypto.randomUUID();
    await h.reserveRow(ws, 'empty.bin', { sizeBytes: 0, objectId });
    await h.newObject(ws.id, objectId, 0);

    await expect(h.run('delete')).resolves.toMatchObject({ stalePendingReady: 1, orphans: 0 });
    await expect(catalog.get('empty.bin')).resolves.toMatchObject({
      status: 'ready',
      sizeBytes: 0,
    });
  });

  // @story US-STO-07
  it('[US-STO-07][unit][run] a stale staging row is deleted, never confirmed', async () => {
    const h = await harness();
    const ws = await h.known();
    const catalog = await h.fixture.catalog(ws.id);
    const objectId = crypto.randomUUID();
    const path = `.staging-${objectId}`;
    const name = storageObjectName(ws.id, 'staging', objectId);
    // The object is exactly as long as the row declares, which confirms any other pending row.
    await h.reserveRow(ws, path, { sizeBytes: 5, objectId, area: 'staging' });
    await h.objects.write(name, new Uint8Array(5), { contentType: null });

    await expect(h.run('report')).resolves.toMatchObject({
      stalePendingReady: 0,
      stalePendingDeleted: 1,
    });
    await expect(catalog.pending(path)).resolves.not.toBeNull();
    await expect(h.objects.head(name)).resolves.not.toBeNull();

    await expect(h.run('delete')).resolves.toMatchObject({
      stalePendingReady: 0,
      stalePendingDeleted: 1,
    });
    await expect(catalog.get(path, { includePending: true })).resolves.toBeNull();
    await expect(h.objects.head(name)).resolves.toBeNull();
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] a stale upload with the wrong size, no size or no object is dropped with its object', async () => {
    const h = await harness();
    const ws = await h.known();
    const catalog = await h.fixture.catalog(ws.id);
    const wrong = crypto.randomUUID();
    const relay = crypto.randomUUID();
    const missing = crypto.randomUUID();
    await h.reserveRow(ws, 'wrong.bin', { sizeBytes: 5, objectId: wrong });
    await h.newObject(ws.id, wrong, 4);
    await h.reserveRow(ws, 'relay.bin', { objectId: relay });
    await h.newObject(ws.id, relay, 4);
    await h.reserveRow(ws, 'missing.bin', { sizeBytes: 5, objectId: missing });

    await expect(h.run('delete')).resolves.toMatchObject({
      stalePendingReady: 0,
      stalePendingDeleted: 3,
    });
    const later = new Date(Date.now() + CLEANUP_MIN_AGE_MS * 4);
    await expect(catalog.stalePending(later)).resolves.toEqual([]);
    await expect(catalog.get('missing.bin')).resolves.toBeNull();
    await expect(h.objects.head(h.newName(ws.id, wrong))).resolves.toBeNull();
    await expect(h.objects.head(h.newName(ws.id, relay))).resolves.toBeNull();
  });
}
