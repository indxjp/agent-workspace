/**
 * The workspace's daily cost cap (`policy.maxCostPerDayUsd`, ADR-0102 SD6, issue #1851): the model
 * spend a workspace has run up in the current UTC day, and the refusal a run start meets once it
 * reaches the cap.
 *
 * The sum is read from the usage ledger (`run_usage_records`) that also feeds `runs.cost_usd`; cost
 * is never computed here. A response with no price is stored at 0, so a cap you cannot measure is
 * not met: once any of the day's runs has unmeasured usage, the cap refuses with `unpricedUsage`.
 *
 * Fail-closed: a read that throws is neither swallowed nor cached, so the start that asked fails
 * rather than going through.
 */

/** What a run start over the cap is refused with. */
interface DailyCostCapRefusal {
  readonly capUsd: number;
  readonly spentUsd: number;
  /** The next UTC midnight, as an ISO time: when the day's spend starts again. */
  readonly resetsAt: string;
  /** Set when the refusal is because some of the day's usage is unpriced, not because the cap is spent. */
  readonly unpricedUsage?: true;
}

/** The cap a run start consults; absent from the environment when the policy sets none. */
export interface DailyCostCap {
  /** `null` while the workspace is under the cap today. Rejects when the spend cannot be read. */
  readonly refusal: (workspaceId: string) => Promise<DailyCostCapRefusal | null>;
}

/** What the ledger answers for a window. */
interface DailyUsage {
  /** The cost as a decimal string. */
  readonly costUsd: string;
  /** Some run with usage in the window has an accounting state other than `complete`. */
  readonly unpricedUsage: boolean;
}

export interface DailyCostDependencies {
  readonly capUsd: number;
  /** The ledger cost settled in `[from, to)` for the workspace, and whether part of it is unpriced. */
  readonly sumCostUsd: (workspaceId: string, from: Date, to: Date) => Promise<DailyUsage>;
  readonly now: () => Date;
  /** How long a workspace's sum is reused; 60 s unless a test says otherwise. */
  readonly ttlMs?: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_TTL_MS = 60_000;

/** Midnight UTC of the day `at` falls in. */
export function utcDayStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS);
}

interface CachedSum {
  readonly dayStartMs: number;
  readonly readAtMs: number;
  readonly usage: Promise<{ readonly spentUsd: number; readonly unpricedUsage: boolean }>;
}

/** Build the daily cost cap for a policy that sets `maxCostPerDayUsd`. */
export function createDailyCost(dependencies: DailyCostDependencies): DailyCostCap & {
  /** The workspace's cost in the UTC day starting at `dayUtc`, as the cache last read it. */
  readonly dailyCostUsd: (workspaceId: string, dayUtc: Date) => Promise<number>;
  /** How many workspaces' sums the cache holds; expired and previous-day ones are dropped on write. */
  readonly cachedWorkspaceCount: () => number;
} {
  const { capUsd, sumCostUsd, now, ttlMs = DEFAULT_TTL_MS } = dependencies;
  // ponytail: per-instance 60 s cache can overshoot the cap by up to one minute of spend per web
  // instance; move to a counter table if that matters.
  const cache = new Map<string, CachedSum>();

  const read = (workspaceId: string, dayUtc: Date): CachedSum['usage'] => {
    const dayStartMs = dayUtc.getTime();
    const nowMs = now().getTime();
    const cached = cache.get(workspaceId);
    if (cached?.dayStartMs === dayStartMs && nowMs - cached.readAtMs < ttlMs) return cached.usage;
    // Drop what can no longer be served (an expired read, or one for a previous day), so the map
    // holds only the workspaces read within the last `ttlMs`.
    for (const [key, entry] of cache) {
      if (entry.dayStartMs !== dayStartMs || nowMs - entry.readAtMs >= ttlMs) cache.delete(key);
    }
    const usage = sumCostUsd(workspaceId, dayUtc, new Date(dayStartMs + DAY_MS)).then((window) => ({
      spentUsd: Number(window.costUsd),
      unpricedUsage: window.unpricedUsage,
    }));
    const entry: CachedSum = { dayStartMs, readAtMs: nowMs, usage };
    cache.set(workspaceId, entry);
    // A failed read must not be served again as the answer for the rest of the minute.
    usage.catch(() => {
      if (cache.get(workspaceId) === entry) cache.delete(workspaceId);
    });
    return usage;
  };

  const dailyCostUsd = async (workspaceId: string, dayUtc: Date): Promise<number> =>
    (await read(workspaceId, dayUtc)).spentUsd;

  return {
    dailyCostUsd,
    cachedWorkspaceCount: () => cache.size,
    async refusal(workspaceId) {
      const dayUtc = utcDayStart(now());
      const { spentUsd, unpricedUsage } = await read(workspaceId, dayUtc);
      const resetsAt = new Date(dayUtc.getTime() + DAY_MS).toISOString();
      // A sum that is not a number compares false here, so it refuses (fail-closed).
      if (!(spentUsd < capUsd)) return { capUsd, spentUsd, resetsAt };
      // Under the cap, but some of the day's spend was stored as 0 because it had no price: the
      // sum is a floor, not a total, so the cap cannot be said to hold.
      return unpricedUsage ? { capUsd, spentUsd, resetsAt, unpricedUsage: true } : null;
    },
  };
}

/**
 * The run API environment's `dailyCostCap` member for a policy's `maxCostPerDayUsd`: nothing when
 * the policy sets no cap, so with none no spend is ever read.
 */
export function dailyCostCapEnvironment(
  capUsd: number | undefined,
  dependencies: Omit<DailyCostDependencies, 'capUsd'>,
): { readonly dailyCostCap?: DailyCostCap } {
  return capUsd === undefined ? {} : { dailyCostCap: createDailyCost({ ...dependencies, capUsd }) };
}
