import { describe, expect, it, vi } from 'vitest';

import { dailyCostCapEnvironment } from './daily-cost';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';

/** What the ledger answers for a window: a decimal cost, and whether some usage is unpriced. */
const usage = (costUsd: string, unpricedUsage = false) => ({ costUsd, unpricedUsage });

/** A fixed clock; the cap never reads the real one. */
const clock = (start: string) => ({ now: () => new Date(start) });

describe('dailyCostCapEnvironment', () => {
  it('installs nothing, and reads no spend, when the policy sets no cap', () => {
    const sumCostUsd = vi.fn(() => Promise.resolve(usage('99')));
    const environment = dailyCostCapEnvironment(undefined, {
      sumCostUsd,
      now: clock('2026-10-26T10:00:00Z').now,
    });
    expect(environment).toEqual({});
    expect(sumCostUsd).not.toHaveBeenCalled();
  });

  it('installs the cap the policy sets', async () => {
    const environment = dailyCostCapEnvironment(5, {
      sumCostUsd: () => Promise.resolve(usage('5')),
      now: clock('2026-10-26T10:00:00Z').now,
    });
    await expect(environment.dailyCostCap?.refusal(WORKSPACE)).resolves.toMatchObject({
      capUsd: 5,
    });
  });
});
