import { describe, expect, it } from 'vitest';

import type { DemoSpend } from '../../ports';

const DAY = new Date('2026-11-16T00:00:00.000Z');
const NOON = new Date('2026-11-16T12:00:00.000Z');

/** A fresh spend and the ways to put rows behind it, in either adapter's terms. */
export interface SpendRig {
  readonly spend: DemoSpend;
  /** A priced usage row of a live demo workspace. */
  readonly addLive: (at: Date, costUsd: number) => Promise<void>;
  /** A usage row of a live demo workspace whose settlement is not priced. */
  readonly addLiveUnpriced: (at: Date) => Promise<void>;
  /** A usage row of a live workspace that is not a demo workspace. */
  readonly addReal: (at: Date, costUsd: number) => Promise<void>;
  /** Carried spend of a deleted demo workspace on the UTC day `day`. */
  readonly carry: (day: string, costUsd: number, unpriced: boolean) => Promise<void>;
}

/** The behaviour the memory and the PostgreSQL spend must share. */
export function describeDemoSpendConformance(label: string, make: () => Promise<SpendRig>) {
  describe(`DemoSpend: ${label}`, () => {
    it('is zero and priced on a day with no spend', async () => {
      const { spend } = await make();
      expect(await spend.spentOn(DAY)).toEqual({ costUsd: 0, unpricedUsage: false });
    });

    it('sums the live demo usage of the UTC day, midnight inclusive and the next midnight not', async () => {
      const rig = await make();
      await rig.addLive(new Date(DAY.getTime() - 1), 100);
      await rig.addLive(DAY, 1.5);
      await rig.addLive(NOON, 2.25);
      await rig.addLive(new Date(DAY.getTime() + 24 * 60 * 60 * 1000), 100);
      const spent = await rig.spend.spentOn(DAY);
      expect(spent.costUsd).toBeCloseTo(3.75, 6);
      expect(spent.unpricedUsage).toBe(false);
    });

    it('adds the spend carried from a deleted workspace, for that day only', async () => {
      const rig = await make();
      await rig.addLive(NOON, 1);
      await rig.carry('2026-11-16', 2, false);
      await rig.carry('2026-11-15', 50, false);
      expect((await rig.spend.spentOn(DAY)).costUsd).toBeCloseTo(3, 6);
    });

    it('leaves a workspace that is not a demo workspace out', async () => {
      const rig = await make();
      await rig.addReal(NOON, 99);
      expect((await rig.spend.spentOn(DAY)).costUsd).toBe(0);
    });

    it('says unpriced when live usage or the carried day has no price', async () => {
      const live = await make();
      await live.addLiveUnpriced(NOON);
      expect((await live.spend.spentOn(DAY)).unpricedUsage).toBe(true);
      const carried = await make();
      await carried.carry('2026-11-16', 0, true);
      expect((await carried.spend.spentOn(DAY)).unpricedUsage).toBe(true);
    });
  });
}
