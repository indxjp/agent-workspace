import { expect, it } from 'vitest';
import { MAX_PENDING_UPLOADS_PER_WORKSPACE } from '@indx-workspace/contracts/files';
import { CLEANUP_MIN_AGE_MS } from './cleanup';
import { type UploadHarnessFactory } from './service-upload.fixture.test-support';
export function registerUploadPendingLimitTests(harness: UploadHarnessFactory) {
  // @story US-STO-02
  it('[US-STO-02][unit][sdk] a refused replace leaves no row, and re-minting a pending path is not counted twice', async () => {
    const h = await harness();
    await h.save('a.txt', 'old');
    await expect(h.mint('a.txt', 3, false)).resolves.toEqual({
      ok: false,
      code: 'replace_refused',
    });
    await expect(h.catalog.countPending()).resolves.toBe(0);

    await h.reservePending(MAX_PENDING_UPLOADS_PER_WORKSPACE - 1);
    await expect(h.mint('b.txt', 1)).resolves.toMatchObject({ ok: true });
    await expect(h.mint('b.txt', 1)).resolves.toMatchObject({ ok: true });
    await expect(h.catalog.countPending()).resolves.toBe(MAX_PENDING_UPLOADS_PER_WORKSPACE);
    await expect(h.mint('c.txt', 1)).resolves.toEqual({ ok: false, code: 'too_many_pending' });
    await expect(h.catalog.countPending()).resolves.toBe(MAX_PENDING_UPLOADS_PER_WORKSPACE);
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] concurrent mints one below the pending cap never leave more than the cap pending', async () => {
    const h = await harness();
    await h.reservePending(MAX_PENDING_UPLOADS_PER_WORKSPACE - 1);

    const minted = await Promise.all(
      Array.from({ length: 10 }, (_, index) => h.mint(`burst/${index}.bin`, 1)),
    );

    // Each mint counts after its own reservation, so the last admitted one counts every admitted
    // row: the cap is never exceeded, though a mint near it may be refused for a sibling.
    const admitted = minted.filter((outcome) => outcome.ok).length;
    expect(admitted).toBeLessThanOrEqual(1);
    for (const outcome of minted) {
      if (!outcome.ok) expect(outcome).toEqual({ ok: false, code: 'too_many_pending' });
    }
    await expect(h.catalog.countPending()).resolves.toBe(
      MAX_PENDING_UPLOADS_PER_WORKSPACE - 1 + admitted,
    );
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] abandoned uploads older than the maximum link lifetime plus an hour do not block new links', async () => {
    const h = await harness();
    await h.reservePending(MAX_PENDING_UPLOADS_PER_WORKSPACE, 'abandoned');
    await expect(h.mint('fresh.txt', 1)).resolves.toEqual({
      ok: false,
      code: 'too_many_pending',
    });

    // Later than every link those reservations could hold, and still unconfirmed: report-only
    // cleanup never removes them, so only the age keeps them out of the cap.
    const later = new Date(Date.now() + CLEANUP_MIN_AGE_MS + 60_000);
    await expect(
      h.storage.reserveUpload(h.ctx, {
        path: 'fresh.txt',
        sizeBytes: 1,
        now: later,
        mayReplace: () => Promise.resolve(true),
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(h.catalog.countPending()).resolves.toBe(MAX_PENDING_UPLOADS_PER_WORKSPACE + 1);
  });
}
