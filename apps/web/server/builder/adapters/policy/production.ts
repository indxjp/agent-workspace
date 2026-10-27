import { BUILDER_DEFAULT_LIMITS } from '@indx-workspace/contracts/builder';

import type { PolicyPort } from '../../ports';

/** B0 has no per-workspace overrides and no deployment override: every call gets the defaults. */
export function createPolicy(): PolicyPort {
  return { limits: () => Promise.resolve({ ...BUILDER_DEFAULT_LIMITS }) };
}
