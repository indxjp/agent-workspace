import { RUN_STATUSES } from '@indx-workspace/contracts/runs';
import { describe, expect, it } from 'vitest';
import { taskState } from './v0_3/map';

export function registerA2aStatusTests() {
  describe('the run status a task reports', () => {
    it.each(RUN_STATUSES.map((status) => [status]))('maps %s', (status) => {
      expect(taskState(status)).toBe(
        {
          queued: 'submitted',
          running: 'working',
          awaiting_approval: 'input-required',
          completed: 'completed',
          failed: 'failed',
          cancelled: 'canceled',
        }[status],
      );
    });
  });
}
