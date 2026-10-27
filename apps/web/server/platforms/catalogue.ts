/**
 * `GET /api/platforms` — the platform targets an agent can be exported to. The table is static code
 * (`PLATFORM_TARGETS`), so unlike the engine catalogue there is no deployment registry that could
 * hold an unpublishable entry; the conformance test pins the table to the wire schema instead.
 */
import type { PlatformListResponse } from '@indx-workspace/contracts/platforms';
import { PLATFORM_TARGETS } from '@indx-workspace/platforms';

import type { ApiResult } from '../http/result';

/** Every target, in catalogue order, without its `optionsSchema` and `compile` (code, not wire). */
export function listPlatforms(): ApiResult {
  const body: PlatformListResponse = {
    platforms: PLATFORM_TARGETS.map(({ id, displayName, docsUrl, capabilities }) => ({
      id,
      displayName,
      docsUrl,
      capabilities,
    })),
  };
  return { status: 200, body };
}
