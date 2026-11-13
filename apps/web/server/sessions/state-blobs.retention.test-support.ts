import { expect, it } from 'vitest';
import type { SessionBlobFixture } from './state-blobs.harness.test-support';

export function registerSessionBlobRetentionTests(
  getFixture: () => Pick<SessionBlobFixture, 'harness'>,
) {
  // @story US-STO-09
  it('[US-STO-09][api][run] retention deletes the row and its object', async () => {
    const testContext = getFixture();

    const h = await testContext.harness();
    await h.as(h.user).put(new Uint8Array([1]));

    await h.stateStore.purgeBefore(h.f.workspaceId, new Date(Date.now() + 60_000));

    await expect(h.stored()).resolves.toBeNull();
    await expect(h.objectNames()).resolves.toEqual([]);
    await expect(h.unsettled()).resolves.toEqual([]);
  });

  // @story US-STO-09
  it('[US-STO-09][contract][sdk] a save writes its pending row before the first byte', async () => {
    const testContext1 = getFixture();

    const h = await testContext1.harness();
    let seen: { held: readonly string[]; served: unknown; objectId: string } | undefined;
    h.raceNextWrite(async (name) => {
      const objectId = name.split('/').at(-1) ?? '';
      const held = await h.repository.referencedObjectIds([objectId]);
      seen = { held, served: await h.stored(), objectId };
    });

    expect((await h.as(h.user).put(new Uint8Array([4, 2]))).status).toBe(204);

    // The object was held by a row before it was written, and that row was not served yet.
    expect(seen?.held).toEqual([seen?.objectId]);
    expect(seen?.served).toBeNull();
    expect((await h.stored())?.objectId).toBe(seen?.objectId);
    await expect(h.unsettled()).resolves.toEqual([]);
  });

  // @story US-STO-09
  it('[US-STO-09][contract][run] a reservation purged during the write is not confirmed and leaves nothing', async () => {
    const testContext2 = getFixture();

    const h = await testContext2.harness();
    h.raceNextWrite(() => h.stateStore.purgeBefore(h.f.workspaceId, new Date(Date.now() + 60_000)));

    await expect(h.stateStore.putBlob(ref(h.f), streamOf(new Uint8Array([7])))).rejects.toThrow(
      /reservation/u,
    );

    await expect(h.stored()).resolves.toBeNull();
    await expect(h.objectNames()).resolves.toEqual([]);
    await expect(h.unsettled()).resolves.toEqual([]);
  });

  // @story US-STO-09
  it('[US-STO-09][api][run] retention marks a blob deleting before its bytes go', async () => {
    const testContext3 = getFixture();

    const h = await testContext3.harness();
    await h.as(h.user).put(new Uint8Array([1]));
    const saved = await h.stored();
    const atDelete: { served: unknown; unsettled: unknown }[] = [];
    h.onDelete(async () => {
      atDelete.push({ served: await h.stored(), unsettled: await h.unsettled() });
    });

    await h.stateStore.purgeBefore(h.f.workspaceId, new Date(Date.now() + 60_000));

    expect(atDelete).toEqual([
      {
        served: null,
        unsettled: [expect.objectContaining({ status: 'deleting', objectId: saved?.objectId })],
      },
    ]);
    await expect(h.unsettled()).resolves.toEqual([]);
  });

  // @story US-STO-09
  it('[US-STO-09][api][run] a failed delete during retention keeps the row deleting for the cleanup job', async () => {
    const testContext4 = getFixture();

    const h = await testContext4.harness();
    await h.as(h.user).put(new Uint8Array([1]));
    const saved = await h.stored();
    h.failDeletes();

    await h.stateStore.purgeBefore(h.f.workspaceId, new Date(Date.now() + 60_000));

    await expect(h.stored()).resolves.toBeNull();
    await expect(h.unsettled()).resolves.toEqual([
      expect.objectContaining({ status: 'deleting', objectId: saved?.objectId }),
    ]);
    await expect(h.objectNames()).resolves.toEqual([saved?.storageKey]);
  });
}

import { ref, streamOf } from './state-blobs.fixture.test-support';
