/**
 * The signed-upload helpers read the time from a Clock (refactoring plan part 10, step 4): a mint
 * hands the service its clock's time, and the link limiter's default is the current time.
 */
import { LINK_REQUESTS_PER_MINUTE_PER_WORKSPACE } from '@indx-workspace/contracts/files';
import { afterEach, describe, expect, it } from 'vitest';

import { fixedClock } from '../clock';
import type { StorageContext, StorageService } from '../storage/service';
import { refuseLinkRequest, reserveCatalogUpload, resetLinkRequestLimits } from './uploads';

const WORKSPACE = 'ws-clock';

afterEach(() => resetLinkRequestLimits());

describe('signed uploads take the time from a clock', () => {
  it('hands the storage service the clock’s time when it reserves the upload', async () => {
    const clock = fixedClock('2026-11-12T03:04:05.000Z');
    const seen: (Date | undefined)[] = [];
    const storage = {
      reserveUpload: (_ctx: StorageContext, request: { readonly now?: Date }) => {
        seen.push(request.now);
        return Promise.resolve({ ok: false, code: 'name_conflict' });
      },
    } as unknown as StorageService;
    const ctx = { workspaceId: WORKSPACE, principalId: 'p', userId: null } as StorageContext;

    await reserveCatalogUpload(
      storage,
      ctx,
      'docs/a.txt',
      { sizeBytes: 3 },
      () => Promise.resolve(null),
      clock,
    );

    expect(seen.map((now) => now?.toISOString())).toEqual(['2026-11-12T03:04:05.000Z']);
  });

  it('counts a link request at the current time when it is given none', () => {
    const longAgo = 1_000_000;
    for (let index = 0; index < LINK_REQUESTS_PER_MINUTE_PER_WORKSPACE; index += 1) {
      expect(refuseLinkRequest(WORKSPACE, longAgo)).toBeNull();
    }
    expect(refuseLinkRequest(WORKSPACE, longAgo)?.status).toBe(429);

    // The window of the requests made long ago has passed by now.
    expect(refuseLinkRequest(WORKSPACE)).toBeNull();
  });
});
