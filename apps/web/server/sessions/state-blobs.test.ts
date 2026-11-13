import { describe, expect, it } from 'vitest';
import { createSessionBlobFixture } from './state-blobs.harness.test-support';
import { registerSessionBlobResumeTests } from './state-blobs.resume.test-support';
import { registerSessionBlobConfirmationTests } from './state-blobs.confirmation.test-support';
import { registerSessionBlobRetentionTests } from './state-blobs.retention.test-support';
import { registerSessionBlobMemoryTests } from './state-blobs.memory.test-support';
import { type Fixture, memoryFixture, postgresFixture } from './state-blobs.fixture.test-support';
function defineSuite(name: string, setup: () => Promise<Fixture>) {
  describe(`session state blobs on the ${name}`, () => {
    const fixture = createSessionBlobFixture(setup);

    // @story US-STO-09
    it('[US-STO-09][api][sdk] resume restores state', async () => {
      const testContext = fixture;

      const h = await testContext.harness();
      const api = h.as(h.user);
      const bytes = new Uint8Array([1, 2, 3, 4]);
      expect((await api.put(bytes)).status).toBe(204);

      const read = await api.get();
      expect(read.status).toBe(200);
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);

      // The row names a new object ID, and the bytes are at the one name that ID makes.
      const row = await h.stored();
      expect(row?.objectId).toMatch(/^[0-9a-f-]{36}$/u);
      const name = `workspaces/${h.f.workspaceId}/session-state/${row?.objectId ?? ''}`;
      expect(row?.storageKey).toBe(name);
      await expect(h.objectNames()).resolves.toEqual([name]);
    });

    // @story US-STO-09
    it('[US-STO-09][api][run] engine resume reads state', async () => {
      const testContext1 = fixture;

      const h = await testContext1.harness();
      await h.as(h.user).put(new Uint8Array([9, 8, 7]));

      const read = await h.as(h.runner).get();
      expect(read.status).toBe(200);
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    });

    // @story US-STO-09
    it('[US-STO-09][api][chat] resumed chat keeps its state', async () => {
      const testContext2 = fixture;

      const h = await testContext2.harness();
      const api = h.as(h.user);
      await api.put(new Uint8Array([1]));
      const first = (await h.stored())?.objectId;
      await api.put(new Uint8Array([2, 2]));
      const second = (await h.stored())?.objectId;

      expect(second).not.toBe(first);
      expect(new Uint8Array(await (await api.get()).arrayBuffer())).toEqual(new Uint8Array([2, 2]));
      // The replaced object went after the new row was confirmed; one object is left.
      await expect(h.objectNames()).resolves.toEqual([
        `workspaces/${h.f.workspaceId}/session-state/${second ?? ''}`,
      ]);
    });
    registerSessionBlobResumeTests(() => fixture);
    registerSessionBlobConfirmationTests(() => fixture);
    registerSessionBlobRetentionTests(() => fixture);
    registerSessionBlobMemoryTests(() => fixture);
  });
}
defineSuite('in-memory repository', memoryFixture);
defineSuite('PostgreSQL repository', postgresFixture);
