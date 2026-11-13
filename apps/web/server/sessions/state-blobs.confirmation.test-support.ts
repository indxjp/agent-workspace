import { expect, it } from 'vitest';
import { type ObjectStore } from '@agent-workspace/core/storage';
import { SESSION_STATE_BLOB_MAX_BYTES } from '@agent-workspace/engine';
import type { SessionBlobFixture } from './state-blobs.harness.test-support';
import { ENGINE, BLOB_KEY, lazyBody } from './state-blobs.fixture.test-support';
export function registerSessionBlobConfirmationTests(
  getFixture: () => Pick<SessionBlobFixture, 'harness'>,
) {
  // @story US-STO-09
  it('[US-STO-09][contract][sdk] a blob over the cap leaves no row and no object', async () => {
    const testContext = getFixture();

    const h = await testContext.harness();
    const refused = await h.storage.saveSessionState(
      { workspaceId: h.f.workspaceId },
      { sessionId: h.f.sessionId, engine: ENGINE, blobKey: BLOB_KEY },
      lazyBody(SESSION_STATE_BLOB_MAX_BYTES + 1),
    );

    expect(refused).toEqual({ ok: false, code: 'too_large' });
    await expect(h.stored()).resolves.toBeNull();
    await expect(h.objectNames()).resolves.toEqual([]);
  });

  // @story US-STO-09
  it('[US-STO-09][contract][sdk] a lost confirm keeps the replaced blob and its object', async () => {
    const testContext1 = getFixture();

    const h = await testContext1.harness();
    const api = h.as(h.user);
    await api.put(new Uint8Array([1, 1]));
    const kept = await h.stored();

    // The next confirm fails: the old object is not deleted, the old row still serves.
    h.failNextConfirm();
    await expect(h.stateStore.putBlob(ref(h.f), streamOf(new Uint8Array([2])))).rejects.toThrow(
      'the confirm was lost',
    );

    expect((await h.stored())?.objectId).toBe(kept?.objectId);
    expect(new Uint8Array(await (await api.get()).arrayBuffer())).toEqual(new Uint8Array([1, 1]));
    // The confirm never committed: its reservation and the object it wrote are gone with it.
    await expect(h.objectNames()).resolves.toEqual([kept?.storageKey]);
    await expect(h.unsettled()).resolves.toEqual([]);
  });

  // @story US-STO-09
  it('[US-STO-09][contract][sdk] no doubled prefix', async () => {
    const testContext2 = getFixture();

    const h = await testContext2.harness();
    await h.as(h.user).put(new Uint8Array([3, 3]));

    // The whole root store and the old store, so a name under any prefix shows up.
    const keys = async (store: ObjectStore) =>
      (await store.listPage('', { recursive: true })).entries.map((entry) => entry.key);
    const all = [
      ...(await keys(h.objects)),
      ...(await keys(h.legacy.forWorkspace(h.f.workspaceId))),
    ];
    expect(all).toHaveLength(1);
    for (const key of all) expect(key).not.toMatch(/session-state.*session-state/u);
  });

  // @story US-STO-09
  it('[US-STO-09][contract][sdk] a read that races a save reads the saved blob', async () => {
    const testContext3 = getFixture();

    const h = await testContext3.harness();
    const api = h.as(h.user);
    await api.put(new Uint8Array([1]));

    // The save confirms after the read has the old row, so the object that row names is gone.
    h.raceNextRowRead(() => h.stateStore.putBlob(ref(h.f), streamOf(new Uint8Array([2, 2]))));
    const read = await h.stateStore.getBlob(ref(h.f));

    if (!read.ok || read.content === null) throw new Error('the racing read found no blob');
    expect(new Uint8Array(read.content.bytes)).toEqual(new Uint8Array([2, 2]));
    expect(read.content.sha256).toBe((await h.stored())?.sha256);
  });
}

import { ref, streamOf } from './state-blobs.fixture.test-support';
