import { BUILDER_DEFAULT_LIMITS } from '@indx-workspace/contracts/builder';
import { expect, it } from 'vitest';

import { TEST_DOOR } from '../../testing/context';
import { MemoryPolicy } from './memory';
import { describePolicyConformance } from './policy.contract';
import { createPolicy } from './production';

describePolicyConformance('production', createPolicy);
describePolicyConformance('memory', () => new MemoryPolicy());

it('the memory policy applies a test override and keeps the other defaults', async () => {
  const limits = await new MemoryPolicy({ maxToolCallsPerRun: 2 }).limits({
    workspaceId: 'w',
    door: TEST_DOOR,
    runId: 'r',
    traceId: 't',
    modelId: 'm',
    promptVersion: 'p',
    caller: { kind: 'none' },
  });
  expect(limits).toEqual({ ...BUILDER_DEFAULT_LIMITS, maxToolCallsPerRun: 2 });
});
