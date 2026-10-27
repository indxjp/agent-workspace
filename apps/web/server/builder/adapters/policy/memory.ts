import { BUILDER_DEFAULT_LIMITS } from '@indx-workspace/contracts/builder';

import type { Facts } from '../../core/facts';
import type { PolicyPort } from '../../ports';

/** The defaults, with whatever limits a test overrides. */
export class MemoryPolicy implements PolicyPort {
  constructor(private readonly overrides: Partial<Facts['limits']> = {}) {}

  limits: PolicyPort['limits'] = () =>
    Promise.resolve({ ...BUILDER_DEFAULT_LIMITS, ...this.overrides });
}
