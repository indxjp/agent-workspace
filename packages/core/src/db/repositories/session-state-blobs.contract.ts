/**
 * The session-state blob rows' reserve/confirm contract (the storage design, §04 "Saving a file"):
 * the in-memory rows and the PostgreSQL repository both run it, so the service's tests on memory
 * cannot pass a rule the database breaks. The token rules are the file catalog's: a pending row
 * carries the reservation it was made under, and `confirmBlob`, `claimBlob` and `forgetBlob` act
 * only on that reservation, so a row claimed, purged or confirmed since a caller read it is never
 * changed by that caller's stale copy.
 *
 * A fixture owes the suite the blob rows of two unrelated workspaces (`'a'` and `'b'`) and a session
 * of workspace `'a'`. `makeFixture` runs once per test.
 */
import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { SessionStateBlobClaim, SessionStateBlobRepository } from './session-state.js';

export interface SessionStateBlobConformanceFixture {
  readonly blobs: (workspace: 'a' | 'b') => SessionStateBlobRepository;
  /** A session of workspace `'a'`. */
  readonly sessionId: string;
}

const ENGINE = 'claude-agent-sdk' as const;
const SHA = 'a'.repeat(64);
/** Later than every row a test writes: the cutoff that purges or settles everything. */
const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60 * 60_000);

export function describeSessionStateBlobConformance(
  label: string,
  makeFixture: () => Promise<SessionStateBlobConformanceFixture>,
): void {
  describe(`session-state blob conformance: ${label}`, () => {
    async function setup() {
      const f = await makeFixture();
      const rows = f.blobs('a');
      const reserve = () => {
        const objectId = crypto.randomUUID();
        return rows.reserveBlob(f.sessionId, {
          engine: ENGINE,
          objectId,
          storageKey: `workspaces/ws/session-state/${objectId}`,
        });
      };
      const save = async (blobKey: string, sizeBytes = 1) => {
        const pending = await reserve();
        const confirmed = await rows.confirmBlob(pending, { blobKey, sizeBytes, sha256: SHA });
        if (confirmed === null) throw new Error(`the reservation for ${blobKey} was lost`);
        return { pending, replaced: confirmed.replaced };
      };
      const read = (blobKey: string) => rows.getBlob(f.sessionId, ENGINE, blobKey);
      return { f, rows, reserve, save, read };
    }

    it('a reserve writes a pending row first: never served, but it holds its object', async () => {
      const { rows, reserve, f } = await setup();
      const pending = await reserve();

      expect(pending).toMatchObject({
        sessionId: f.sessionId,
        engine: ENGINE,
        status: 'pending',
        reservationToken: expect.any(String) as unknown,
      });
      await expect(rows.listBlobs(f.sessionId)).resolves.toEqual([]);
      await expect(rows.referencedObjectIds([pending.objectId ?? ''])).resolves.toEqual([
        pending.objectId,
      ]);
      // The side key is not a caller's key, so nothing reads the pending row by its blob key.
      await expect(rows.getBlob(f.sessionId, ENGINE, pending.rowKey)).resolves.toBeNull();
    });

    it('a confirm serves the row under its key with the measured size and checksum', async () => {
      const { rows, reserve, read } = await setup();
      const pending = await reserve();

      await expect(
        rows.confirmBlob(pending, { blobKey: 'state.tar', sizeBytes: 7, sha256: SHA }),
      ).resolves.toEqual({ replaced: null });
      await expect(read('state.tar')).resolves.toEqual({
        blobKey: 'state.tar',
        objectId: pending.objectId,
        storageKey: pending.storageKey,
        sizeBytes: 7,
        sha256: SHA,
      });
      // Confirmed once: the reservation is spent, so a replayed confirm changes nothing.
      await expect(
        rows.confirmBlob(pending, { blobKey: 'other.tar', sizeBytes: 1, sha256: SHA }),
      ).resolves.toBeNull();
      await expect(read('other.tar')).resolves.toBeNull();
    });

    it('a replacing confirm moves the old row aside as deleting until it is forgotten', async () => {
      const { rows, save, read } = await setup();
      const first = await save('state.tar', 1);
      const second = await save('state.tar', 2);

      const replaced = second.replaced;
      expect(replaced).toMatchObject({
        status: 'deleting',
        objectId: first.pending.objectId,
        storageKey: first.pending.storageKey,
        reservationToken: null,
      });
      await expect(read('state.tar')).resolves.toMatchObject({
        objectId: second.pending.objectId,
        sizeBytes: 2,
      });
      // The replaced object is still held until its row is forgotten.
      const ids = [first.pending.objectId ?? '', second.pending.objectId ?? ''];
      await expect(
        rows.referencedObjectIds(ids).then((found) => [...found].sort()),
      ).resolves.toEqual([...ids].sort());
      if (replaced === null) throw new Error('nothing was replaced');
      await expect(rows.forgetBlob(replaced)).resolves.toBe(true);
      await expect(rows.referencedObjectIds(ids)).resolves.toEqual([second.pending.objectId]);
      await expect(rows.forgetBlob(replaced)).resolves.toBe(false);
    });

    it('a forget of a pending row acts only on its own reservation', async () => {
      const { rows, reserve, read } = await setup();
      const pending = await reserve();
      await rows.confirmBlob(pending, { blobKey: 'kept.tar', sizeBytes: 1, sha256: SHA });

      // The confirm committed; the saver's stale copy of its pending row forgets nothing.
      await expect(rows.forgetBlob(pending)).resolves.toBe(false);
      await expect(read('kept.tar')).resolves.not.toBeNull();

      const abandoned = await reserve();
      await expect(rows.forgetBlob(abandoned)).resolves.toBe(true);
      await expect(rows.referencedObjectIds([abandoned.objectId ?? ''])).resolves.toEqual([]);
    });

    it('a claimed reservation cannot be confirmed, and a confirmed one cannot be claimed', async () => {
      const { rows, reserve, read } = await setup();
      const stale = await reserve();
      const claimed = await rows.claimBlob(stale);

      expect(claimed).toMatchObject({ status: 'deleting', objectId: stale.objectId });
      await expect(
        rows.confirmBlob(stale, { blobKey: 'late.tar', sizeBytes: 1, sha256: SHA }),
      ).resolves.toBeNull();
      await expect(read('late.tar')).resolves.toBeNull();
      await expect(rows.claimBlob(stale)).resolves.toBeNull();

      const confirmed = await reserve();
      await rows.confirmBlob(confirmed, { blobKey: 'done.tar', sizeBytes: 1, sha256: SHA });
      await expect(rows.claimBlob(confirmed)).resolves.toBeNull();
      await expect(read('done.tar')).resolves.not.toBeNull();
    });

    it('the unsettled rows are the deleting ones and the pending ones older than the cutoff', async () => {
      const { rows, reserve, save } = await setup();
      const pending = await reserve();
      await save('ready.tar');
      const { replaced } = await save('ready.tar');

      await expect(rows.unsettledBlobs(past())).resolves.toEqual([replaced]);
      const all = await rows.unsettledBlobs(future());
      expect(all.map((row) => row.objectId).sort()).toEqual(
        [pending.objectId, replaced?.objectId].sort(),
      );
      expect(all.find((row) => row.status === 'pending')).toEqual(pending);
    });

    it('a purge marks rows deleting before their bytes go, and a purged reservation is not confirmed', async () => {
      const { rows, reserve, save, read, f } = await setup();
      const ready = await save('old.tar');
      const pending = await reserve();

      const purged = await rows.purgeBefore(future());

      expect(purged.blobs.map((row) => row.status)).toEqual(['deleting', 'deleting']);
      expect(purged.blobs.map((row) => row.objectId).sort()).toEqual(
        [ready.pending.objectId, pending.objectId].sort(),
      );
      await expect(read('old.tar')).resolves.toBeNull();
      await expect(rows.listBlobs(f.sessionId)).resolves.toEqual([]);
      // Marked, not dropped: the rows hold their objects until the caller has deleted them.
      const ids = purged.blobs.map((row) => row.objectId ?? '');
      await expect(rows.referencedObjectIds(ids)).resolves.toHaveLength(2);
      // Already deleting: a second purge does not hand the same rows out again.
      await expect(rows.purgeBefore(future()).then((again) => again.blobs)).resolves.toEqual([]);
      await expect(
        rows.confirmBlob(pending, { blobKey: 'late.tar', sizeBytes: 1, sha256: SHA }),
      ).resolves.toBeNull();
      // The key is free for a new save while the purged row waits aside.
      await save('old.tar');
      await expect(read('old.tar')).resolves.not.toBeNull();
      for (const row of purged.blobs) await expect(rows.forgetBlob(row)).resolves.toBe(true);
      await expect(rows.referencedObjectIds(ids)).resolves.toEqual([]);
    });

    it('a confirm refuses a key that is not a caller key', async () => {
      const { rows, reserve } = await setup();
      const pending = await reserve();
      await expect(
        rows.confirmBlob(pending, { blobKey: pending.rowKey, sizeBytes: 1, sha256: SHA }),
      ).rejects.toThrow();
    });

    it('another workspace cannot confirm, claim or forget a reservation', async () => {
      const { f, rows, reserve, read } = await setup();
      const pending = await reserve();
      const other = f.blobs('b');
      const claim: SessionStateBlobClaim = pending;

      await expect(
        other.confirmBlob(claim, { blobKey: 'stolen.tar', sizeBytes: 1, sha256: SHA }),
      ).resolves.toBeNull();
      await expect(other.claimBlob(claim)).resolves.toBeNull();
      await expect(other.forgetBlob(claim)).resolves.toBe(false);
      await expect(other.unsettledBlobs(future())).resolves.toEqual([]);
      await expect(
        rows.confirmBlob(pending, { blobKey: 'mine.tar', sizeBytes: 1, sha256: SHA }),
      ).resolves.toEqual({ replaced: null });
      await expect(read('mine.tar')).resolves.not.toBeNull();
    });
  });
}
