/**
 * A run's spend ceiling at model-call admission (ADR-0162): a run whose `cost_usd` has reached its
 * `spend_ceiling_usd` is refused at its next model call and ended `failed` with
 * `run_budget_reached`. The rule is "no new model call once spent ≥ ceiling": a call that starts
 * below the ceiling is forwarded and settled in full, so the overshoot is bounded by the responses
 * already in flight when the ceiling is crossed.
 *
 * The two decimals come from the run row the resolver already reads, so the check costs no query
 * of its own. They are compared as integer micro-dollars, never as floats. The run is ended through
 * the daily cost cap's end-run path (`DailyCostLedger.endRun`), and the refusal is that cap's too:
 * `403` once the end is written, `503` (retryable, the run left as it was) when it cannot be.
 *
 * A run on a model the catalogue does not price settles at cost 0, so its ceiling is never reached
 * (ADR-0162 decision 6): the run view says so; refusing would make such a run unrunnable.
 */
import { RUN_BUDGET_REACHED } from '@indx-workspace/contracts/runs';

import type { AdmissionRefusal, GatewayAdmission, RunSpend } from './auth.js';
import type { DailyCostLedger } from './daily-cost.js';

/** What a failed run end tells `onError`: ids for the log's fields, never the response. */
interface RunCeilingErrorContext {
  readonly stage: 'read' | 'end-run';
  readonly workspaceId: string;
  readonly runId: string;
}

export interface RunCeilingAdmissionOptions {
  /** Told of an unreadable spend or a failed run end; the response never carries the error. */
  readonly onError?: (error: unknown, context: RunCeilingErrorContext) => void;
}

const DECIMAL = /^(\d+)(?:\.(\d{1,6}))?$/u;

/** A non-negative decimal of at most six places as integer micro-dollars; throws on anything else. */
export function usdMicros(decimal: string): bigint {
  const match = DECIMAL.exec(decimal);
  if (match === null) throw new Error('a run spend is not a decimal of at most six places');
  const [, whole = '0', fraction = ''] = match;
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

/** Whether the run has spent its ceiling: a ceiling is set and `costUsd ≥ ceilingUsd`. */
export function spendCeilingReached(spend: RunSpend): boolean {
  return spend.ceilingUsd !== null && usdMicros(spend.costUsd) >= usdMicros(spend.ceilingUsd);
}

/** The ceiling as the run's error names it: the stored decimal without trailing zeros. */
function shownUsd(decimal: string): string {
  return decimal.includes('.') ? decimal.replace(/\.?0+$/u, '') : decimal;
}

/** The message after `run_budget_reached: ` on the run, and in the refusal's body. */
export function runBudgetReachedMessage(ceilingUsd: string): string {
  return `The run stopped at its spend ceiling of ${shownUsd(ceilingUsd)} USD.`;
}

function unavailable(): AdmissionRefusal {
  return {
    status: 503,
    code: 'run_budget_unavailable',
    message:
      'The run spend ceiling could not be applied, so the model call was refused. Try again.',
  };
}

export function createRunCeilingAdmission(
  ledger: Pick<DailyCostLedger, 'endRun'>,
  { onError }: RunCeilingAdmissionOptions = {},
): GatewayAdmission {
  return {
    async admit({ workspaceId, runId }, spend): Promise<AdmissionRefusal | null> {
      if (spend === undefined || spend.ceilingUsd === null) return null;
      let reached: boolean;
      try {
        reached = spendCeilingReached(spend);
      } catch (error) {
        onError?.(error, { stage: 'read', workspaceId, runId });
        return unavailable();
      }
      if (!reached) return null;
      const message = runBudgetReachedMessage(spend.ceilingUsd);
      try {
        await ledger.endRun(workspaceId, runId, `${RUN_BUDGET_REACHED}: ${message}`);
      } catch (error) {
        // An engine reads a 401/403 as a rejected API key, so 403 is answered only once the run's
        // end is written; otherwise the run would end `model_credential_rejected`. 503 is retryable.
        onError?.(error, { stage: 'end-run', workspaceId, runId });
        return unavailable();
      }
      // 403, not 429: an SDK retries a 429 whatever its error type says, and a ceiling does not
      // lift by waiting (ADR-0162 decision 4).
      return { status: 403, code: RUN_BUDGET_REACHED, message };
    },
  };
}
