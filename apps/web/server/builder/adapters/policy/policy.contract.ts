import { BUILDER_DEFAULT_LIMITS } from '@indx-workspace/contracts/builder';
import { describe, expect, it } from 'vitest';

import type { CallContext, PolicyPort } from '../../ports';
import { TEST_DOOR } from '../../testing/context';

const ctx: CallContext = {
  workspaceId: 'workspace-1',
  door: TEST_DOOR,
  runId: 'run-1',
  traceId: 'trace-1',
  modelId: 'model-1',
  promptVersion: 'prompt-1',
  caller: { kind: 'none' },
};

export function describePolicyConformance(label: string, make: () => PolicyPort): void {
  describe(`PolicyPort: ${label}`, () => {
    it('returns every default limit as a positive number', async () => {
      const limits = await make().limits(ctx);
      expect(Object.keys(limits).sort()).toEqual(Object.keys(BUILDER_DEFAULT_LIMITS).sort());
      for (const value of Object.values(limits)) expect(value).toBeGreaterThan(0);
    });

    it('returns the defaults when nothing overrides them', async () => {
      await expect(make().limits(ctx)).resolves.toEqual(BUILDER_DEFAULT_LIMITS);
    });

    it('returns a fresh object, so a caller cannot change the next answer', async () => {
      const policy = make();
      const first = await policy.limits(ctx);
      Object.assign(first, { maxToolCallsPerRun: 0 });
      await expect(policy.limits(ctx)).resolves.toEqual(BUILDER_DEFAULT_LIMITS);
    });
  });
}
