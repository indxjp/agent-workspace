import { utcDayStart } from '@agent-workspace/core/daily-cost';

import { utcDayEnd } from '../../core/rules';
import type { DemoDaySpend, DemoSpend } from '../../ports';

interface LiveUsage {
  readonly at: Date;
  readonly costUsd: number;
  readonly unpriced: boolean;
}

/** The memory {@link DemoSpend} for tests: live usage rows plus carried days, summed as the table does. */
export class MemoryDemoSpend implements DemoSpend {
  readonly #live: LiveUsage[] = [];
  readonly #carried = new Map<string, { costUsd: number; unpriced: boolean }>();

  /** A usage row of a live demo workspace. */
  public addLive(at: Date, costUsd: number, unpriced = false): void {
    this.#live.push({ at, costUsd, unpriced });
  }

  /** What a deleted demo workspace carried into `demo_daily_costs` for the UTC day `day` (`YYYY-MM-DD`). */
  public carry(day: string, costUsd: number, unpriced = false): void {
    const found = this.#carried.get(day);
    this.#carried.set(day, {
      costUsd: (found?.costUsd ?? 0) + costUsd,
      unpriced: (found?.unpriced ?? false) || unpriced,
    });
  }

  public spentOn(dayStart: Date): Promise<DemoDaySpend> {
    const start = utcDayStart(dayStart);
    const end = utcDayEnd(start);
    const live = this.#live.filter((row) => row.at >= start && row.at < end);
    const carried = this.#carried.get(start.toISOString().slice(0, 10));
    return Promise.resolve({
      costUsd: live.reduce((sum, row) => sum + row.costUsd, 0) + (carried?.costUsd ?? 0),
      unpricedUsage: live.some((row) => row.unpriced) || (carried?.unpriced ?? false),
    });
  }
}
