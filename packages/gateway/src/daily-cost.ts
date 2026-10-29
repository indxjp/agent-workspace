/**
 * The workspace's daily cost cap at model-call admission (issue #1851, slice 3b): a run whose
 * workspace has spent its `maxCostPerDayUsd` is refused at its next model call and ended with the
 * same `daily_cost_cap_reached` reason a run start meets.
 *
 * The cap rides in the signed run token (`dailyCostCapUsd`), so a run without the claim never reads
 * a spend. The rule itself (the UTC-day spend, the cache, the unpriced rule) is core's, the one web
 * applies at run start; this file adds only the refusal's wording and the run's end. Fail-closed: a
 * spend that cannot be read refuses the call `daily_cost_unavailable` and is not cached.
 *
 * What the run shows is the cap, the reset time and whether the refusal is for unpriced usage. The
 * spend is not shown: the gateway runs inside the sandbox's reach, and a model call must not be a
 * way to read a workspace's cost.
 */
import {
  createDailyCostRule,
  type DailyCostCapRefusal,
  type DailyUsage,
} from '@agent-workspace/core/daily-cost';

import type { AdmissionRefusal, GatewayAdmission } from './auth.js';

export interface DailyCostLedger {
  /** The cost settled in `[from, to)` for the workspace, and whether part of it is unpriced. */
  sumCostUsd(workspaceId: string, from: Date, to: Date): Promise<DailyUsage>;
  /** Move the run to `failed` with `error`; a run that is already terminal keeps what it has. */
  endRun(workspaceId: string, runId: string, error: string): Promise<void>;
}

/** What a failed read or run end tells `onError`: ids for the log's fields, never the response. */
export interface DailyCostErrorContext {
  readonly stage: 'read' | 'end-run';
  readonly workspaceId: string;
  readonly runId: string;
}

export interface DailyCostAdmissionOptions {
  readonly now: () => Date;
  /** How long a workspace's sum is reused; 60 s unless a test says otherwise. */
  readonly ttlMs?: number;
  /** Told of a failed spend read or run end; the response never carries the error. */
  readonly onError?: (error: unknown, context: DailyCostErrorContext) => void;
}

/** The reason a run shows. It names the cap and the reset time, not the spend. */
function visibleReason({ capUsd, resetsAt, unpricedUsage }: DailyCostCapRefusal): string {
  const why =
    unpricedUsage === true
      ? 'Some of the workspace model spend today has no price, so its daily cost cap cannot be measured'
      : 'The workspace has reached its daily model cost cap';
  return `${why}; the run was stopped at this model call. capUsd: ${String(capUsd)}, resetsAt: ${resetsAt}${unpricedUsage === true ? ', unpricedUsage: true' : ''}`;
}

function unavailable(): AdmissionRefusal {
  return {
    status: 503,
    code: 'daily_cost_unavailable',
    message:
      'The workspace daily model cost could not be checked, so the model call was refused. Try again shortly.',
  };
}

export function createDailyCostAdmission(
  ledger: DailyCostLedger,
  { now, ttlMs, onError }: DailyCostAdmissionOptions,
): GatewayAdmission {
  const rule = createDailyCostRule({
    sumCostUsd: (workspaceId, from, to) => ledger.sumCostUsd(workspaceId, from, to),
    now,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  return {
    async admit({ dailyCostCapUsd, workspaceId, runId }): Promise<AdmissionRefusal | null> {
      if (dailyCostCapUsd === undefined) return null;
      let refusal: DailyCostCapRefusal | null;
      try {
        refusal = await rule.refusal(workspaceId, dailyCostCapUsd);
      } catch (error) {
        onError?.(error, { stage: 'read', workspaceId, runId });
        return unavailable();
      }
      if (refusal === null) return null;
      const message = visibleReason(refusal);
      try {
        await ledger.endRun(workspaceId, runId, `daily_cost_cap_reached: ${message}`);
      } catch (error) {
        // An engine reads a 401/403 as a rejected API key. 403 is answered only once the run's end
        // is written; otherwise the run would end `model_credential_rejected`. 503 is retryable.
        onError?.(error, { stage: 'end-run', workspaceId, runId });
        return unavailable();
      }
      // 403, not 429: an SDK retries a 429 whatever its error type says, and this refusal holds
      // until the next UTC midnight.
      return { status: 403, code: 'daily_cost_cap_reached', message };
    },
  };
}
