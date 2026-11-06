import { describe, expect, it } from 'vitest';

import { compose } from './run-request.fixture.test-support';
export function registerDailyCostCapTests() {
  describe('buildRunRequestFor — the daily cost cap claim (issue #1851)', () => {
    const none = { files: [], skills: [], mcpServers: {} };

    it('signs the ceiling’s maxCostPerDayUsd into the run token, so the gateway can stop the run', async () => {
      const { run, issued } = await compose(none, {}, undefined, undefined, {
        ceiling: { maxCostPerDayUsd: 5 },
      });
      await run();
      expect(issued).toEqual([expect.objectContaining({ dailyCostCapUsd: 5 })]);
    });

    it('signs no claim when there is no ceiling, or the ceiling sets no cap', async () => {
      for (const ceiling of [null, {}]) {
        const { run, issued } = await compose(none, {}, undefined, undefined, { ceiling });
        await run();
        expect(issued).toEqual([
          expect.not.objectContaining({ dailyCostCapUsd: expect.anything() as unknown }),
        ]);
      }
    });
  });
}
