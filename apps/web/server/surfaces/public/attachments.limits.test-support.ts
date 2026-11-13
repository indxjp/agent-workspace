import {
  ATTACHMENT_SESSION_ID,
  OTHER_ATTACHMENT_SESSION_ID,
} from './attachments.fixture.test-support';
import { streamOf, trackedBody } from './attachments.fixture.test-support';
import {
  SURFACE_ATTACHMENT_MAX_BYTES,
  SURFACE_ATTACHMENTS_MAX_FILES,
  SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES,
} from '@indx-workspace/contracts/surfaces';
import { expect, it } from 'vitest';

import { SURFACE_RATE_LIMITS } from './limits';

import type { AttachmentHarness } from './attachments.fixture.test-support';

export function registerAttachmentLimitsTests(getHarness: () => AttachmentHarness) {
  // @story US-STO-11
  it('[US-STO-11][api][chat] a file over SURFACE_ATTACHMENT_MAX_BYTES is refused and leaves no row and no object', async () => {
    const h = getHarness();
    const { upload, code, stored } = h;
    const before = await stored();
    const unread = trackedBody();
    const declared = await upload('big.bin', unread.body, {
      headers: { 'content-length': String(SURFACE_ATTACHMENT_MAX_BYTES + 1) },
    });
    expect(declared.status).toBe(413);
    expect(await code(declared)).toBe('request_body_too_large');
    expect(unread.read()).toBe(false);
    const streamed = await upload('big.bin', streamOf(SURFACE_ATTACHMENT_MAX_BYTES + 1));
    expect(streamed.status).toBe(413);
    expect(await code(streamed)).toBe('request_body_too_large');
    expect(await stored()).toEqual(before);

    const exact = await upload('exact.bin', streamOf(SURFACE_ATTACHMENT_MAX_BYTES));
    expect(exact.status).toBe(201);
  });

  // @story US-STO-11
  it('[US-STO-11][api][chat] the file after SURFACE_ATTACHMENTS_MAX_FILES is refused and leaves no row and no object', async () => {
    const h = getHarness();
    const { upload, code, seed, stored } = h;
    for (let count = 0; count < SURFACE_ATTACHMENTS_MAX_FILES; count += 1) {
      await seed(ATTACHMENT_SESSION_ID, 1);
    }
    const before = await stored();
    const response = await upload('one-more.txt');
    expect(response.status).toBe(413);
    expect(await code(response)).toBe('attachments_quota_exceeded');
    expect(await stored()).toEqual(before);
    expect(before.files).toHaveLength(SURFACE_ATTACHMENTS_MAX_FILES);
  });

  // @story US-STO-11
  it('[US-STO-11][api][chat] a file past SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES is refused, counting only its own session', async () => {
    const h = getHarness();
    const { upload, code, seed, stored } = h;
    await seed(OTHER_ATTACHMENT_SESSION_ID, SURFACE_ATTACHMENT_MAX_BYTES);
    const half = SURFACE_ATTACHMENT_MAX_BYTES / 2;
    for (let left = SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES - half; left > 0;) {
      const size = Math.min(SURFACE_ATTACHMENT_MAX_BYTES, left);
      await seed(ATTACHMENT_SESSION_ID, size);
      left -= size;
    }
    const before = await stored();
    const response = await upload('over.bin', streamOf(half + 1));
    expect(response.status).toBe(413);
    expect(await code(response)).toBe('attachments_quota_exceeded');
    expect(await stored()).toEqual(before);

    expect((await upload('fits.bin', streamOf(half))).status).toBe(201);
  }, 120_000);

  it('answers 429 surface_rate_limited with Retry-After on the eleventh upload in a minute', async () => {
    const h = getHarness();
    const { upload, code } = h;
    for (let sent = 0; sent < SURFACE_RATE_LIMITS.attachmentsPerSession; sent += 1) {
      expect((await upload(`f${String(sent)}.txt`)).status).toBe(201);
    }
    const response = await upload('late.txt');
    expect(response.status).toBe(429);
    expect(await code(response)).toBe('surface_rate_limited');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  });
}
