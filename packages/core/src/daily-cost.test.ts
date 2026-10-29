import { describe, expect, it, vi } from 'vitest';

import { createDailyCostRule, utcDayStart } from './daily-cost.js';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OTHER_WORKSPACE = '55555555-5555-4555-8555-555555555555';
const THIRD_WORKSPACE = '66666666-6666-4666-8666-666666666666';

/** What the ledger answers for a window: a decimal cost, and whether some usage is unpriced. */
const usage = (costUsd: string, unpricedUsage = false) => ({ costUsd, unpricedUsage });

/** A clock the test moves; the rule never reads the real one. */
function clock(start: string) {
  let at = new Date(start).getTime();
  return {
    now: () => new Date(at),
    advanceMs: (ms: number) => {
      at += ms;
    },
  };
}

describe('the daily cost rule: refuses at the cap, on unpriced usage and on an unreadable sum', () => {
  it('lets a start through while the workspace is under the cap', async () => {
    const sumCostUsd = vi.fn(() => Promise.resolve(usage('4.999999')));
    const rule = createDailyCostRule({ sumCostUsd, now: clock('2026-10-26T10:00:00Z').now });
    await expect(rule.refusal(WORKSPACE, 5)).resolves.toBeNull();
  });

  it('refuses at the cap, not only above it, with the cap, the spend and the next UTC midnight', async () => {
    const rule = createDailyCostRule({
      sumCostUsd: () => Promise.resolve(usage('5.000000')),
      now: clock('2026-10-26T23:59:59Z').now,
    });
    await expect(rule.refusal(WORKSPACE, 5)).resolves.toEqual({
      capUsd: 5,
      spentUsd: 5,
      resetsAt: '2026-10-27T00:00:00.000Z',
    });
  });

  it("asks only for today's UTC day, so yesterday's spend does not count", async () => {
    const sumCostUsd = vi.fn(() => Promise.resolve(usage('0')));
    const rule = createDailyCostRule({ sumCostUsd, now: clock('2026-10-26T00:00:30Z').now });
    await rule.refusal(WORKSPACE, 5);
    expect(sumCostUsd).toHaveBeenCalledWith(
      WORKSPACE,
      new Date('2026-10-26T00:00:00Z'),
      new Date('2026-10-27T00:00:00Z'),
    );
  });

  it('sums the day the ledger rows say, with yesterday excluded and the day boundary exclusive', async () => {
    const ledger = [
      { at: '2026-10-25T23:59:59.999Z', usd: 9 },
      { at: '2026-10-26T00:00:00.000Z', usd: 2 },
      { at: '2026-10-27T00:00:00.000Z', usd: 9 },
    ];
    const rule = createDailyCostRule({
      sumCostUsd: (_workspaceId, from, to) =>
        Promise.resolve(
          usage(
            String(
              ledger
                .filter(({ at }) => new Date(at) >= from && new Date(at) < to)
                .reduce((total, { usd }) => total + usd, 0),
            ),
          ),
        ),
      now: clock('2026-10-26T12:00:00Z').now,
    });
    await expect(
      rule.dailyCostUsd(WORKSPACE, utcDayStart(new Date('2026-10-26T12:00:00Z'))),
    ).resolves.toBe(2);
    await expect(rule.refusal(WORKSPACE, 5)).resolves.toBeNull();
  });

  it('serves a workspace its cached sum for 60 s, then reads again', async () => {
    const time = clock('2026-10-26T10:00:00Z');
    const sumCostUsd = vi.fn(() => Promise.resolve(usage('1')));
    const rule = createDailyCostRule({ sumCostUsd, now: time.now });
    await rule.refusal(WORKSPACE, 5);
    time.advanceMs(59_999);
    await rule.refusal(WORKSPACE, 5);
    expect(sumCostUsd).toHaveBeenCalledTimes(1);
    time.advanceMs(1);
    await rule.refusal(WORKSPACE, 5);
    expect(sumCostUsd).toHaveBeenCalledTimes(2);
  });

  it('judges each call against the cap it is given, from one cached read of the spend', async () => {
    const sumCostUsd = vi.fn(() => Promise.resolve(usage('9')));
    const rule = createDailyCostRule({ sumCostUsd, now: clock('2026-10-26T10:00:00Z').now });
    await expect(rule.refusal(WORKSPACE, 5)).resolves.toMatchObject({ capUsd: 5, spentUsd: 9 });
    await expect(rule.refusal(WORKSPACE, 20)).resolves.toBeNull();
    expect(sumCostUsd).toHaveBeenCalledTimes(1);
  });

  it('keeps one cache entry per workspace', async () => {
    const sumCostUsd = vi.fn((workspaceId: string) =>
      Promise.resolve(usage(workspaceId === WORKSPACE ? '9' : '0')),
    );
    const rule = createDailyCostRule({ sumCostUsd, now: clock('2026-10-26T10:00:00Z').now });
    await expect(rule.refusal(WORKSPACE, 5)).resolves.not.toBeNull();
    await expect(rule.refusal(OTHER_WORKSPACE, 5)).resolves.toBeNull();
  });

  it("never serves yesterday's cached sum after UTC midnight", async () => {
    const time = clock('2026-10-26T23:59:30Z');
    const sumCostUsd = vi
      .fn<() => Promise<ReturnType<typeof usage>>>()
      .mockResolvedValueOnce(usage('9'))
      .mockResolvedValueOnce(usage('0'));
    const rule = createDailyCostRule({ sumCostUsd, now: time.now });
    await expect(rule.refusal(WORKSPACE, 5)).resolves.not.toBeNull();
    time.advanceMs(40_000);
    await expect(rule.refusal(WORKSPACE, 5)).resolves.toBeNull();
    expect(sumCostUsd).toHaveBeenCalledTimes(2);
  });

  it('fails closed: a read that throws rejects the check and is not cached', async () => {
    const sumCostUsd = vi
      .fn<() => Promise<ReturnType<typeof usage>>>()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValueOnce(usage('1'));
    const rule = createDailyCostRule({ sumCostUsd, now: clock('2026-10-26T10:00:00Z').now });
    await expect(rule.refusal(WORKSPACE, 5)).rejects.toThrow('database down');
    await expect(rule.refusal(WORKSPACE, 5)).resolves.toBeNull();
    expect(sumCostUsd).toHaveBeenCalledTimes(2);
  });

  it("refuses under the cap while some of the day's usage is unpriced, saying why", async () => {
    const rule = createDailyCostRule({
      sumCostUsd: () => Promise.resolve(usage('0', true)),
      now: clock('2026-10-26T10:00:00Z').now,
    });
    await expect(rule.refusal(WORKSPACE, 5)).resolves.toEqual({
      capUsd: 5,
      spentUsd: 0,
      resetsAt: '2026-10-27T00:00:00.000Z',
      unpricedUsage: true,
    });
  });

  it('does not add unpricedUsage to a refusal that is simply over the cap', async () => {
    const rule = createDailyCostRule({
      sumCostUsd: () => Promise.resolve(usage('6', true)),
      now: clock('2026-10-26T10:00:00Z').now,
    });
    const refusal = await rule.refusal(WORKSPACE, 5);
    expect(refusal).toMatchObject({ spentUsd: 6 });
    expect(refusal).not.toHaveProperty('unpricedUsage');
  });

  it('evicts expired and previous-day entries when it writes, so the cache stays bounded', async () => {
    const time = clock('2026-10-26T23:00:00Z');
    const rule = createDailyCostRule({
      sumCostUsd: () => Promise.resolve(usage('1')),
      now: time.now,
    });
    await rule.refusal(WORKSPACE, 5);
    time.advanceMs(30_000);
    await rule.refusal(OTHER_WORKSPACE, 5);
    expect(rule.cachedWorkspaceCount()).toBe(2);
    // 40 s on, WORKSPACE's read (70 s old) has expired and OTHER_WORKSPACE's (40 s old) has not.
    time.advanceMs(40_000);
    await rule.refusal(THIRD_WORKSPACE, 5);
    expect(rule.cachedWorkspaceCount()).toBe(2);
    // After UTC midnight every earlier entry is for a previous day: only the new write is left.
    time.advanceMs(3_600_000);
    await rule.refusal(WORKSPACE, 5);
    expect(rule.cachedWorkspaceCount()).toBe(1);
  });

  it('refuses a sum that is not a number', async () => {
    const rule = createDailyCostRule({
      sumCostUsd: () => Promise.resolve(usage('not-a-number')),
      now: clock('2026-10-26T10:00:00Z').now,
    });
    await expect(rule.refusal(WORKSPACE, 5)).resolves.not.toBeNull();
  });
});
